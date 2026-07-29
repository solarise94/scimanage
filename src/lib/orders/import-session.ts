/**
 * 订单导入「确认会话」核心库（§6 / §7 / §9）。
 *
 * 负责：列映射重写、把一行标准化订单映射成匹配输入、用统一匹配引擎（Profile-first，
 * 复用 pingoodmice-match 的 in-memory MatchContext）解析三态结论、行状态机常量、
 * 会话摘要聚合。会话创建 / 行确认 / recompute / commit 各 API 都从这里取共享逻辑，
 * 保证确认页匹配口径与匹配扫描口径完全一致。
 */
import type { NormalizedOrderRow } from "@/lib/external-order";
import type { PrismaClient } from "@prisma/client";
import { createMatchContext, resolveMatch, type MatchContext } from "@/lib/finance/pingoodmice-match";
import type { MatchRowResolution } from "@/lib/orders/match-scoring";

export { createMatchContext };
export type { MatchContext, MatchRowResolution };

// ─── 行状态机（与正文 §4 / §6.3 注释一致，勿增减） ───────────────────────────
export const ROW_STATUS = {
  // 解析/标准化失败
  PARSE_FAILED: "PARSE_FAILED",
  DROPPED: "DROPPED", // 被显式剔除的统一终态（§9.1 B）
  // 待确认（阻塞 commit）
  PENDING: "PENDING",
  AUTO_SUGGESTED: "AUTO_SUGGESTED",
  AMBIGUOUS: "AMBIGUOUS",
  NO_MATCH: "NO_MATCH",
  REPRESENTATIVE_MISSING: "REPRESENTATIVE_MISSING",
  // 已确认（决策就绪，可生成 proposal）
  CONFIRMED_EXISTING: "CONFIRMED_EXISTING",
  CONFIRMED_CREATE: "CONFIRMED_CREATE",
  // 顺序导入执行态（§4.3.1）：CONFIRMED_* → PROPOSED → IMPORTING → IMPORTED
  PROPOSED: "PROPOSED", // 唯一 PENDING proposal 已持久化，proposalId 必须非空
  IMPORTING: "IMPORTING", // proposal 已确认，单行事务正在执行（执行租约）
  // 终态
  IMPORTED: "IMPORTED",
  FAILED: "FAILED",
} as const;
export type RowStatus = (typeof ROW_STATUS)[keyof typeof ROW_STATUS];

/** §9.1 A：只要还有这些状态的非剔除行，整批拒绝 commit。 */
export const UNRESOLVED_STATUSES: readonly RowStatus[] = [
  "PENDING",
  "AUTO_SUGGESTED",
  "AMBIGUOUS",
  "NO_MATCH",
  "REPRESENTATIVE_MISSING",
];

/** §7.5：recompute 只刷新这些「未确认」行，绝不覆盖已确认/终态行。 */
export const RECOMPUTABLE_STATUSES: readonly RowStatus[] = [
  "PENDING",
  "AUTO_SUGGESTED",
  "AMBIGUOUS",
  "NO_MATCH",
];

/** §9.1 B：可显式剔除（droppedRowIds）转 DROPPED 的坏行原状态。 */
export const DROPPABLE_STATUSES: readonly RowStatus[] = [
  "PARSE_FAILED",
  "REPRESENTATIVE_MISSING",
  "NO_MATCH",
  "AMBIGUOUS",
  "PENDING",
  "AUTO_SUGGESTED",
];

/** 顺序导入 §4.3.1：尚未完成客户决策的状态。 */
export const PRE_DECISION_STATUSES: readonly RowStatus[] = [
  "PENDING",
  "AUTO_SUGGESTED",
  "AMBIGUOUS",
  "NO_MATCH",
  "REPRESENTATIVE_MISSING",
];

/** 顺序导入 §4.3.1：决策就绪状态，可生成 proposal（prepareImportRow 的合法前置态）。 */
export const DECISION_READY_STATUSES: readonly RowStatus[] = [
  "CONFIRMED_EXISTING",
  "CONFIRMED_CREATE",
];

/** 顺序导入 §4.3.1：行终态。 */
export const ROW_TERMINAL_STATUSES: readonly RowStatus[] = [
  "IMPORTED",
  "DROPPED",
  "FAILED",
  "PARSE_FAILED",
];

/** 顺序导入 §4.3.1：非终态（可用于 skip / 恢复判断）。 */
export const ROW_NON_TERMINAL_STATUSES: readonly RowStatus[] = [
  "PENDING",
  "AUTO_SUGGESTED",
  "AMBIGUOUS",
  "NO_MATCH",
  "REPRESENTATIVE_MISSING",
  "CONFIRMED_EXISTING",
  "CONFIRMED_CREATE",
  "PROPOSED",
  "IMPORTING",
];

export const SESSION_STATUS = {
  DRAFT: "DRAFT",
  REVIEWING: "REVIEWING",
  READY: "READY",
  COMMITTED: "COMMITTED",
  ABORTED: "ABORTED",
  FAILED: "FAILED",
} as const;
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export const SESSION_TERMINAL_STATUSES: readonly SessionStatus[] = ["COMMITTED", "ABORTED", "FAILED"];

export const DECISION_TYPE = {
  USE_SUGGESTION: "USE_SUGGESTION",
  PICK_EXISTING: "PICK_EXISTING",
  CREATE_NEW: "CREATE_NEW",
} as const;
export type DecisionType = (typeof DECISION_TYPE)[keyof typeof DECISION_TYPE];

// ─── 列映射重写（从旧 commit 路由抽取，AI normalize 后的英文字段名 → 中文表头） ───
// AI 输出标准英文字段名；解析器只认中文表头，所以先反向翻译成 ORDER_HEADER_MAP 认识的中文。
const EN_TO_CN: Record<string, string> = {
  source: "所属平台",
  platform: "所属平台",
  externalOrderNo: "订单号",
  merchantOrderNo: "商户单号",
  buyerName: "收件人",
  buyerPhone: "收件人电话",
  buyerWechat: "下单用户",
  buyerCustomerCode: "客户编号",
  customerCode: "客户编号",
  buyerOrgName: "所属门店",
  buyerAddress: "收件人地址",
  buyerMiniProgramId: "小程序ID",
  miniProgramId: "小程序ID",
  productNamesRaw: "全部商品名称",
  itemCount: "商品总件数",
  orderAt: "下单时间",
  paidAt: "付款时间",
  grossAmount: "商品总额",
  priceAdjustment: "订单改价",
  paidAmount: "订单实付金额",
  shippingFee: "运费",
  sellerMessage: "卖家留言",
  merchantRemark: "商家备注",
  rawExtraJson: "备注/表单",
  storeName: "所属门店",
  receiverName: "收件人",
  receiverPhone: "收件人电话",
  receiverAddress: "收件人地址",
  orderUser: "下单用户",
  itemTypeCount: "商品种类数",
  formNote: "备注/表单",
};

/** 用 AI 列映射重写首行表头（无映射时原样返回）。 */
export function applyColumnMapping(rawText: string, columnMapping: Record<string, string> | null | undefined): string {
  if (!columnMapping || Object.keys(columnMapping).length === 0) return rawText;
  const lines = rawText.split(/\r?\n/);
  if (lines.length === 0) return rawText;
  const headerLine = lines[0];
  const isTsv = headerLine.includes("\t") && !headerLine.includes(",");
  const delimiter = isTsv ? "\t" : ",";
  const headers = headerLine.split(delimiter).map((h) => h.trim());
  const mapped = headers.map((h) => {
    const english = columnMapping[h];
    if (!english) return h;
    return EN_TO_CN[english] || english;
  });
  lines[0] = mapped.join(delimiter);
  return lines.join("\n");
}

// ─── 行 → 匹配输入 ───────────────────────────────────────────────────────────
const CUSTOMER_CODE_RAW_KEYS = ["客户编号", "客户编码", "客户号", "客户ID", "CRM客户编号", "CRM客户编码"];

function extractCustomerCodeFromRawJson(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  for (const key of CUSTOMER_CODE_RAW_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const value of Object.values(raw)) {
    if (typeof value !== "string") continue;
    const match = value.match(/KH-\d{3,}/i);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function getRowCustomerCode(row: { customerCode?: string | null; rawJson?: string | null }) {
  return row.customerCode?.trim() || extractCustomerCodeFromRawJson(row.rawJson);
}

/**
 * 把一行标准化订单映射成匹配引擎入参。
 *
 * 与现网 pingoodmice 导入 / commit 路径完全一致：`buyerOrgName` 传 null（storeName 是店铺名
 * 而非买方机构，传入会误命中），由匹配引擎从收货地址抽取机构名。保证确认页匹配 == 扫描匹配。
 */
export function rowMatchParams(row: NormalizedOrderRow) {
  return {
    buyerName: row.receiverName,
    buyerPhone: row.receiverPhone,
    buyerWechat: row.orderUser,
    buyerMiniProgramId: row.miniProgramId,
    buyerCustomerCode: getRowCustomerCode(row),
    buyerOrgName: null,
    buyerAddress: row.receiverAddress,
  };
}

/** 用一次性加载的 MatchContext 解析单行三态结论。 */
export function resolveRowAgainstContext(ctx: MatchContext, row: NormalizedOrderRow): MatchRowResolution {
  return resolveMatch(ctx, rowMatchParams(row));
}

/** resolution.status → 行初始 reviewStatus（§5.3/§5.4）。 */
export function reviewStatusFromResolution(r: MatchRowResolution): RowStatus {
  if (r.status === "AUTO_SUGGESTED") return ROW_STATUS.AUTO_SUGGESTED;
  if (r.status === "AMBIGUOUS") return ROW_STATUS.AMBIGUOUS;
  return ROW_STATUS.NO_MATCH;
}

// ─── 摘要聚合 ────────────────────────────────────────────────────────────────
export interface SessionSummary {
  rowCount: number;
  pending: number;
  autoSuggested: number;
  ambiguous: number;
  noMatch: number;
  representativeMissing: number;
  parseFailed: number;
  confirmed: number; // CONFIRMED_EXISTING + CONFIRMED_CREATE
  imported: number;
  dropped: number;
  failed: number;
  /** 仍阻塞 commit 的行数（UNRESOLVED_STATUSES + PARSE_FAILED 未剔除）。 */
  unresolved: number;
}

export function summarizeRows(rows: Array<{ reviewStatus: string }>): SessionSummary {
  const s: SessionSummary = {
    rowCount: rows.length,
    pending: 0,
    autoSuggested: 0,
    ambiguous: 0,
    noMatch: 0,
    representativeMissing: 0,
    parseFailed: 0,
    confirmed: 0,
    imported: 0,
    dropped: 0,
    failed: 0,
    unresolved: 0,
  };
  for (const r of rows) {
    switch (r.reviewStatus) {
      case ROW_STATUS.PENDING: s.pending++; break;
      case ROW_STATUS.AUTO_SUGGESTED: s.autoSuggested++; break;
      case ROW_STATUS.AMBIGUOUS: s.ambiguous++; break;
      case ROW_STATUS.NO_MATCH: s.noMatch++; break;
      case ROW_STATUS.REPRESENTATIVE_MISSING: s.representativeMissing++; break;
      case ROW_STATUS.PARSE_FAILED: s.parseFailed++; break;
      case ROW_STATUS.CONFIRMED_EXISTING:
      case ROW_STATUS.CONFIRMED_CREATE: s.confirmed++; break;
      // PROPOSED / IMPORTING 是 CONFIRMED_* 之后的执行租约态（§4.3.1），
      // 客户决策已就绪，不阻塞 commit，也不计入 unresolved。
      case ROW_STATUS.PROPOSED:
      case ROW_STATUS.IMPORTING: s.confirmed++; break;
      case ROW_STATUS.IMPORTED: s.imported++; break;
      case ROW_STATUS.DROPPED: s.dropped++; break;
      case ROW_STATUS.FAILED: s.failed++; break;
    }
  }
  // 阻塞 commit：未确认行 + 未剔除的 PARSE_FAILED
  s.unresolved = s.pending + s.autoSuggested + s.ambiguous + s.noMatch + s.representativeMissing + s.parseFailed;
  return s;
}

/** 从 normalizedPayloadJson 投影确认页要展示的买方字段（容错 parse）。 */
export interface RowDisplayPayload {
  buyerName: string | null;
  buyerPhone: string | null;
  buyerWechat: string | null;
  buyerMiniProgramId: string | null;
  buyerCustomerCode: string | null;
  buyerOrgName: string | null;
  buyerAddress: string | null;
  externalOrderNo: string | null;
  title: string | null;
}

export function projectRowDisplay(normalizedPayloadJson: string): RowDisplayPayload {
  let row: Partial<NormalizedOrderRow> = {};
  try {
    row = JSON.parse(normalizedPayloadJson) as Partial<NormalizedOrderRow>;
  } catch {
    row = {};
  }
  return {
    buyerName: row.receiverName ?? null,
    buyerPhone: row.receiverPhone ?? null,
    buyerWechat: row.orderUser ?? null,
    buyerMiniProgramId: row.miniProgramId ?? null,
    buyerCustomerCode: getRowCustomerCode(row),
    buyerOrgName: row.storeName ?? null,
    buyerAddress: row.receiverAddress ?? null,
    externalOrderNo: row.externalOrderNo ?? null,
    title: row.productNamesRaw ?? null,
  };
}

type HealDb = Pick<PrismaClient, "orderImportRow" | "crmCustomerProfile" | "orderImportSession"> & {
  $transaction?: PrismaClient["$transaction"];
};

/**
 * W6.2c：历史 CONFIRMED_EXISTING 行可能缺 confirmedProfileId。
 * 仅允许在非终态会话的写路径调用（如 commit 前）；GET 只读路径禁止调用。
 * COMMITTED / ABORTED / FAILED 直接 no-op，避免查看或误调用改写审计。
 * Profile-only：decisionType=USE_SUGGESTION 且 suggestedProfileId 仍指向活动 Profile 时，
 * 直接回填 confirmedProfileId=suggestedProfileId（该决策语义即「采纳建议」）；
 * 其余（无建议 / 建议已失效 / 旧 PICK_EXISTING 锚点行）降为 AMBIGUOUS 并写明原因。
 * 多行更新在同一事务内执行，避免半愈合。
 */
export async function healLegacyConfirmedImportRows(
  sessionId: string,
  db: HealDb,
): Promise<{ backfilled: number; demoted: number }> {
  const sess = await db.orderImportSession.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!sess) return { backfilled: 0, demoted: 0 };
  if (SESSION_TERMINAL_STATUSES.includes(sess.status as SessionStatus)) {
    return { backfilled: 0, demoted: 0 };
  }

  const stale = await db.orderImportRow.findMany({
    where: {
      sessionId,
      reviewStatus: ROW_STATUS.CONFIRMED_EXISTING,
      confirmedProfileId: null,
    },
    select: { id: true, decisionType: true, suggestedProfileId: true },
  });
  if (stale.length === 0) return { backfilled: 0, demoted: 0 };

  const suggestedIds = [
    ...new Set(
      stale
        .filter((r) => r.decisionType === DECISION_TYPE.USE_SUGGESTION)
        .map((r) => r.suggestedProfileId)
        .filter((id): id is string => !!id),
    ),
  ];
  const activeProfiles =
    suggestedIds.length > 0
      ? await db.crmCustomerProfile.findMany({
          where: {
            id: { in: suggestedIds },
            deleted: false,
            archived: false,
          },
          select: { id: true },
        })
      : [];
  const activeIds = new Set(activeProfiles.map((p) => p.id));

  type RowPatch =
    | { id: string; kind: "backfill"; confirmedProfileId: string }
    | { id: string; kind: "demote"; finalError: string };

  const patches: RowPatch[] = [];
  for (const row of stale) {
    if (
      row.decisionType === DECISION_TYPE.USE_SUGGESTION &&
      row.suggestedProfileId &&
      activeIds.has(row.suggestedProfileId)
    ) {
      patches.push({ id: row.id, kind: "backfill", confirmedProfileId: row.suggestedProfileId });
    } else {
      patches.push({
        id: row.id,
        kind: "demote",
        finalError: "历史确认缺少有效 Profile（旧 Customer 锚点已停用），请重新确认客户",
      });
    }
  }

  const applyPatches = async (client: Pick<PrismaClient, "orderImportRow">) => {
    let backfilled = 0;
    let demoted = 0;
    for (const patch of patches) {
      if (patch.kind === "backfill") {
        await client.orderImportRow.update({
          where: { id: patch.id },
          data: {
            confirmedProfileId: patch.confirmedProfileId,
            finalError: null,
          },
        });
        backfilled += 1;
      } else {
        await client.orderImportRow.update({
          where: { id: patch.id },
          data: {
            reviewStatus: ROW_STATUS.AMBIGUOUS,
            decisionType: null,
            confirmedProfileId: null,
            finalError: patch.finalError,
          },
        });
        demoted += 1;
      }
    }
    return { backfilled, demoted };
  };

  // 顶层 PrismaClient 用事务包住；若已是 TransactionClient 则直接顺序写（外层事务已保证原子性）。
  if (typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => applyPatches(tx));
  }
  return applyPatches(db);
}
