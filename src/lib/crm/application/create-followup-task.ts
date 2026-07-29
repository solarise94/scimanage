/**
 * Canonical actor-aware CRM follow-up task command (T5.2).
 *
 * Shared by Web `POST /api/crm/follow-ups` and Agent `crm.create_followup_task`.
 * Unifies task type, owner rules, nextFollowUpAt, FOLLOW_UP_CREATED lifecycle,
 * and assignee Notification.
 */
import { prisma } from "@/lib/prisma";
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
  getRegionalManagerUserIds,
  isRegionalManagerRole,
  isRepresentativeRole,
} from "@/lib/crm/permissions";
import { transitionCrmStage } from "@/lib/crm/lifecycle";
import { CRM_FOLLOW_UP_TASK_TYPES, type CrmFollowUpTaskType } from "@/lib/crm/constants";

const FOLLOW_UP_TASK_INCLUDE = {
  ownerUser: { select: { id: true, name: true } },
  createdByUser: { select: { id: true, name: true } },
  profile: {
    select: {
      id: true,
      name: true,
      customerCode: true,
    },
  },
} as const;

export type CreateFollowUpTaskInput = {
  profileId: string;
  title: string;
  dueAt: string | Date;
  taskType?: string | null;
  ownerUserId?: string | null;
};

export type CreateFollowUpTaskRecord = Awaited<
  ReturnType<typeof prisma.crmFollowUpTask.create>
> & {
  ownerUser: { id: string; name: string | null };
  createdByUser: { id: string; name: string | null };
  profile: { id: string; name: string | null; customerCode: string | null };
};

export type CreateFollowUpTaskResult = {
  task: CreateFollowUpTaskRecord;
  customerName: string;
  finalOwnerUserId: string;
  notificationSent: boolean;
  /** Agent adapter maps these to modelText hints. */
  notifications: string[];
};

export function normalizeFollowUpTaskType(
  value: string | null | undefined,
): CrmFollowUpTaskType {
  if (value && CRM_FOLLOW_UP_TASK_TYPES.includes(value as CrmFollowUpTaskType)) {
    return value as CrmFollowUpTaskType;
  }
  return "CONTACT";
}

export function parseFollowUpDueAt(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError("dueAt 必须是有效日期");
  }
  return date;
}

async function assertProfileAccessForFollowUp(
  actor: BusinessActor,
  profileId: string,
): Promise<void> {
  if (!isRepresentativeRole(actor.role) && !isRegionalManagerRole(actor.role)) {
    return;
  }
  try {
    await assertCrmProfileAccess(profileId, actor.userId, actor.role);
  } catch (error) {
    if (error instanceof CrmAccessNotFoundError) {
      throw new NotFoundError("Profile not found");
    }
    if (error instanceof CrmAccessForbiddenError) {
      throw new ForbiddenError();
    }
    if (error instanceof CrmAccessError) {
      throw new ForbiddenError();
    }
    throw error;
  }
}

/**
 * Resolve follow-up owner with representative self-assign and RM rep-scope rules.
 */
export async function resolveFollowUpOwnerForActor(
  actor: BusinessActor,
  ownerUserId: string | null | undefined,
): Promise<string> {
  if (isRepresentativeRole(actor.role)) {
    return actor.userId;
  }

  const requestedOwner = ownerUserId?.trim();
  const finalOwner = requestedOwner || actor.userId;

  if (isRegionalManagerRole(actor.role) && requestedOwner) {
    const repUserIds = await getRegionalManagerUserIds(actor.userId);
    const allowedIds =
      repUserIds && repUserIds.length > 0 ? [actor.userId, ...repUserIds] : [actor.userId];
    if (!allowedIds.includes(requestedOwner)) {
      throw new ForbiddenError();
    }
  }

  return finalOwner;
}

export async function createFollowUpTaskForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CreateFollowUpTaskInput,
): Promise<CreateFollowUpTaskResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  }

  const profileId = input.profileId?.trim();
  const title = input.title?.trim();
  if (!profileId || !title || input.dueAt == null || input.dueAt === "") {
    throw new ValidationError("profileId, title, and dueAt are required");
  }

  const dueAt = parseFollowUpDueAt(input.dueAt);
  const resolvedTaskType = normalizeFollowUpTaskType(input.taskType);

  await assertProfileAccessForFollowUp(actor, profileId);

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true, name: true, ownerUserId: true, assignmentStatus: true },
  });
  if (!profile) {
    throw new NotFoundError("Profile not found");
  }

  const finalOwner = await resolveFollowUpOwnerForActor(actor, input.ownerUserId);
  const needNotify = finalOwner !== actor.userId;
  const customerName = profile.name ?? "未命名客户";
  const dueDateStr = dueAt.toLocaleDateString("zh-CN");

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.crmFollowUpTask.create({
      data: {
        profileId,
        ownerUserId: finalOwner,
        title,
        dueAt,
        taskType: resolvedTaskType,
        createdByUserId: actor.userId,
      },
      include: FOLLOW_UP_TASK_INCLUDE,
    });

    // Lifecycle transition is atomic with task creation (visit-checkin.ts
    // precedent): transitionCrmStage takes a TransactionClient and performs no
    // I/O, so a transition failure now rolls the task back instead of leaving
    // a task with a missing FOLLOW_UP_CREATED stage history.
    await transitionCrmStage(
      profileId,
      {
        type: "FOLLOW_UP_CREATED",
        taskId: created.id,
        dueAt,
      },
      tx,
    );

    // Lifecycle aggregate only counts communication-sourced tasks; recompute
    // from ALL open follow-ups so manual tasks stay visible. This final write
    // supersedes the stage engine's communication-only nextFollowUpAt.
    const earliestOpen = await tx.crmFollowUpTask.findFirst({
      where: { profileId, status: "OPEN" },
      orderBy: { dueAt: "asc" },
      select: { dueAt: true },
    });
    await tx.crmCustomerProfile.update({
      where: { id: profileId },
      data: { nextFollowUpAt: earliestOpen?.dueAt ?? null },
    });

    return created;
  });

  let notificationSent = false;
  if (needNotify) {
    try {
      await prisma.notification.create({
        data: {
          userId: finalOwner,
          title: "有新的跟进任务",
          content: `客户 ${customerName} 有新的跟进任务: ${title}，截止 ${dueDateStr}`,
          type: "CRM_FOLLOW_UP",
          link: `/crm/customers/${profileId}`,
        },
      });
      notificationSent = true;
    } catch {
      notificationSent = false;
    }
  }

  const notifications: string[] = [];
  if (needNotify) {
    notifications.push(
      notificationSent ? `已通知用户 ${finalOwner}` : `通知用户 ${finalOwner} 失败`,
    );
  }

  return {
    task,
    customerName,
    finalOwnerUserId: finalOwner,
    notificationSent,
    notifications,
  };
}
