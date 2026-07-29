import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { isDepartment } from "./department";

/**
 * Read client for permission checks: the prisma singleton by default, or a
 * Prisma TransactionClient when a write command must re-verify object scope
 * inside its write transaction (TOCTOU guard).
 */
type DbLike = typeof prisma | Prisma.TransactionClient;

export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId },
  });
  return !!member;
}

export async function assertProjectMember(projectId: string, userId: string): Promise<void> {
  const isMember = await isProjectMember(projectId, userId);
  if (!isMember) {
    throw new Error("Forbidden: not a project member");
  }
}

export async function isProjectOwner(projectId: string, userId: string, db: DbLike = prisma): Promise<boolean> {
  const member = await db.projectMember.findFirst({
    where: { projectId, userId, role: "OWNER" },
  });
  return !!member;
}

export async function assertProjectOwner(projectId: string, userId: string): Promise<void> {
  const isOwner = await isProjectOwner(projectId, userId);
  if (!isOwner) {
    throw new Error("Forbidden: not project owner");
  }
}

export async function getUserProjectIds(userId: string, db: DbLike = prisma): Promise<string[]> {
  const memberships = await db.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  return memberships.map((m) => m.projectId);
}

export function isRepresentative(role?: string | null): boolean {
  return role === "REPRESENTATIVE";
}

/**
 * Fail-closed 部门解析（设计 §6.1）：非 ADMIN 必须有部门过滤。
 * 显式传入时仅接受合法部门值；未传入时从 DB 实时解析。
 * 用户不存在或 department 非法时返回 null，调用点据此返回 no-match / false，
 * 不再静默降级为 FIELD_SALES。
 */
async function resolveProjectScopeDepartment(
  db: DbLike,
  userId: string,
  department?: string,
): Promise<string | null> {
  if (department) {
    return isDepartment(department) ? department : null;
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { department: true },
  });
  if (!user) return null;
  return isDepartment(user.department) ? user.department : null;
}

export async function getRepresentativeProjectIds(userId: string, db: DbLike = prisma): Promise<string[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) return [];

  const rep = await db.representative.findUnique({
    where: { email: user.email },
    select: { id: true, name: true, archived: true, createdAt: true },
  });
  if (!rep || rep.archived) return [];

  // Primary: projects linked by representativeId
  const byId = await db.project.findMany({
    where: { representativeId: rep.id, deleted: false },
    select: { id: true },
  });

  // Fallback: projects where representativeId is null but representative text matches rep name.
  // Only apply when the rep name is unique among active representatives, and only for
  // projects created after this representative record exists, to reduce stale same-name reuse.
  const nameCount = await db.representative.count({
    where: { name: rep.name, archived: false },
  });
  if (nameCount > 1) return byId.map((p) => p.id);

  const alreadyCovered = new Set(byId.map((p) => p.id));
  const byName = await db.project.findMany({
    where: {
      representativeId: null,
      representative: rep.name,
      deleted: false,
      createdAt: { gte: rep.createdAt },
    },
    select: { id: true },
  });

  const all = [...byId, ...byName.filter((p) => !alreadyCovered.has(p.id))];
  return all.map((p) => p.id);
}

/**
 * Returns all project IDs the user can read.
 * - ADMIN: null (meaning all projects)
 * - Sales roles (REPRESENTATIVE, REGIONAL_MANAGER): projects linked via representativeId or representative name
 * - USER: projects where user is a ProjectMember + any representative-linked projects
 *
 * 部门隔离（设计 §6.3）：非 ADMIN 必须 AND departmentSnapshot。
 * 未显式传入 department 时从 DB 实时解析（fail-closed，与 getOrderScopeWhere 对齐）。
 */
export async function getReadableProjectIds(
  userId: string,
  role: string,
  db: DbLike = prisma,
  department?: string,
): Promise<string[] | null> {
  if (role === "ADMIN") return null;

  const resolvedDepartment = await resolveProjectScopeDepartment(db, userId, department);
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回空集，不静默降级为 FIELD_SALES。
  if (!resolvedDepartment) return [];

  const ids = new Set<string>();

  // Always check membership (covers OWNER, MEMBER, COLLABORATOR) — 带部门过滤
  const memberships = await db.projectMember.findMany({
    where: {
      userId,
      project: { departmentSnapshot: resolvedDepartment, deleted: false },
    },
    select: { projectId: true },
  });
  for (const m of memberships) ids.add(m.projectId);

  // Check representative linkage (for REPRESENTATIVE, REGIONAL_MANAGER, and USER who may also be reps)
  const repIds = await getRepresentativeProjectIds(userId, db);
  if (repIds.length > 0) {
    const deptRepProjects = await db.project.findMany({
      where: {
        id: { in: repIds },
        departmentSnapshot: resolvedDepartment,
        deleted: false,
      },
      select: { id: true },
    });
    for (const p of deptRepProjects) ids.add(p.id);
  }

  return [...ids];
}

/**
 * Check if a user can read a specific project.
 * - Deleted projects: only ADMIN or project OWNER（且同部门）
 * - Active projects: must be in readable project set (unless ADMIN)
 */
export async function canReadProject(
  projectId: string,
  userId: string,
  role: string,
  db: DbLike = prisma,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;

  const resolvedDepartment = await resolveProjectScopeDepartment(db, userId, department);
  // Fail-closed（设计 §6.1）：部门无法权威解析时拒绝读取，不静默降级为 FIELD_SALES。
  if (!resolvedDepartment) return false;

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, deleted: true, departmentSnapshot: true },
  });
  if (!project) return false;
  if (project.departmentSnapshot !== resolvedDepartment) return false;

  if (project.deleted) {
    return isProjectOwner(projectId, userId, db);
  }

  const ids = await getReadableProjectIds(userId, role, db, resolvedDepartment);
  if (ids === null) return true; // ADMIN (already handled above)
  return ids.includes(projectId);
}

/**
 * Check if a user can contribute to a project (create tickets, comments, replies).
 * Same as canReadProject but additionally requires the project not be deleted.
 * Pass a TransactionClient as `db` to re-verify live scope inside a write
 * transaction (TOCTOU guard: membership/linkage may change after a pre-tx gate).
 */
export async function canContributeProject(
  projectId: string,
  userId: string,
  role: string,
  db: DbLike = prisma,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, deleted: true },
  });
  if (!project || project.deleted) return false;

  return canReadProject(projectId, userId, role, db, department);
}

/**
 * Check if a user can manage a project (edit, delete, archive).
 * Only ADMIN or project OWNER can manage（OWNER 仍须同部门可读）。
 */
export async function canManageProject(
  projectId: string,
  userId: string,
  role: string,
  db: DbLike = prisma,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;
  const readable = await canReadProject(projectId, userId, role, db, department);
  if (!readable) return false;
  return isProjectOwner(projectId, userId, db);
}

/**
 * Check if a user can manage tickets (change status, delete).
 * ADMIN can manage any project's tickets.
 * USER / REGIONAL_MANAGER can manage tickets only when they are explicit ProjectMember.
 * Project OWNER (any role) can always manage tickets on their project.
 * Representative linkage only grants read/contribute, not ticket management.
 */
export async function canManageTicket(
  projectId: string,
  userId: string,
  role: string,
  department?: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;
  // 先过部门可读 scope，再要求成员/OWNER（防跨部门 ProjectMember 旁路）
  const readable = await canReadProject(projectId, userId, role, prisma, department);
  if (!readable) return false;
  if (role === "USER" || role === "REGIONAL_MANAGER") {
    return isProjectMember(projectId, userId);
  }
  return isProjectOwner(projectId, userId);
}

/**
 * Build a permissions object for API responses.
 */
export async function buildProjectPermissions(projectId: string, userId: string, role: string) {
  const [canRead, canContribute, canManage] = await Promise.all([
    canReadProject(projectId, userId, role),
    canContributeProject(projectId, userId, role),
    canManageProject(projectId, userId, role),
  ]);
  return {
    canRead,
    canContribute,
    canManage,
    canViewInvoices: canRead,
    canUploadFiles: canContribute && !isRepresentative(role),
  };
}

/**
 * Assert that a user can read full project context (including tickets, comments, timeline).
 * Rules aligned with project detail / timeline API:
 * - Project not found → throws "NOT_FOUND"
 * - Deleted project → only ADMIN or project OWNER allowed, otherwise "FORBIDDEN"
 * - Active project → must be a project member, otherwise "FORBIDDEN"
 * - REPRESENTATIVE should NOT use this — they get a separate, scoped view.
 *   The function enforces that restriction directly to avoid route-level drift.
 */
export async function assertProjectContextReadable(
  projectId: string,
  userId: string,
  role: string,
  department?: string,
) {
  if (role === "REPRESENTATIVE") {
    throw new Error("FORBIDDEN");
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, deleted: true, departmentSnapshot: true },
  });

  if (!project) {
    throw new Error("NOT_FOUND");
  }

  if (role !== "ADMIN") {
    const resolvedDepartment = await resolveProjectScopeDepartment(prisma, userId, department);
    // Fail-closed（设计 §6.1）：部门无法权威解析时映射为 NOT_FOUND（防存在性泄露），
    // 不静默降级为 FIELD_SALES。
    if (!resolvedDepartment || project.departmentSnapshot !== resolvedDepartment) {
      throw new Error("NOT_FOUND");
    }
  }

  if (project.deleted) {
    const owner = await isProjectOwner(projectId, userId);
    if (!owner && role !== "ADMIN") {
      throw new Error("FORBIDDEN");
    }
    return project;
  }

  if (role !== "ADMIN") {
    await assertProjectMember(projectId, userId);
  }
  return project;
}
