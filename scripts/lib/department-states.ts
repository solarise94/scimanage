/**
 * 部门隔离 Phase 4 共享逻辑：CrmProfileDepartmentState 回填 + §12.3 一致性扫描。
 *
 * 设计依据：docs/department-isolation-design-2026-07-24.md §4.4 / §9.2 / §12.3。
 * 本模块被以下入口复用：
 *   - scripts/backfill-department-states.ts（CLI，--dry-run 默认 / --apply 写库）
 *   - scripts/scan-department-consistency.ts（CLI，只读）
 *   - tests/department-state-backfill.test.ts（临时 SQLite 单测）
 *
 * 约定：
 *   - active profile = deleted=false 且 mergedIntoProfileId IS NULL（archived 仍属在册数据，不排除）。
 *   - 隐藏 POOL = claimStatus=POOL 且 poolEntryReason=null（从未由本部门持有，无共享授权不可见）。
 *   - 「隐藏 POOL 却有 poolEntryReason」在数据上不可直接观测，落地为可检测的残留配对异常：
 *     POOL 且 poolEntryReason IS NULL 却残留 releasedAt（hiddenPoolWithReleaseResidue）。
 */

import type { PrismaClient } from "@prisma/client";

export const DEPARTMENT_VALUES = ["FIELD_SALES", "ONLINE_OPS"] as const;
export type DepartmentValue = (typeof DEPARTMENT_VALUES)[number];

export function isDepartmentValue(value: unknown): value is DepartmentValue {
  return typeof value === "string" && (DEPARTMENT_VALUES as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backfill（§4.4 / §9.2）
// ─────────────────────────────────────────────────────────────────────────────

export type ProfileForBackfill = {
  id: string;
  ownerUserId: string | null;
  assignmentStatus: string;
  stage: string;
  importance: string;
  assignedAt: Date | null;
  assignedByUserId: string | null;
  recalledAt: Date | null;
};

export type PlannedDepartmentState = {
  profileId: string;
  department: DepartmentValue;
  claimStatus: "CLAIMED" | "RECALL_CANDIDATE" | "POOL";
  ownerUserId: string | null;
  stage: string | null;
  importance: string | null;
  source: string | null;
  claimedAt: Date | null;
  claimedById: string | null;
  poolEntryReason: string | null;
  releasedAt: Date | null;
};

/**
 * 旧 CrmCustomerProfile 字段 → FIELD_SALES state 映射（§9.2）。
 * 注意：CrmCustomerProfile 无 source 字段，state.source 一律回填 null。
 */
export function planFieldSalesState(p: ProfileForBackfill): PlannedDepartmentState {
  const base: PlannedDepartmentState = {
    profileId: p.id,
    department: "FIELD_SALES",
    claimStatus: "POOL",
    ownerUserId: null,
    stage: null,
    importance: null,
    source: null,
    claimedAt: null,
    claimedById: null,
    poolEntryReason: null,
    releasedAt: null,
  };

  if (p.ownerUserId && p.assignmentStatus === "ASSIGNED") {
    return {
      ...base,
      claimStatus: "CLAIMED",
      ownerUserId: p.ownerUserId,
      stage: p.stage,
      importance: p.importance,
      claimedAt: p.assignedAt,
      claimedById: p.assignedByUserId,
    };
  }
  if (p.ownerUserId && p.assignmentStatus === "RECALL_CANDIDATE") {
    // 待收回候选：保留 owner 与运营字段
    return {
      ...base,
      claimStatus: "RECALL_CANDIDATE",
      ownerUserId: p.ownerUserId,
      stage: p.stage,
      importance: p.importance,
      claimedAt: p.assignedAt,
      claimedById: p.assignedByUserId,
    };
  }
  if (p.assignmentStatus === "RECALLED") {
    // 已回收：进入本部门公海（释放语义）
    return {
      ...base,
      claimStatus: "POOL",
      poolEntryReason: "RELEASED",
      releasedAt: p.recalledAt,
    };
  }
  // UNASSIGNED / 无 owner：隐藏池（从未由本部门持有语义，无共享授权不可见）
  return base;
}

/** ONLINE_OPS 初始 state：隐藏 POOL，不创建任何 CrmProfilePoolShare（§9.2）。 */
export function planOnlineOpsState(profileId: string): PlannedDepartmentState {
  return {
    profileId,
    department: "ONLINE_OPS",
    claimStatus: "POOL",
    ownerUserId: null,
    stage: null,
    importance: null,
    source: null,
    claimedAt: null,
    claimedById: null,
    poolEntryReason: null,
    releasedAt: null,
  };
}

export type BackfillAnomaly = {
  profileId: string;
  department: string;
  kind:
    | "CLAIMED_WITHOUT_OWNER"
    | "OWNER_NOT_FOUND"
    | "OWNER_DEPARTMENT_MISMATCH";
  detail: string;
};

export type BackfillStats = {
  apply: boolean;
  profilesScanned: number;
  statesCreatedFieldSales: number;
  statesCreatedOnlineOps: number;
  statesSkippedExisting: number;
  plannedCreates: PlannedDepartmentState[];
  anomalies: BackfillAnomaly[];
  /** apply 模式下的终态校验：缺任一部门 state 的 profile 数（必须为 0）；dry-run 为 null */
  missingStateProfilesAfterApply: number | null;
};

export async function backfillDepartmentStates(
  prisma: PrismaClient,
  opts: { apply: boolean },
): Promise<BackfillStats> {
  const profiles = await prisma.crmCustomerProfile.findMany({
    select: {
      id: true,
      ownerUserId: true,
      assignmentStatus: true,
      stage: true,
      importance: true,
      assignedAt: true,
      assignedByUserId: true,
      recalledAt: true,
    },
    orderBy: { id: "asc" },
  });

  const existingStates = await prisma.crmProfileDepartmentState.findMany({
    select: {
      profileId: true,
      department: true,
      claimStatus: true,
      ownerUserId: true,
    },
  });
  const existingKeys = new Set(existingStates.map((s) => `${s.profileId}::${s.department}`));

  const plannedCreates: PlannedDepartmentState[] = [];
  let skippedExisting = 0;

  for (const p of profiles) {
    for (const plan of [planFieldSalesState(p), planOnlineOpsState(p.id)]) {
      if (existingKeys.has(`${plan.profileId}::${plan.department}`)) {
        skippedExisting += 1;
        continue;
      }
      plannedCreates.push(plan);
    }
  }

  // ── 异常检查：CLAIMED 必须有 owner；owner.department 必须等于 state.department ──
  // 覆盖「计划创建 + 已存在」的全部 CLAIMED state（幂等重跑也要报告存量异常）。
  //
  // 悬挂 owner（ownerUserId 指向已不存在的 User）：state.ownerUser 是 Restrict FK，
  // 直接创建会违反外键，而 CLAIMED 无 owner 又违反不变量。按 §4.4「负责人不可用」语义
  // 降级为 POOL + poolEntryReason=OWNER_UNAVAILABLE（不改 profile 业务字段，只影响本次
  // 新建的 state），并计 OWNER_NOT_FOUND 异常。
  const anomalies: BackfillAnomaly[] = [];
  const plannedOwnerIds = [
    ...new Set(plannedCreates.map((p) => p.ownerUserId).filter((v): v is string => v != null)),
  ];
  const plannedOwners = plannedOwnerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: plannedOwnerIds } },
        select: { id: true, department: true },
      })
    : [];
  const plannedOwnerDeptById = new Map(plannedOwners.map((u) => [u.id, u.department]));
  for (let i = 0; i < plannedCreates.length; i++) {
    const plan = plannedCreates[i]!;
    if (plan.ownerUserId && !plannedOwnerDeptById.has(plan.ownerUserId)) {
      anomalies.push({
        profileId: plan.profileId,
        department: plan.department,
        kind: "OWNER_NOT_FOUND",
        detail:
          `owner ${plan.ownerUserId} 不存在；${plan.claimStatus} 降级为 POOL+OWNER_UNAVAILABLE` +
          `（assignmentStatus 旧值对应的 profile 业务字段未改动）`,
      });
      plannedCreates[i] = {
        ...plan,
        claimStatus: "POOL",
        ownerUserId: null,
        stage: null,
        importance: null,
        claimedAt: null,
        claimedById: null,
        poolEntryReason: "OWNER_UNAVAILABLE",
        releasedAt: null,
      };
    }
  }

  const claimedRows: Array<{ profileId: string; department: string; ownerUserId: string | null }> = [
    ...plannedCreates
      .filter((p) => p.claimStatus === "CLAIMED")
      .map((p) => ({ profileId: p.profileId, department: p.department, ownerUserId: p.ownerUserId })),
    ...existingStates
      .filter((s) => s.claimStatus === "CLAIMED")
      .map((s) => ({ profileId: s.profileId, department: s.department, ownerUserId: s.ownerUserId })),
  ];
  const ownerIds = [...new Set(claimedRows.map((r) => r.ownerUserId).filter((v): v is string => v != null))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, department: true },
      })
    : [];
  const ownerDeptById = new Map(owners.map((u) => [u.id, u.department]));

  for (const row of claimedRows) {
    if (!row.ownerUserId) {
      anomalies.push({
        profileId: row.profileId,
        department: row.department,
        kind: "CLAIMED_WITHOUT_OWNER",
        detail: "CLAIMED state 缺少 ownerUserId",
      });
      continue;
    }
    const ownerDept = ownerDeptById.get(row.ownerUserId);
    if (ownerDept === undefined) {
      anomalies.push({
        profileId: row.profileId,
        department: row.department,
        kind: "OWNER_NOT_FOUND",
        detail: `owner ${row.ownerUserId} 不存在`,
      });
      continue;
    }
    if (ownerDept !== row.department) {
      anomalies.push({
        profileId: row.profileId,
        department: row.department,
        kind: "OWNER_DEPARTMENT_MISMATCH",
        detail: `owner.department=${ownerDept} 与 state.department=${row.department} 不一致`,
      });
    }
  }

  let missingAfter: number | null = null;
  if (opts.apply && plannedCreates.length > 0) {
    // 逐行 create（SQLite 不支持 skipDuplicates）；existingKeys 预检保证幂等。
    await prisma.$transaction(
      plannedCreates.map((plan) =>
        prisma.crmProfileDepartmentState.create({
          data: {
            profileId: plan.profileId,
            department: plan.department,
            claimStatus: plan.claimStatus,
            ownerUserId: plan.ownerUserId,
            stage: plan.stage,
            importance: plan.importance,
            source: plan.source,
            claimedAt: plan.claimedAt,
            claimedById: plan.claimedById,
            poolEntryReason: plan.poolEntryReason,
            releasedAt: plan.releasedAt,
          },
        }),
      ),
    );
  }

  if (opts.apply) {
    // 终态校验：每个 profile 必须恰好两行（FIELD_SALES + ONLINE_OPS），缺行必须为 0。
    const states = await prisma.crmProfileDepartmentState.findMany({
      select: { profileId: true, department: true },
    });
    const deptByProfile = new Map<string, Set<string>>();
    for (const s of states) {
      const set = deptByProfile.get(s.profileId) ?? new Set<string>();
      set.add(s.department);
      deptByProfile.set(s.profileId, set);
    }
    missingAfter = profiles.filter((p) => {
      const set = deptByProfile.get(p.id);
      return !set || DEPARTMENT_VALUES.some((d) => !set.has(d));
    }).length;
  }

  return {
    apply: opts.apply,
    profilesScanned: profiles.length,
    statesCreatedFieldSales: plannedCreates.filter((p) => p.department === "FIELD_SALES").length,
    statesCreatedOnlineOps: plannedCreates.filter((p) => p.department === "ONLINE_OPS").length,
    statesSkippedExisting: skippedExisting,
    plannedCreates,
    anomalies,
    missingStateProfilesAfterApply: missingAfter,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 一致性扫描（§12.3，只读）
// ─────────────────────────────────────────────────────────────────────────────

/** 含不可变 departmentSnapshot 的归属根/运营模型（表名即模型名，无 @@map）。 */
export const SNAPSHOT_TABLES = [
  "Project",
  "Order",
  "ExternalOrder",
  "ExternalOrderImportBatch",
  "ExternalOrderInvoiceRequest",
  "FinanceReceipt",
  "FinanceCost",
  "FinanceAdvance",
  "FinanceCommission",
  "FinancePayment",
  "FinancePayable",
  "CostEntry",
  "SupplierInquiry",
  "ContractDocument",
  "CrmInteraction",
  "CrmFollowUpTask",
  "CrmVisitCheckin",
  "CrmCustomerApplication",
  "CrmComplaint",
  "CrmCustomerPreference",
] as const;

export type ScanItem = {
  key: string;
  label: string;
  count: number;
  samples: string[];
};

export type ScanReport = {
  items: ScanItem[];
  ok: boolean;
};

type RawCountRow = { c: number | bigint };

function toNumber(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

async function rawCount(prisma: PrismaClient, sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<RawCountRow[]>(sql);
  return toNumber(rows[0]?.c ?? 0);
}

async function rawIds(prisma: PrismaClient, sql: string, limit = 10): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(sql);
  return rows.slice(0, limit).map((r) => r.id);
}

const LEGAL = `'${DEPARTMENT_VALUES.join("','")}'`;

function qi(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

export async function scanDepartmentConsistency(prisma: PrismaClient): Promise<ScanReport> {
  const items: ScanItem[] = [];
  const add = (key: string, label: string, count: number, samples: string[] = []) => {
    items.push({ key, label, count, samples });
  };

  // 1. 非法 department 值：User.department
  add(
    "illegalUserDepartment",
    "非法 User.department 值",
    await rawCount(
      prisma,
      `SELECT COUNT(*) AS c FROM "User" WHERE "department" NOT IN (${LEGAL})`,
    ),
  );

  // 1b. 非法 departmentSnapshot 值（全部归属根/运营模型合计）
  let illegalSnapshot = 0;
  for (const table of SNAPSHOT_TABLES) {
    illegalSnapshot += await rawCount(
      prisma,
      `SELECT COUNT(*) AS c FROM ${qi(table)} WHERE "departmentSnapshot" NOT IN (${LEGAL})`,
    );
  }
  add("illegalDepartmentSnapshot", "非法 departmentSnapshot 值（全部快照模型合计）", illegalSnapshot);

  // 1c. 非法部门值：AssignmentLog / DepartmentState / CustomerServiceAccount
  add(
    "illegalAssignmentLogDepartment",
    "非法 CrmCustomerAssignmentLog.department/targetDepartment 值",
    await rawCount(
      prisma,
      `SELECT COUNT(*) AS c FROM "CrmCustomerAssignmentLog"
       WHERE "department" NOT IN (${LEGAL})
          OR ("targetDepartment" IS NOT NULL AND "targetDepartment" NOT IN (${LEGAL}))`,
    ),
  );
  add(
    "illegalStateDepartment",
    "非法 CrmProfileDepartmentState.department 值",
    await rawCount(
      prisma,
      `SELECT COUNT(*) AS c FROM "CrmProfileDepartmentState" WHERE "department" NOT IN (${LEGAL})`,
    ),
  );
  add(
    "illegalServiceAccountDepartment",
    "非法 CustomerServiceAccount.department 值",
    await rawCount(
      prisma,
      `SELECT COUNT(*) AS c FROM "CustomerServiceAccount" WHERE "department" NOT IN (${LEGAL})`,
    ),
  );

  // 2. 必填 snapshot 空值（NULL 或空串）
  let emptySnapshot = 0;
  for (const table of SNAPSHOT_TABLES) {
    emptySnapshot += await rawCount(
      prisma,
      `SELECT COUNT(*) AS c FROM ${qi(table)} WHERE "departmentSnapshot" IS NULL OR "departmentSnapshot" = ''`,
    );
  }
  add("emptyDepartmentSnapshot", "必填 departmentSnapshot 空值（全部快照模型合计）", emptySnapshot);

  // 3. Project ↔ Order（OrderProjectLink）部门不一致
  const projectOrderMismatchSql = `
    SELECT l.id AS id FROM "OrderProjectLink" l
    JOIN "Order" o ON o.id = l."orderId"
    JOIN "Project" p ON p.id = l."projectId"
    WHERE o."departmentSnapshot" <> p."departmentSnapshot"`;
  add(
    "projectOrderDepartmentMismatch",
    "Project 与关联 Order 部门不一致（OrderProjectLink）",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${projectOrderMismatchSql})`),
    await rawIds(prisma, projectOrderMismatchSql),
  );

  // 4. Invoice/Contract 跨部门覆盖：同一 invoice/contract 下 order 部门不一致
  const invoiceCrossSql = `
    SELECT c."invoiceRequestId" AS id FROM "OrderInvoiceCoverage" c
    JOIN "Order" o ON o.id = c."orderId"
    GROUP BY c."invoiceRequestId"
    HAVING COUNT(DISTINCT o."departmentSnapshot") > 1`;
  add(
    "invoiceCrossDepartmentCoverage",
    "Invoice 跨部门覆盖（同一 invoice 下 order 部门不一致）",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${invoiceCrossSql})`),
    await rawIds(prisma, invoiceCrossSql),
  );
  const contractCrossSql = `
    SELECT c."contractId" AS id FROM "OrderContractCoverage" c
    JOIN "Order" o ON o.id = c."orderId"
    GROUP BY c."contractId"
    HAVING COUNT(DISTINCT o."departmentSnapshot") > 1`;
  add(
    "contractCrossDepartmentCoverage",
    "Contract 跨部门覆盖（同一 contract 下 order 部门不一致）",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${contractCrossSql})`),
    await rawIds(prisma, contractCrossSql),
  );

  // 5. Receipt/Invoice/Order allocation 部门不一致
  const receiptAllocSql = `
    SELECT a.id AS id FROM "FinanceReceiptAllocation" a
    JOIN "FinanceReceipt" r ON r.id = a."receiptId"
    JOIN "ExternalOrderInvoiceRequest" i ON i.id = a."invoiceId"
    JOIN "Order" o ON o.id = a."orderId"
    WHERE r."departmentSnapshot" <> i."departmentSnapshot"
       OR r."departmentSnapshot" <> o."departmentSnapshot"`;
  add(
    "receiptAllocationDepartmentMismatch",
    "Receipt/Invoice/Order allocation 部门不一致",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${receiptAllocSql})`),
    await rawIds(prisma, receiptAllocSql),
  );

  // 6. Payment/Payable allocation 部门不一致
  const paymentAllocSql = `
    SELECT a.id AS id FROM "FinancePaymentAllocation" a
    JOIN "FinancePayment" p ON p.id = a."paymentId"
    JOIN "FinancePayable" b ON b.id = a."payableId"
    WHERE p."departmentSnapshot" <> b."departmentSnapshot"`;
  add(
    "paymentAllocationDepartmentMismatch",
    "Payment/Payable allocation 部门不一致",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${paymentAllocSql})`),
    await rawIds(prisma, paymentAllocSql),
  );

  // 7. active profile 部门 state 完整性（active = deleted=false 且 mergedIntoProfileId IS NULL）
  const missingStateSql = `
    SELECT p.id AS id FROM "CrmCustomerProfile" p
    WHERE p."deleted" = 0 AND p."mergedIntoProfileId" IS NULL
      AND (
        SELECT COUNT(DISTINCT s."department") FROM "CrmProfileDepartmentState" s
        WHERE s."profileId" = p.id AND s."department" IN (${LEGAL})
      ) <> ${DEPARTMENT_VALUES.length}`;
  add(
    "profileStateMissing",
    "active profile 部门 state 完整性缺失（非恰好两行）",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${missingStateSql})`),
    await rawIds(prisma, missingStateSql),
  );

  // 8. DepartmentState：CLAIMED 无 owner / POOL 有 owner / owner 部门不一致
  const claimedNoOwnerSql = `
    SELECT s.id AS id FROM "CrmProfileDepartmentState" s
    WHERE s."claimStatus" = 'CLAIMED' AND s."ownerUserId" IS NULL`;
  add(
    "stateClaimedWithoutOwner",
    "DepartmentState CLAIMED 无 owner",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${claimedNoOwnerSql})`),
    await rawIds(prisma, claimedNoOwnerSql),
  );
  const poolWithOwnerSql = `
    SELECT s.id AS id FROM "CrmProfileDepartmentState" s
    WHERE s."claimStatus" = 'POOL' AND s."ownerUserId" IS NOT NULL`;
  add(
    "statePoolWithOwner",
    "DepartmentState POOL 有 owner",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${poolWithOwnerSql})`),
    await rawIds(prisma, poolWithOwnerSql),
  );
  const ownerDeptMismatchSql = `
    SELECT s.id AS id FROM "CrmProfileDepartmentState" s
    LEFT JOIN "User" u ON u.id = s."ownerUserId"
    WHERE s."ownerUserId" IS NOT NULL
      AND (u.id IS NULL OR u."department" <> s."department")`;
  add(
    "stateOwnerDepartmentMismatch",
    "DepartmentState owner 部门与 state 部门不一致（含 owner 不存在）",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${ownerDeptMismatchSql})`),
    await rawIds(prisma, ownerDeptMismatchSql),
  );

  // 9. DepartmentState：隐藏 POOL 残留 / 已释放 POOL 缺 releasedAt / CLAIMED 残留 poolEntryReason
  const hiddenResidueSql = `
    SELECT s.id AS id FROM "CrmProfileDepartmentState" s
    WHERE s."claimStatus" = 'POOL' AND s."poolEntryReason" IS NULL AND s."releasedAt" IS NOT NULL`;
  add(
    "hiddenPoolWithReleaseResidue",
    "隐藏 POOL（poolEntryReason=null）残留 releasedAt",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${hiddenResidueSql})`),
    await rawIds(prisma, hiddenResidueSql),
  );
  const releasedMissingAtSql = `
    SELECT s.id AS id FROM "CrmProfileDepartmentState" s
    WHERE s."claimStatus" = 'POOL' AND s."poolEntryReason" = 'RELEASED' AND s."releasedAt" IS NULL`;
  add(
    "releasedPoolMissingReleasedAt",
    "已释放 POOL（RELEASED）缺 releasedAt",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${releasedMissingAtSql})`),
    await rawIds(prisma, releasedMissingAtSql),
  );
  const claimedResidueSql = `
    SELECT s.id AS id FROM "CrmProfileDepartmentState" s
    WHERE s."claimStatus" = 'CLAIMED' AND s."poolEntryReason" IS NOT NULL`;
  add(
    "claimedWithPoolEntryReason",
    "CLAIMED 残留 poolEntryReason",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${claimedResidueSql})`),
    await rawIds(prisma, claimedResidueSql),
  );

  // 10. ACTIVE PoolShare 异常
  const shareIllegalEndpointSql = `
    SELECT sh.id AS id FROM "CrmProfilePoolShare" sh
    WHERE sh."status" = 'ACTIVE'
      AND (sh."sourceDepartment" NOT IN (${LEGAL}) OR sh."targetDepartment" NOT IN (${LEGAL}))`;
  add(
    "poolShareIllegalEndpoint",
    "ACTIVE PoolShare source/target 非法",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${shareIllegalEndpointSql})`),
    await rawIds(prisma, shareIllegalEndpointSql),
  );
  const shareSameDeptSql = `
    SELECT sh.id AS id FROM "CrmProfilePoolShare" sh
    WHERE sh."status" = 'ACTIVE' AND sh."sourceDepartment" = sh."targetDepartment"`;
  add(
    "poolShareSameSourceTarget",
    "ACTIVE PoolShare source=target",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${shareSameDeptSql})`),
    await rawIds(prisma, shareSameDeptSql),
  );
  const shareMissingStateSql = `
    SELECT sh.id AS id FROM "CrmProfilePoolShare" sh
    WHERE sh."status" = 'ACTIVE'
      AND (
        NOT EXISTS (
          SELECT 1 FROM "CrmProfileDepartmentState" s
          WHERE s."profileId" = sh."profileId" AND s."department" = sh."sourceDepartment"
        )
        OR NOT EXISTS (
          SELECT 1 FROM "CrmProfileDepartmentState" s
          WHERE s."profileId" = sh."profileId" AND s."department" = sh."targetDepartment"
        )
      )`;
  add(
    "poolShareMissingState",
    "ACTIVE PoolShare 缺少对应部门 state",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${shareMissingStateSql})`),
    await rawIds(prisma, shareMissingStateSql),
  );
  const shareBadSharedBySql = `
    SELECT sh.id AS id FROM "CrmProfilePoolShare" sh
    LEFT JOIN "User" u ON u.id = sh."sharedByUserId"
    WHERE sh."status" = 'ACTIVE'
      AND (u.id IS NULL OR (u."department" <> sh."sourceDepartment" AND u."role" <> 'ADMIN'))`;
  add(
    "poolShareSharedByNotSourceDept",
    "ACTIVE PoolShare sharedBy 不属于来源部门（非 ADMIN 代操作）",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${shareBadSharedBySql})`),
    await rawIds(prisma, shareBadSharedBySql),
  );

  // 11. Follow-up owner 与记录部门不一致
  const followUpMismatchSql = `
    SELECT t.id AS id FROM "CrmFollowUpTask" t
    LEFT JOIN "User" u ON u.id = t."ownerUserId"
    WHERE u.id IS NULL OR u."department" <> t."departmentSnapshot"`;
  add(
    "followUpOwnerDepartmentMismatch",
    "Follow-up owner 与记录部门不一致",
    await rawCount(prisma, `SELECT COUNT(*) AS c FROM (${followUpMismatchSql})`),
    await rawIds(prisma, followUpMismatchSql),
  );

  return { items, ok: items.every((i) => i.count === 0) };
}
