/**
 * T3.2 — canonical create-project command.
 *
 * Single formal write entry for Web `POST /api/projects` and Agent `projects.create`.
 * Mirrors the page side effects: CRM context (or optional no-profile rep),
 * projectNo collision retry, ProjectMember(OWNER), ActivityLog, budgetAmountSource,
 * budgetCost ledger sync, techSupport default, and post-commit representative notify.
 *
 * Agent must not pass organization/representativeId to bypass profile derivation;
 * without profileId, only the same named Web fields (client/organization/representativeId)
 * may set denormalized snapshots.
 */
import type { Prisma, Project } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/application/errors";
import { resolveCustomerBusinessContext } from "@/lib/business/customer-context";
import { generateProjectNo } from "@/lib/project-number";
import { normalizeProjectType } from "@/lib/project-type";
import { yuanToCents } from "@/lib/finance/money";
import { resolveTechSupportDefault } from "@/lib/tech-support";
import { isRepresentative } from "@/lib/permissions";
import {
  isDepartment,
  type Department,
} from "@/lib/department";

export type CreateProjectInput = {
  name: string;
  description?: string | null;
  /** Optional CRM profile — drives client/org/rep when set. */
  profileId?: string | null;
  /**
   * Only used when profileId is absent (Web no-customer policy).
   * Ignored when profileId is present.
   */
  representativeId?: string | null;
  organization?: string | null;
  client?: string | null;
  projectNo?: string | null;
  status?: string | null;
  progress?: number | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  projectType?: string | null;
  projectContent?: string | null;
  quantity?: number | string | null;
  procurementSource?: string | null;
  brand?: string | null;
  techSupport?: string | null;
  /** Yuan (page/Agent); converted to cents internally. */
  budgetAmount?: number | string | null;
  /** Yuan; converted to cents; syncs FinanceCost when > 0. */
  budgetCost?: number | string | null;
  /**
   * ADMIN 跨部门创建时的显式部门（须经 isDepartment 校验）。
   * 非 ADMIN 忽略；未提供时 ADMIN 也取自身 DB 部门。
   */
  requestedDepartment?: string | null;
};

export type CreateProjectResult = {
  project: Project;
  invocation: InvocationContext;
};

export type CreateProjectProposalPreview = {
  customerName: string | null;
};

/** Light read for Agent proposal card — no formal writes. */
export async function previewCreateProjectForActor(
  actor: BusinessActor,
  input: Pick<CreateProjectInput, "profileId">,
): Promise<CreateProjectProposalPreview> {
  assertCanCreateProject(actor);
  const profileId =
    typeof input.profileId === "string" && input.profileId.trim()
      ? input.profileId.trim()
      : null;
  if (!profileId) return { customerName: null };
  const ctx = await resolveCustomerBusinessContext(profileId);
  if (!ctx.profileId || !ctx.clientName) {
    throw new ValidationError("指定的客户不存在");
  }
  return { customerName: ctx.clientName };
}

function assertCanCreateProject(actor: BusinessActor): void {
  if (isRepresentative(actor.role)) {
    throw new ForbiddenError("Forbidden");
  }
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("Forbidden");
  }
}

function isProjectNoUniqueConflict(err: unknown): boolean {
  const isP2002 =
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002";
  if (!isP2002) return false;
  const target = Array.isArray((err as { meta?: { target?: unknown } }).meta?.target)
    ? ((err as { meta?: { target?: string[] } }).meta?.target || [])
    : [];
  return target.includes("projectNo");
}

function parseOptionalYuanToCents(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ValidationError("金额必须是有效数字");
  }
  return yuanToCents(n);
}

/**
 * 敏感写入：事务内读取 User.department，不信任 session actor 快照（设计 §7.2）。
 * ADMIN 可经 requestedDepartment 显式指定（须 isDepartment）。
 */
async function resolveCreateProjectDepartment(
  tx: Prisma.TransactionClient,
  actor: BusinessActor,
  requestedDepartment?: string | null,
): Promise<Department> {
  const user = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { department: true },
  });
  // Fail-closed（设计 §6.1）：用户不存在或 department 非法时拒绝创建项目，
  // 不静默降级为 FIELD_SALES（会产生错误部门项目）。
  if (!user || !isDepartment(user.department)) {
    throw new ForbiddenError("无法权威解析操作者部门");
  }
  const actorDept: Department = user.department;

  if (actor.role === "ADMIN" && requestedDepartment) {
    if (!isDepartment(requestedDepartment)) {
      throw new ValidationError(`非法部门值: ${requestedDepartment}`);
    }
    return requestedDepartment;
  }
  return actorDept;
}

async function notifyAssignedRepresentative(project: Project): Promise<void> {
  if (!project.representativeId) return;
  const rep = await prisma.representative.findUnique({
    where: { id: project.representativeId, archived: false },
  });
  if (!rep?.email) return;
  const { notifyRepresentative } = await import("@/lib/representative-link");
  const result = await notifyRepresentative(rep.email, `/projects/${project.id}`, [
    {
      subject: `【SciManage】您已被指定为项目代表: ${project.name}`,
      text: `您好 ${rep.name || ""}，\n\n您已被指定为项目 "${project.name}" 的代表。\n\n---\nSciManage`,
      html: `<p>您好 <strong>${rep.name || ""}</strong>，</p>
<p>您已被指定为项目 <strong>"${project.name}"</strong> 的代表。</p>
<hr />
<p style="color:#999;font-size:12px;">SciManage</p>`,
    },
  ]);
  if (!result.ok) {
    console.error("Failed to notify representative for new project");
  }
}

/**
 * Create a project with all page-parity side effects.
 */
export async function createProjectForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  assertCanCreateProject(actor);

  const name = input.name?.toString().trim();
  if (!name) {
    throw new ValidationError("项目名称不能为空");
  }

  const profileId =
    typeof input.profileId === "string" && input.profileId.trim()
      ? input.profileId.trim()
      : null;

  const budgetAmountCents = parseOptionalYuanToCents(input.budgetAmount);
  const budgetCostCents = parseOptionalYuanToCents(input.budgetCost);
  const autoProjectNo = !(typeof input.projectNo === "string" && input.projectNo.trim());
  const manualProjectNo = autoProjectNo ? null : String(input.projectNo).trim();

  const progressRaw = input.progress;
  const progress = Number.isFinite(Number(progressRaw))
    ? Math.max(0, Math.min(100, Number(progressRaw)))
    : 0;

  const quantity =
    input.quantity != null && input.quantity !== ""
      ? Number(input.quantity)
      : null;

  const { syncProjectBudgetCost } = await import("@/lib/finance/ledger");

  let project: Project | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      project = await prisma.$transaction(async (tx) => {
        // Authoritative CRM context must be resolved inside the transaction:
        // a profile archived between request and commit must not spawn a
        // profile-bound project, and denormalized snapshots (organization /
        // client / representative) must come from a fresh in-tx read — never
        // from payload fields when profile-bound (mirrors
        // create-order-with-project.ts in-tx resolution).
        let custClient: string | null = null;
        let custOrg: string | null = null;
        let resolvedRepId: string | null = null;
        let resolvedRepName: string | null = null;
        let resolvedProfileId: string | null = null;

        if (profileId) {
          const ctx = await resolveCustomerBusinessContext(profileId, tx);
          if (!ctx.clientName || !ctx.profileId) {
            throw new ValidationError("指定的客户不存在");
          }
          custClient = ctx.clientName;
          custOrg = ctx.organizationName;
          resolvedRepId = ctx.representativeId;
          resolvedRepName = ctx.representativeName;
          resolvedProfileId = ctx.profileId;
        } else if (input.representativeId) {
          const repId = String(input.representativeId).trim();
          const rep = await tx.representative.findUnique({ where: { id: repId } });
          if (!rep) {
            throw new ValidationError("指定的代表不存在");
          }
          resolvedRepId = rep.id;
          resolvedRepName = rep.name;
        }

        const finalProjectNo = autoProjectNo
          ? await generateProjectNo(tx)
          : manualProjectNo;

        // 部门归属快照（设计 §4.2 / §7.2）：事务内读 DB，不信任 actor.department 快照
        const departmentSnapshot = await resolveCreateProjectDepartment(
          tx,
          actor,
          input.requestedDepartment,
        );

        const created = await tx.project.create({
          data: {
            projectNo: finalProjectNo,
            name,
            description: input.description ?? null,
            organization: resolvedProfileId
              ? (custOrg ?? null)
              : input.organization || null,
            client: resolvedProfileId
              ? (custClient || null)
              : input.client || null,
            representative: resolvedRepName,
            representativeId: resolvedRepId,
            profileId: resolvedProfileId,
            status: input.status?.toString().trim() || "NOT_STARTED",
            progress,
            startDate: input.startDate ? new Date(input.startDate) : new Date(),
            endDate: input.endDate ? new Date(input.endDate) : null,
            projectType: normalizeProjectType(input.projectType as string) || null,
            projectContent: input.projectContent || null,
            quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
            procurementSource: input.procurementSource || null,
            brand: input.brand || null,
            techSupport: resolveTechSupportDefault(input.techSupport, {
              role: actor.role,
              name: actor.name,
              email: actor.email,
            }),
            // Phase E：Agent channel 创建项目时同事务绑定为 technicalOwner（与 ProjectMember
            // OWNER 并存——OWNER 是项目管理权，technicalOwnerUserId 是 Agent 写授权源）。
            technicalOwnerUserId: invocation.channel === "agent" ? actor.userId : null,
            departmentSnapshot,
            budgetAmount: budgetAmountCents,
            budgetAmountSource: budgetAmountCents != null ? "MANUAL" : null,
            budgetCost: budgetCostCents,
            members: {
              create: {
                userId: actor.userId,
                role: "OWNER",
              },
            },
          },
        });

        if (budgetCostCents) {
          await syncProjectBudgetCost(created.id, budgetCostCents, actor.userId, tx);
        }

        await tx.activityLog.create({
          data: {
            type: "PROJECT_CREATED",
            content: `创建了项目 "${name}"`,
            projectId: created.id,
            userId: actor.userId,
          },
        });

        return created;
      });
      break;
    } catch (err) {
      if (isProjectNoUniqueConflict(err) && autoProjectNo && attempt < 2) {
        continue;
      }
      if (isProjectNoUniqueConflict(err)) {
        throw new ConflictError("项目号已被使用");
      }
      throw err;
    }
  }

  if (!project) {
    throw new ConflictError("项目号已被使用，请重试");
  }

  await notifyAssignedRepresentative(project).catch((err) => {
    console.error("[projects.create] representative notify failed:", err);
  });

  return { project, invocation };
}
