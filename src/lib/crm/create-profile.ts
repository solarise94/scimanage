import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateCustomerCode } from "@/lib/customer-code";
import { resolveEffectiveRepresentativeForOrg } from "@/lib/crm/customer-effective-representative";
import { toPinyinToneless } from "@/lib/crm/pinyin";
import { resolveSystemRepresentative } from "@/lib/crm/system-representative";
import {
  syncProfileRepresentativeLinks,
  syncProfileRepresentativeLinksFromOwner,
} from "@/lib/crm/customer-representative-sync";
import type { BusinessActor } from "@/lib/application/actor";
import {
  ApplicationError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/application/errors";
import { DEPARTMENTS, getActorDepartment, isDepartment, type Department } from "@/lib/department";
import { setProfilePoolShareInTx } from "@/lib/crm/profile-pool-share";

type DbLike = typeof prisma | Prisma.TransactionClient;

/**
 * Phase D（docs/customer-legacy-field-remediation-plan-2026-07-15.md）：Profile-only
 * 创建入口。溯源标签，写入 tagsJson，标记这条 Profile 是通过哪条业务路径产生的
 * （不再要求先建 Customer 锚点）。
 */
export type CreateCrmCustomerProfileSourceHint =
  | "MANUAL"
  | "ORDER_IMPORT"
  | "APPLICATION_REVIEW"
  | "BATCH_IMPORT";

export type CreateCrmCustomerProfileAssignmentStatus =
  | "UNASSIGNED"
  | "ASSIGNED"
  | "RECALL_CANDIDATE"
  | "RECALLED";

/**
 * `createCrmCustomerProfile` 的输入契约。覆盖三类正式创建路径当前使用的字段：
 * 手动建客户（`/api/customers` POST）、订单导入建客户（`import-masterdata.ts` /
 * 导入会话 commit route）、客户申请审批建客户（`customer-application-review.ts`）。
 */
export interface CreateCrmCustomerProfileInput {
  /** 客户姓名，必填非空。 */
  name: string;
  /** 客户编码；不传则自动生成 KH-000001 格式。 */
  customerCode?: string | null;
  /**
   * 显式指定 ownerUserId 时优先级最高，跳过 org/site binding 解析。
   * 未提供时按 organizationId/organizationSiteId 解析 effective 代表，
   * 解析不到再走本部兜底，最终兜底任意 ADMIN。
   */
  ownerUserId?: string | null;
  /** 不传则按 effective 代表解析来源推导（SITE/ORG binding → ASSIGNED，否则 UNASSIGNED）。 */
  assignmentStatus?: CreateCrmCustomerProfileAssignmentStatus;
  stage?: string;
  importance?: string;

  // ── 机构 ──
  organizationId?: string | null;
  organization?: string | null;
  organizationSiteId?: string | null;
  organizationRawInput?: string | null;

  // ── 联系方式与身份 ──
  principal?: string | null;
  phone?: string | null;
  wechat?: string | null;
  email?: string | null;
  miniProgramId?: string | null;
  nameDisambiguator?: string | null;
  labOrGroup?: string | null;
  personCategory?: string | null;
  jobTitle?: string | null;

  // ── 地址 ──
  address?: string | null;
  addressNote?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;

  /** 溯源标签，写入 tagsJson（`{"source": "..."}`）。 */
  sourceHint?: CreateCrmCustomerProfileSourceHint;
}

export interface CreateCrmCustomerProfileResult {
  id: string;
}

async function findAnyAdminUserId(db: DbLike): Promise<string | null> {
  const admin = await db.user.findFirst({
    where: { role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return admin?.id ?? null;
}

/**
 * Profile-only 客户创建的统一入口（Phase D）。**不创建 Customer**——`profile.id`
 * 直接就是客户唯一 ID，`sourceCustomerId` 留空。
 *
 * Owner 解析链（无 customerId 可用，直接从入参 org 字段解析）：
 *   1. `input.ownerUserId` 显式指定 → 直接采用（assignmentStatus 默认 ASSIGNED）。
 *   2. 否则按 `organizationId`/`organizationSiteId` 走 SITE_BINDING > ORG_BINDING
 *      > SYSTEM_FALLBACK（本部代表）优先级解析（`resolveEffectiveRepresentativeForOrg`）。
 *   3. 仍未解析到 → 兜底任意 ADMIN（防御性，正常路径本部代表应已 seed）。
 *
 * 创建后调用 `syncProfileRepresentativeLinks` 对齐 Project/Order.representativeId
 * 缓存（新建 Profile 通常还没有关联的 Order/Project，此处主要是保证 ownerUserId
 * 缓存与解析结果一致，并为后续 profileId 关联的记录预留正确的代表快照）。
 */
export async function createCrmCustomerProfile(
  input: CreateCrmCustomerProfileInput,
  db: DbLike = prisma,
): Promise<CreateCrmCustomerProfileResult> {
  const name = input.name?.trim();
  if (!name) {
    throw new Error("createCrmCustomerProfile: name is required");
  }

  const customerCode = input.customerCode?.trim() || (await generateCustomerCode(db));

  const explicitOwnerUserId = input.ownerUserId?.trim() || null;
  let ownerUserId: string | null = explicitOwnerUserId;
  let assignmentStatus: CreateCrmCustomerProfileAssignmentStatus | null = input.assignmentStatus ?? null;

  if (!ownerUserId) {
    const effective = await resolveEffectiveRepresentativeForOrg(
      input.organizationId,
      input.organizationSiteId,
      db,
    );
    ownerUserId = effective.ownerUserId;
    if (!assignmentStatus) {
      assignmentStatus = effective.source === "SITE_BINDING" || effective.source === "ORG_BINDING"
        ? "ASSIGNED"
        : "UNASSIGNED";
    }
  }

  if (!ownerUserId) {
    // 防御性二次解析：正常路径本部代表应已 seed，resolveEffectiveRepresentativeForOrg
    // 内部已经尝试过 SYSTEM_FALLBACK；这里再显式兜底一次（缓存命中，近零成本）。
    const systemRep = await resolveSystemRepresentative(db);
    ownerUserId = systemRep?.ownerUserId ?? null;
  }

  if (!ownerUserId) {
    // 最终兜底：仅当本部系统代表尚未 seed / 已归档时才会走到这里。
    ownerUserId = await findAnyAdminUserId(db);
  }

  if (!ownerUserId) {
    throw new Error("createCrmCustomerProfile: cannot resolve ownerUserId");
  }

  if (!assignmentStatus) {
    assignmentStatus = "ASSIGNED";
  }

  const tagsJson = input.sourceHint ? JSON.stringify({ source: input.sourceHint }) : null;

  const profile = await db.crmCustomerProfile.create({
    data: {
      // sourceCustomerId 留空：Profile-only 创建，不产生 Customer 锚点。
      ownerUserId,
      name,
      // namePinyin：与 name 同源计算（namePinyin 字段唯一真相源见 src/lib/crm/pinyin.ts）。
      // 此处 name 已 trim 且非空，结果必为非空；保留 `|| null` 仅为防御性对称约定。
      namePinyin: toPinyinToneless(name) || null,
      customerCode,
      principal: input.principal?.trim() || null,
      phone: input.phone?.trim() || null,
      wechat: input.wechat?.trim() || null,
      email: input.email?.trim() || null,
      miniProgramId: input.miniProgramId?.trim() || null,
      nameDisambiguator: input.nameDisambiguator?.trim() || null,
      labOrGroup: input.labOrGroup?.trim() || null,
      personCategory: input.personCategory?.trim() || null,
      jobTitle: input.jobTitle?.trim() || null,
      address: input.address?.trim() || null,
      addressNote: input.addressNote?.trim() || null,
      receiverPhone: input.receiverPhone?.trim() || null,
      receiverAddress: input.receiverAddress?.trim() || null,
      organizationId: input.organizationId || null,
      organization: input.organization?.trim() || null,
      organizationSiteId: input.organizationSiteId || null,
      organizationRawInput: input.organizationRawInput?.trim() || null,
      stage: input.stage ?? "LEAD",
      importance: input.importance ?? "NORMAL",
      assignmentStatus,
      assignedAt: assignmentStatus === "ASSIGNED" ? new Date() : null,
      tagsJson,
      lastFollowUpAt: null,
    },
    select: { id: true },
  });

  if (explicitOwnerUserId) {
    await syncProfileRepresentativeLinksFromOwner(profile.id, ownerUserId, db);
  } else {
    await syncProfileRepresentativeLinks(profile.id, db);
  }

  // 部门隔离 Phase 4：所有正式创建路径必须同时补齐两行部门 state
  // （FIELD_SALES 按 §9.2 旧字段映射，ONLINE_OPS 隐藏 POOL）。
  await ensureDepartmentStatesForLegacyProfile(
    profile.id,
    {
      ownerUserId,
      assignmentStatus,
      stage: input.stage ?? "LEAD",
      importance: input.importance ?? "NORMAL",
      assignedAt: assignmentStatus === "ASSIGNED" ? new Date() : null,
    },
    db,
  );

  return { id: profile.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 部门隔离 Phase 4：部门 state 补齐 + createOrAttachCrmProfile（设计 §4.4 / §8.1）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旧 profile 字段快照 → 部门 state 的映射输入（与 §9.2 回填映射一致）。
 */
export type LegacyAssignmentSnapshot = {
  ownerUserId: string | null;
  assignmentStatus: string;
  stage?: string | null;
  importance?: string | null;
  assignedAt?: Date | null;
  assignedByUserId?: string | null;
  recalledAt?: Date | null;
};

/**
 * 为既有（FIELD_SALES 语义）创建路径补齐两行 CrmProfileDepartmentState：
 *   - FIELD_SALES 按 §9.2 映射（ASSIGNED→CLAIMED / RECALL_CANDIDATE→RECALL_CANDIDATE /
 *     RECALLED→POOL+RELEASED / 其他→隐藏 POOL）。
 *   - ONLINE_OPS 一律隐藏 POOL（poolEntryReason=null，无共享授权不可见）。
 * 已存在的 state 行绝不覆盖（幂等）。
 */
export async function ensureDepartmentStatesForLegacyProfile(
  profileId: string,
  snapshot: LegacyAssignmentSnapshot,
  db: DbLike = prisma,
): Promise<void> {
  const existing = await db.crmProfileDepartmentState.findMany({
    where: { profileId },
    select: { department: true },
  });
  const existingDepartments = new Set(existing.map((s) => s.department));

  const creates: Prisma.CrmProfileDepartmentStateUncheckedCreateInput[] = [];

  if (!existingDepartments.has("FIELD_SALES")) {
    if (snapshot.ownerUserId && snapshot.assignmentStatus === "ASSIGNED") {
      creates.push({
        profileId,
        department: "FIELD_SALES",
        claimStatus: "CLAIMED",
        ownerUserId: snapshot.ownerUserId,
        stage: snapshot.stage ?? null,
        importance: snapshot.importance ?? null,
        claimedAt: snapshot.assignedAt ?? new Date(),
        claimedById: snapshot.assignedByUserId ?? null,
      });
    } else if (snapshot.ownerUserId && snapshot.assignmentStatus === "RECALL_CANDIDATE") {
      creates.push({
        profileId,
        department: "FIELD_SALES",
        claimStatus: "RECALL_CANDIDATE",
        ownerUserId: snapshot.ownerUserId,
        stage: snapshot.stage ?? null,
        importance: snapshot.importance ?? null,
        claimedAt: snapshot.assignedAt ?? new Date(),
        claimedById: snapshot.assignedByUserId ?? null,
      });
    } else if (snapshot.assignmentStatus === "RECALLED") {
      creates.push({
        profileId,
        department: "FIELD_SALES",
        claimStatus: "POOL",
        poolEntryReason: "RELEASED",
        releasedAt: snapshot.recalledAt ?? new Date(),
      });
    } else {
      creates.push({ profileId, department: "FIELD_SALES", claimStatus: "POOL" });
    }
  }

  if (!existingDepartments.has("ONLINE_OPS")) {
    creates.push({ profileId, department: "ONLINE_OPS", claimStatus: "POOL" });
  }

  for (const data of creates) {
    await db.crmProfileDepartmentState.create({ data });
  }
}

/**
 * 全局去重冲突（§8.1）：多个确定性候选 / 关键字段冲突 / 模糊隐藏候选。
 * 只携带候选数量，绝不向录入人泄露另一部门的候选详情。
 */
export class CrmProfileDuplicateConflictError extends ApplicationError {
  readonly candidateCount: number;
  constructor(candidateCount: number) {
    super(
      "检测到疑似重复客户，已进入去重审核流程，请由 ADMIN 确认后再录入",
      409,
      "DUPLICATE_CANDIDATES",
    );
    this.candidateCount = candidateCount;
  }
}

// ── 身份字段规范化（全局匹配用）──

function normalizePhoneDigits(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 5 ? digits : null;
}

function normalizeLower(value: string | null | undefined): string | null {
  const t = value?.trim().toLowerCase();
  return t || null;
}

function normalizeNameKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizeOrgKey(value: string | null | undefined): string | null {
  const t = (value ?? "").replace(/\s+/g, "").toLowerCase();
  return t || null;
}

const MATCH_SELECT = {
  id: true,
  name: true,
  phone: true,
  wechat: true,
  email: true,
  miniProgramId: true,
  organizationId: true,
  organization: true,
  organizationRawInput: true,
} as const;

type MatchRow = Prisma.CrmCustomerProfileGetPayload<{ select: typeof MATCH_SELECT }>;

type GlobalMatchResult = {
  /** 确定性候选：规范化联系方式精确匹配，或 姓名+机构 精确匹配。 */
  strong: MatchRow[];
  /** 模糊候选数：仅同名（机构不匹配、联系方式不匹配）。不返回详情。 */
  weakCount: number;
};

/**
 * 全局确定性匹配（§8.1 步骤 1）：跨全部部门在共享身份库上匹配。
 * SQLite `contains` 对 ASCII 大小写不敏感，作为粗筛；终判在 JS 侧做规范化等值比较
 * （phone 仅比数字、wechat/email 小写化、name/org 去空白小写化）。
 */
async function findGlobalDeterministicMatches(
  db: DbLike,
  input: {
    name: string;
    phone?: string | null;
    wechat?: string | null;
    email?: string | null;
    miniProgramId?: string | null;
    organizationId?: string | null;
    organization?: string | null;
    organizationRawInput?: string | null;
  },
): Promise<GlobalMatchResult> {
  const active = { deleted: false, archived: false, mergedIntoProfileId: null } as const;
  const strong = new Map<string, MatchRow>();

  const phoneDigits = normalizePhoneDigits(input.phone);
  const wechatKey = normalizeLower(input.wechat);
  const emailKey = normalizeLower(input.email);
  const miniProgramId = input.miniProgramId?.trim() || null;
  const nameKey = normalizeNameKey(input.name);
  const orgTextKey = normalizeOrgKey(input.organizationRawInput ?? input.organization);

  const channelLookups: Array<Promise<void>> = [];

  if (input.phone?.trim()) {
    channelLookups.push(
      db.crmCustomerProfile
        .findMany({ where: { ...active, phone: { contains: input.phone.trim() } }, select: MATCH_SELECT, take: 25 })
        .then((rows) => {
          for (const row of rows) {
            if (phoneDigits && normalizePhoneDigits(row.phone) === phoneDigits) strong.set(row.id, row);
          }
        }),
    );
  }
  if (input.wechat?.trim()) {
    channelLookups.push(
      db.crmCustomerProfile
        .findMany({ where: { ...active, wechat: { contains: input.wechat.trim() } }, select: MATCH_SELECT, take: 25 })
        .then((rows) => {
          for (const row of rows) {
            if (wechatKey && normalizeLower(row.wechat) === wechatKey) strong.set(row.id, row);
          }
        }),
    );
  }
  if (input.email?.trim()) {
    channelLookups.push(
      db.crmCustomerProfile
        .findMany({ where: { ...active, email: { contains: input.email.trim() } }, select: MATCH_SELECT, take: 25 })
        .then((rows) => {
          for (const row of rows) {
            if (emailKey && normalizeLower(row.email) === emailKey) strong.set(row.id, row);
          }
        }),
    );
  }
  if (miniProgramId) {
    channelLookups.push(
      db.crmCustomerProfile
        .findMany({ where: { ...active, miniProgramId }, select: MATCH_SELECT, take: 25 })
        .then((rows) => {
          for (const row of rows) strong.set(row.id, row);
        }),
    );
  }

  const nameRowsPromise = db.crmCustomerProfile.findMany({
    where: { ...active, name: { contains: input.name.trim() } },
    select: MATCH_SELECT,
    take: 50,
  });

  await Promise.all(channelLookups);
  const nameRows = await nameRowsPromise;
  const sameName = nameRows.filter((r) => normalizeNameKey(r.name) === nameKey);

  for (const row of sameName) {
    const orgIdMatch = !!input.organizationId && row.organizationId === input.organizationId;
    const rowOrgKey = normalizeOrgKey(row.organizationRawInput ?? row.organization);
    const orgTextMatch = !!orgTextKey && !!rowOrgKey && rowOrgKey === orgTextKey;
    if (orgIdMatch || orgTextMatch) strong.set(row.id, row);
  }

  const weakCount = sameName.filter((r) => !strong.has(r.id)).length;
  return { strong: [...strong.values()], weakCount };
}

/**
 * 关键身份字段冲突检查（§8.1：不自动覆盖共享 profile）：
 * 录入提供了非空联系方式且与候选既有非空值不一致，或姓名不一致 → 冲突。
 */
function hasKeyIdentityConflict(
  input: {
    name: string;
    phone?: string | null;
    wechat?: string | null;
    email?: string | null;
    miniProgramId?: string | null;
  },
  candidate: MatchRow,
): boolean {
  if (normalizeNameKey(candidate.name) !== normalizeNameKey(input.name)) return true;
  const pairs: Array<[string | null, string | null]> = [
    [normalizePhoneDigits(input.phone), normalizePhoneDigits(candidate.phone)],
    [normalizeLower(input.wechat), normalizeLower(candidate.wechat)],
    [normalizeLower(input.email), normalizeLower(candidate.email)],
    [input.miniProgramId?.trim() || null, candidate.miniProgramId?.trim() || null],
  ];
  for (const [provided, existing] of pairs) {
    if (provided && existing && provided !== existing) return true;
  }
  return false;
}

export type CreateOrAttachCrmProfileInput = {
  actor: BusinessActor;
  /**
   * 全局身份输入。复用 CreateCrmCustomerProfileInput 的字段形状；
   * 其中 ownerUserId / assignmentStatus / stage / importance 是旧 FIELD_SALES
   * 兼容字段，本入口忽略（owner/阶段走 departmentStateInput）。
   */
  identityInput: CreateCrmCustomerProfileInput;
  /** actor 部门 state 的运营字段；owner 默认 actor.userId（必须属于目标部门）。 */
  departmentStateInput?: {
    ownerUserId?: string | null;
    stage?: string | null;
    importance?: string | null;
    source?: string | null;
  };
  /**
   * 可选：显式共享到目标部门公海。缺省不共享（不会自动进入其他部门公海）。
   * sourceDepartment 固定为 actor（或 ADMIN 指定的）创建部门，客户端/导入文件不可指定。
   */
  poolSharingInput?: { targetDepartment: string } | null;
  /** 仅 ADMIN 可传：代其他部门创建/认领（写跨部门审计）。 */
  targetDepartment?: string | null;
};

export type CreateOrAttachCrmProfileResult = {
  profileId: string;
  /** CREATED=新建全局身份；ATTACHED=复用既有身份并为录入部门建立 CLAIMED；ALREADY_CLAIMED=本部门已持有。 */
  outcome: "CREATED" | "ATTACHED" | "ALREADY_CLAIMED";
  department: Department;
};

const CROSS_DEPT_ADMIN_REASON = "ADMIN 跨部门代操作";

function joinReasons(...parts: Array<string | null | false>): string | null {
  const joined = parts.filter((p): p is string => !!p).join("；");
  return joined || null;
}

/**
 * 客户创建与全局去重的共享领域服务（§8.1）。两个门户的创建流程最终都调用本函数。
 *
 * 事务内：
 *   1. 规范化 phone/wechat/email/姓名+机构 全局匹配；
 *   2. 无匹配 → 创建一份 profile；唯一确定性匹配 → 复用不复制；
 *      多候选 / 关键字段冲突 / 仅模糊同名 → CrmProfileDuplicateConflictError（409，不泄露详情）；
 *   3. 创建/补齐两行 DepartmentState；actor 部门 POOL→CLAIMED（写 owner/stage/source）；
 *      另一部门 state 已 CLAIMED 绝不覆盖；
 *   4. 可选 poolSharingInput 显式共享（经 setProfilePoolShareInTx 权限校验）；
 *   5. 写 CLAIM / 去重复用审计；
 *   6. 仅 FIELD_SALES 同步旧 ownerUserId/assignmentStatus 兼容链与 effective representative；
 *      ONLINE_OPS 创建禁止伪造 FIELD_SALES owner（ownerUserId=null, assignmentStatus=UNASSIGNED）。
 */
export async function createOrAttachCrmProfile(
  input: CreateOrAttachCrmProfileInput,
): Promise<CreateOrAttachCrmProfileResult> {
  const { actor } = input;
  const identity = input.identityInput;
  const name = identity.name?.trim();
  if (!name) throw new ValidationError("createOrAttachCrmProfile: name is required");

  // 部门解析：非 ADMIN 固定数据库当前部门；仅 ADMIN 可代其他部门（写跨部门审计）。
  const actorDepartment = await getActorDepartment(actor.userId);
  let department: Department = actorDepartment;
  let crossDepartmentByAdmin = false;
  if (input.targetDepartment != null) {
    if (!isDepartment(input.targetDepartment)) {
      throw new ValidationError(`非法 targetDepartment: ${String(input.targetDepartment)}`);
    }
    if (input.targetDepartment !== actorDepartment) {
      if (actor.role !== "ADMIN") {
        throw new ForbiddenError("非 ADMIN 不能为其他部门创建/认领客户");
      }
      department = input.targetDepartment;
      crossDepartmentByAdmin = true;
    }
  }

  const ownerUserId = input.departmentStateInput?.ownerUserId?.trim() || actor.userId;
  const stateInput = input.departmentStateInput;

  if (input.poolSharingInput) {
    if (!isDepartment(input.poolSharingInput.targetDepartment)) {
      throw new ValidationError(
        `非法 poolSharingInput.targetDepartment: ${String(input.poolSharingInput.targetDepartment)}`,
      );
    }
    if (input.poolSharingInput.targetDepartment === department) {
      throw new ValidationError("共享目标部门不能与创建部门相同");
    }
  }

  return prisma.$transaction(async (tx) => {
    // owner 必须与目标部门一致（同事务校验）。
    const owner = await tx.user.findUnique({
      where: { id: ownerUserId },
      select: { id: true, department: true },
    });
    if (!owner) throw new ValidationError("负责人不存在");
    if (owner.department !== department) {
      throw new ValidationError("负责人不属于目标部门");
    }

    const matches = await findGlobalDeterministicMatches(tx, {
      name,
      phone: identity.phone,
      wechat: identity.wechat,
      email: identity.email,
      miniProgramId: identity.miniProgramId,
      organizationId: identity.organizationId,
      organization: identity.organization,
      organizationRawInput: identity.organizationRawInput,
    });

    if (matches.strong.length === 0 && matches.weakCount > 0) {
      throw new CrmProfileDuplicateConflictError(matches.weakCount);
    }
    if (matches.strong.length > 1) {
      throw new CrmProfileDuplicateConflictError(matches.strong.length);
    }

    const now = new Date();
    const isFieldSales = department === "FIELD_SALES";
    const otherDepartment = DEPARTMENTS.find((d) => d !== department)!;
    let profileId: string;
    let outcome: CreateOrAttachCrmProfileResult["outcome"];

    if (matches.strong.length === 0) {
      // ── 新建全局身份 ──
      const customerCode = identity.customerCode?.trim() || (await generateCustomerCode(tx));
      const tagsJson = identity.sourceHint ? JSON.stringify({ source: identity.sourceHint }) : null;
      const profile = await tx.crmCustomerProfile.create({
        data: {
          // ONLINE_OPS 创建禁止伪造 FIELD_SALES owner：旧字段保持 null/UNASSIGNED。
          ownerUserId: isFieldSales ? ownerUserId : null,
          assignmentStatus: isFieldSales ? "ASSIGNED" : "UNASSIGNED",
          assignedAt: isFieldSales ? now : null,
          assignedByUserId: isFieldSales ? actor.userId : null,
          stage: isFieldSales ? (stateInput?.stage ?? "LEAD") : "LEAD",
          importance: isFieldSales ? (stateInput?.importance ?? "NORMAL") : "NORMAL",
          name,
          namePinyin: toPinyinToneless(name) || null,
          customerCode,
          principal: identity.principal?.trim() || null,
          phone: identity.phone?.trim() || null,
          wechat: identity.wechat?.trim() || null,
          email: identity.email?.trim() || null,
          miniProgramId: identity.miniProgramId?.trim() || null,
          nameDisambiguator: identity.nameDisambiguator?.trim() || null,
          labOrGroup: identity.labOrGroup?.trim() || null,
          personCategory: identity.personCategory?.trim() || null,
          jobTitle: identity.jobTitle?.trim() || null,
          address: identity.address?.trim() || null,
          addressNote: identity.addressNote?.trim() || null,
          receiverPhone: identity.receiverPhone?.trim() || null,
          receiverAddress: identity.receiverAddress?.trim() || null,
          organizationId: identity.organizationId || null,
          organization: identity.organization?.trim() || null,
          organizationSiteId: identity.organizationSiteId || null,
          organizationRawInput: identity.organizationRawInput?.trim() || null,
          tagsJson,
          lastFollowUpAt: null,
        },
        select: { id: true },
      });
      profileId = profile.id;

      await tx.crmProfileDepartmentState.create({
        data: {
          profileId,
          department,
          claimStatus: "CLAIMED",
          ownerUserId,
          stage: stateInput?.stage ?? "LEAD",
          importance: stateInput?.importance ?? "NORMAL",
          source: stateInput?.source ?? null,
          claimedAt: now,
          claimedById: actor.userId,
        },
      });
      await tx.crmProfileDepartmentState.create({
        data: { profileId, department: otherDepartment, claimStatus: "POOL" },
      });

      await tx.crmCustomerAssignmentLog.create({
        data: {
          profileId,
          action: "CLAIM",
          department,
          fromOwnerUserId: null,
          toOwnerUserId: ownerUserId,
          reason: joinReasons("创建自认领", crossDepartmentByAdmin && CROSS_DEPT_ADMIN_REASON),
          createdByUserId: actor.userId,
        },
      });

      // FIELD_SALES 兼容链：effective representative / Order-Project 代表缓存同步（保留现有行为）。
      if (isFieldSales) {
        await syncProfileRepresentativeLinksFromOwner(profileId, ownerUserId, tx);
      }
      outcome = "CREATED";
    } else {
      // ── 复用既有全局身份（§8.1 末段：独立录入确定性去重，不是公海认领，不要求共享授权）──
      const candidate = matches.strong[0]!;
      if (hasKeyIdentityConflict(
        {
          name,
          phone: identity.phone,
          wechat: identity.wechat,
          email: identity.email,
          miniProgramId: identity.miniProgramId,
        },
        candidate,
      )) {
        throw new CrmProfileDuplicateConflictError(1);
      }
      profileId = candidate.id;

      // 补齐缺失的 state 行（隐藏 POOL）；已存在的行绝不覆盖。
      const existingStates = await tx.crmProfileDepartmentState.findMany({
        where: { profileId },
        select: { department: true, claimStatus: true },
      });
      for (const d of DEPARTMENTS) {
        if (!existingStates.some((s) => s.department === d)) {
          await tx.crmProfileDepartmentState.create({
            data: { profileId, department: d, claimStatus: "POOL" },
          });
        }
      }
      const myState = existingStates.find((s) => s.department === department);
      if (myState?.claimStatus === "CLAIMED") {
        outcome = "ALREADY_CLAIMED";
      } else {
        const claimed = await tx.crmProfileDepartmentState.updateMany({
          where: { profileId, department, claimStatus: "POOL" },
          data: {
            claimStatus: "CLAIMED",
            ownerUserId,
            stage: stateInput?.stage ?? null,
            importance: stateInput?.importance ?? null,
            source: stateInput?.source ?? null,
            claimedAt: now,
            claimedById: actor.userId,
            poolEntryReason: null,
            releasedAt: null,
          },
        });
        if (claimed.count !== 1) {
          const fresh = await tx.crmProfileDepartmentState.findUnique({
            where: { profileId_department: { profileId, department } },
            select: { claimStatus: true },
          });
          if (fresh?.claimStatus === "CLAIMED") {
            outcome = "ALREADY_CLAIMED";
          } else {
            throw new ConflictError("认领状态并发变化，请刷新后重试");
          }
        } else {
          outcome = "ATTACHED";
        }
      }

      if (outcome === "ATTACHED") {
        await tx.crmCustomerAssignmentLog.create({
          data: {
            profileId,
            action: "CLAIM",
            department,
            fromOwnerUserId: null,
            toOwnerUserId: ownerUserId,
            reason: joinReasons("独立录入全局去重复用", crossDepartmentByAdmin && CROSS_DEPT_ADMIN_REASON),
            createdByUserId: actor.userId,
          },
        });
        if (isFieldSales) {
          await tx.crmCustomerProfile.update({
            where: { id: profileId },
            data: {
              assignmentStatus: "ASSIGNED",
              ownerUserId,
              assignedAt: now,
              assignedByUserId: actor.userId,
              recalledAt: null,
              recalledByUserId: null,
              reflowReason: null,
            },
          });
        }
      }
    }

    // 显式共享（§8.1 步骤 6）：sourceDepartment 固定为创建部门，权限由共享服务自校验。
    if (input.poolSharingInput) {
      await setProfilePoolShareInTx(tx, {
        actor,
        profileId,
        sourceDepartment: department,
        targetDepartment: input.poolSharingInput.targetDepartment as Department,
        shared: true,
        crossDepartmentByAdmin,
      });
    }

    return { profileId, outcome, department };
  });
}
