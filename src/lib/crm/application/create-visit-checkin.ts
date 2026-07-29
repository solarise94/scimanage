/**
 * Canonical actor-aware CRM visit checkin command (T5.3).
 *
 * Shared by Agent `crm.create_visit_checkin` and Web checkin complete path
 * (`PATCH /api/crm/profiles/[id]/checkins/[checkinId]` with status COMPLETED).
 */
import type { CrmInteraction, CrmVisitCheckin } from "@prisma/client";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { assertCrmRepSelfServiceAccess } from "@/lib/crm/application/crm-agent-access";
import {
  assertCrmProfileAccess,
  CrmAccessError,
  CrmAccessForbiddenError,
  CrmAccessNotFoundError,
  isRegionalManagerRole,
  isRepresentativeRole,
} from "@/lib/crm/permissions";
import { reverseGeocode } from "@/lib/crm/geocode";
import {
  completeVisitCheckin,
  createAndCompleteCheckin,
} from "@/lib/crm/services/visit-checkin";

export type CreateVisitCheckinInput = {
  profileId: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
  addressNote?: string | null;
  checkinId?: string | null;
};

export type CompleteVisitCheckinInput = {
  profileId: string;
  checkinId: string;
  voiceUrl?: string | null;
};

export type VisitCheckinWriteResult = {
  checkin: CrmVisitCheckin;
  interaction: CrmInteraction | null;
  customerName: string;
};

async function assertProfileAccessForVisit(
  actor: BusinessActor,
  profileId: string,
): Promise<{ customerName: string }> {
  if (!isRepresentativeRole(actor.role) && !isRegionalManagerRole(actor.role)) {
    const { prisma } = await import("@/lib/prisma");
    const profile = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileId },
      select: { id: true, name: true },
    });
    if (!profile) {
      throw new NotFoundError("Profile not found");
    }
    return { customerName: profile.name ?? "未命名客户" };
  }

  try {
    await assertCrmProfileAccess(profileId, actor.userId, actor.role);
  } catch (error) {
    if (error instanceof CrmAccessNotFoundError) {
      throw new NotFoundError("Profile not found");
    }
    if (error instanceof CrmAccessForbiddenError || error instanceof CrmAccessError) {
      throw new ForbiddenError();
    }
    throw error;
  }

  const { prisma } = await import("@/lib/prisma");
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true, name: true },
  });
  if (!profile) {
    throw new NotFoundError("Profile not found");
  }
  return { customerName: profile.name ?? "未命名客户" };
}

function mapVisitCheckinServiceError(error: unknown): never {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg === "Checkin not found") {
    throw new NotFoundError("Checkin not found");
  }
  if (msg === "FORBIDDEN") {
    throw new ForbiddenError();
  }
  if (msg.includes("完成签到需要")) {
    throw new ValidationError(msg);
  }
  throw error instanceof Error ? error : new Error(msg);
}

async function resolveAddressSnapshot(
  lat: number,
  lng: number,
  addressNote?: string | null,
): Promise<{ addressSnapshot: string | null; mapProvider: string | null }> {
  let addressSnapshot: string | null = null;
  let mapProvider: string | null = null;

  const geo = await reverseGeocode(lat, lng);
  if (geo.result) {
    addressSnapshot = geo.result.address;
    mapProvider = "amap";
  }

  if (addressNote) {
    addressSnapshot = addressSnapshot
      ? `${addressSnapshot}（备注：${addressNote}）`
      : `备注：${addressNote}`;
  }

  return { addressSnapshot, mapProvider };
}

export async function createVisitCheckinForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CreateVisitCheckinInput,
): Promise<VisitCheckinWriteResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  }

  const profileId = input.profileId?.trim();
  if (!profileId) {
    throw new ValidationError("profileId is required");
  }
  if (input.lat == null || input.lng == null) {
    throw new ValidationError("lat and lng are required");
  }

  const { customerName } = await assertProfileAccessForVisit(actor, profileId);

  try {
    if (input.checkinId) {
      // P0-4：消费 prepare_visit_checkin 在服务端落下的 DRAFT intent。
      // prepare 时 DRAFT 只有 profileId+userId（GPS 为空）；此处把浏览器注入的 GPS +
      // 反向地理编码写回 DRAFT，再走 completeVisitCheckin 完成 DRAFT→COMPLETED。
      // completeVisitCheckin 内部用 updateMany({where:{id,status:DRAFT,...}}) 原子认领，
      // 防并发完成；profileId/userId 校验由 expected* 参数承担。
      const { addressSnapshot, mapProvider } = await resolveAddressSnapshot(
        input.lat,
        input.lng,
        input.addressNote,
      );
      const { prisma } = await import("@/lib/prisma");
      // 仅当仍是 DRAFT 时把 GPS 写回（一次性消费 intent）。
      const written = await prisma.crmVisitCheckin.updateMany({
        where: {
          id: input.checkinId,
          status: "DRAFT",
          profileId,
          userId: actor.userId,
        },
        data: {
          lat: input.lat,
          lng: input.lng,
          accuracy: input.accuracy ?? null,
          addressSnapshot,
          mapProvider,
        },
      });
      if (written.count === 0) {
        // 行已被消费/不属于该 actor；交由 completeVisitCheckin 的对象级校验决定（404/FORBIDDEN）。
      }
      const result = await completeVisitCheckin({
        checkinId: input.checkinId,
        expectedProfileId: profileId,
        expectedUserId: actor.userId,
        allowAdminOverride: actor.role === "ADMIN",
      });
      return {
        checkin: result.checkin,
        interaction: result.interaction,
        customerName,
      };
    }

    const { addressSnapshot, mapProvider } = await resolveAddressSnapshot(
      input.lat,
      input.lng,
      input.addressNote,
    );

    const result = await createAndCompleteCheckin({
      profileId,
      userId: actor.userId,
      lat: input.lat,
      lng: input.lng,
      accuracy: input.accuracy,
      addressSnapshot,
      mapProvider,
    });

    return {
      checkin: result.checkin,
      interaction: result.interaction,
      customerName,
    };
  } catch (error) {
    mapVisitCheckinServiceError(error);
  }
}

export async function completeVisitCheckinForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CompleteVisitCheckinInput,
): Promise<VisitCheckinWriteResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  }

  const profileId = input.profileId?.trim();
  const checkinId = input.checkinId?.trim();
  if (!profileId || !checkinId) {
    throw new ValidationError("profileId and checkinId are required");
  }

  const { customerName } = await assertProfileAccessForVisit(actor, profileId);

  try {
    const result = await completeVisitCheckin({
      checkinId,
      voiceUrl: input.voiceUrl ?? undefined,
      expectedProfileId: profileId,
      expectedUserId: actor.userId,
      allowAdminOverride: actor.role === "ADMIN",
    });
    return {
      checkin: result.checkin,
      interaction: result.interaction,
      customerName,
    };
  } catch (error) {
    mapVisitCheckinServiceError(error);
  }
}
