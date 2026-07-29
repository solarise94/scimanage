import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { centsToYuan } from "@/lib/finance/money";
import { amountToChineseWords } from "./amount-in-words";
import { CONTRACT_CATEGORY } from "./constants";
import { markIntentGenerated, markIntentGeneratedLenient } from "./generation-intent";
import { computeFactDigest, type ContractRenderFacts } from "./fact-digest";
import { contractsUploadRoot } from "./storage";
import fs from "fs/promises";
import path from "path";

export { contractsUploadRoot } from "./storage";

export interface GenerateInput {
  orderIds: string[]; // 关联订单（支持多单）
  templateId: string; // 模板 ID
  sellerProfileId: string; // 开票主体（BillingProfile）
  // 买方可手填覆盖
  buyerNameOverride?: string;
  buyerOrgNameOverride?: string;
  buyerTaxIdOverride?: string;
  buyerAddressOverride?: string;
  buyerPhoneOverride?: string;
  buyerEmailOverride?: string;
  remark?: string;
  /** Agent 生成意图（幂等键）；API 直接调用路径不传，行为不变。 */
  generationIntentId?: string;
  /** 当前执行的 proposalId，用于 intent fencing；Agent 路径传入，须与 generationIntentId 同时提供才生效。 */
  processingProposalId?: string;
  /**
   * Phase E：Agent channel 在最终写事务内复核 technicalOwner（防 TOCTOU）。
   * Web channel 不传。
   */
  agentOwnerRecheck?: {
    actor: { userId: string; role: string };
    invocation: { channel: string; proposalId?: string | null };
  };
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

// buildTemplateData / assertSameBuyer 共用的订单查询 include 形状。
// 抽成常量，确保类型（Prisma.OrderGetPayload）与实际查询严格一致。
// T8.2a 起导出供 prepare-contract-draft application service 复用。
export const CONTRACT_ORDER_INCLUDE = {
  // sortOrder 主序 + id 次序：渲染顺序稳定，且与 fact digest 一致（digest 保留 lines 原始顺序）
  lines: { orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }] },
  profile: { include: { org: true } },
} satisfies Prisma.OrderInclude;

export type ContractOrder = Prisma.OrderGetPayload<{ include: typeof CONTRACT_ORDER_INCLUDE }>;

// 确定排序工具位于 prisma-free 纯模块 ordering.ts（可被测试在 withTempSmokeDb 之外
// 静态导入而不实例化 PrismaClient 单例）；此处再导出保持 prepare-contract-draft 等
// 现有引用方的导入路径不变。
import { sortOrdersByInputIds, PRIMARY_PROJECT_LINK_ORDER_BY } from "./ordering";
export { sortOrdersByInputIds, PRIMARY_PROJECT_LINK_ORDER_BY } from "./ordering";

/** 单个订单的买方身份标识（用于跨订单比较），及展示用 label。 */
function resolveBuyerIdentity(order: ContractOrder): { orderId: string; orderNo: string; key: string; label: string } {
  if (order.buyerOrganizationId) {
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      key: `org:${order.buyerOrganizationId}`,
      label: order.buyerOrgNameSnapshot || order.profile?.org?.canonicalName || order.buyerOrganizationId,
    };
  }
  const profileOrgId = order.profile?.organizationId;
  if (profileOrgId) {
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      key: `org:${profileOrgId}`,
      label: order.profile?.organization || order.profile?.org?.canonicalName || profileOrgId,
    };
  }
  const label = (order.buyerOrgNameSnapshot || order.buyerNameSnapshot || "").trim();
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    key: `name:${label}`,
    label: label || "(未知买方)",
  };
}

/**
 * 多订单同买方校验（docs/agent-bankflow-contract-design-2026-07-23.md §2.3）。
 * 规则（优先级从高到低）：
 * 1. 有 buyerOrganizationId → 直接比较
 * 2. 否则有 profile.organizationId → 比较
 * 3. 否则 buyerOrgNameSnapshot / buyerNameSnapshot 字符串比较（降级）
 * 跨买方 → throw Error，消息以 "CROSS_BUYER_ORDERS:" 开头，附各订单买方标签。
 */
export function assertSameBuyer(orders: ContractOrder[]): void {
  if (orders.length <= 1) return;
  const identities = orders.map(resolveBuyerIdentity);
  const first = identities[0];
  const mismatched = identities.filter((identity) => identity.key !== first.key);
  if (mismatched.length > 0) {
    const detail = identities.map((i) => `${i.orderNo}(${i.label})`).join("、");
    throw new Error(`CROSS_BUYER_ORDERS: 所选订单买方不一致，无法合并生成合同：${detail}`);
  }
}

export interface GenerateOutput {
  contractId: string;
  contractNo: string;
  docxBuffer: Buffer;
}

// buildTemplateData 的结构化返回
interface BuildResult {
  data: Record<string, unknown>; // 传给 docxtemplater 的变量
  totalCents: number; // 合同总金额（分），落库用
  lines: Array<{
    // 明细，落 itemsJson 用
    index: number;
    itemName: string;
    spec: string;
    quantity: number;
    unit: string;
    unitPrice: number; // 分（Int）
    amount: number; // 分（Int）
  }>;
  // 买方快照字段（落 ContractDocument 用）
  buyerName: string;
  buyerOrgName: string;
  buyerTaxId: string;
  buyerAddress: string;
  buyerPhone: string;
  buyerEmail: string;
}

// 1. 组装变量数据（从 Order/Customer/Org/BillingProfile 取值）
async function buildTemplateData(
  orders: ContractOrder[],
  input: GenerateInput,
  contractNo: string,
  signingDate: string,
  sellerProfile: {
    name: string;
    taxId?: string | null;
    bankName?: string | null;
    bankAccount?: string | null;
    address?: string | null;
    phone?: string | null;
    legalRepresentative?: string | null;
  }
): Promise<BuildResult> {
  // 金额合计（财务口径整数分）
  const totalCents = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
  const totalYuan = centsToYuan(totalCents);

  // 行项目（多单时合并所有订单的 lines）
  const lines = orders
    .flatMap((o) => o.lines)
    .map((l, i) => ({
      index: i + 1,
      itemName: l.itemName || "",
      spec: l.spec || "",
      quantity: l.quantity ?? 1,
      unit: l.unit || "",
      unitPrice: l.unitPrice ?? 0, // 分（Int）
      amount: l.amount || 0, // 分（Int）
    }));

  // 卖方（由 preflight 传入，避免重复查询）
  const profile = sellerProfile;

  // 买方：固定取 input.orderIds[0]（用户/模型指定的顺序），而非依赖查询返回顺序
  // （Prisma findMany({ where: { id: { in: [...] } } }) 不保证返回顺序）。
  const primaryOrder = orders.find((o) => o.id === input.orderIds[0]) ?? orders[0];
  const profileCustomer = primaryOrder?.profile;
  const org = profileCustomer?.org;
  const buyerName =
    input.buyerNameOverride ||
    profileCustomer?.name ||
    primaryOrder?.buyerNameSnapshot ||
    "";
  const buyerOrgName =
    input.buyerOrgNameOverride ||
    org?.canonicalName ||
    profileCustomer?.organization ||
    primaryOrder?.buyerOrgNameSnapshot ||
    "";
  const buyerTaxId = input.buyerTaxIdOverride || org?.taxId || "";
  const buyerAddress =
    input.buyerAddressOverride ||
    org?.address ||
    profileCustomer?.address ||
    primaryOrder?.buyerAddressSnapshot ||
    "";
  const buyerPhone =
    input.buyerPhoneOverride || primaryOrder?.buyerPhoneSnapshot || "";
  const buyerEmail = input.buyerEmailOverride || profileCustomer?.email || "";

  // 模板用的行项目（金额格式化为元字符串）
  const linesForTemplate = lines.map((l) => ({
    ...l,
    unitPrice: l.unitPrice ? centsToYuan(l.unitPrice).toFixed(2) : "",
    amount: centsToYuan(l.amount).toFixed(2),
  }));

  // 组装 docxtemplater 数据
  const data: Record<string, unknown> = {
    // 卖方
    sellerName: profile.name,
    sellerTaxId: profile.taxId || "",
    sellerBankName: profile.bankName || "",
    sellerBankAccount: profile.bankAccount || "",
    sellerAddress: profile.address || "",
    sellerPhone: profile.phone || "",
    sellerLegalRepresentative: profile.legalRepresentative || "",
    // 买方
    buyerName,
    buyerOrgName,
    buyerTaxId,
    buyerAddress,
    buyerPhone,
    buyerEmail,
    // 合同主体
    contractNo,
    totalAmount: totalYuan.toFixed(2),
    totalAmountInWords: amountToChineseWords(totalYuan),
    signingDate,
    // 行项目（模板用元字符串）
    lines: linesForTemplate,
  };

  return {
    data,
    totalCents,
    lines,
    buyerName,
    buyerOrgName,
    buyerTaxId,
    buyerAddress,
    buyerPhone,
    buyerEmail,
  };
}

// 2. docxtemplater 填充
function renderDocx(templateBuffer: Buffer, data: Record<string, unknown>): Buffer {
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // 回退空字符串（而非抛错）：避免单个空字段导致整个生成失败
    nullGetter: () => "",
  });
  doc.render(data);
  const buf = doc.getZip().generate({ type: "nodebuffer" });
  return Buffer.from(buf);
}

/** digest 输入的卖方事实形状（preflight 全量 profile 与 tx 内 select 复用）。 */
type FactSeller = {
  id: string;
  name: string;
  taxId: string | null;
  bankName: string | null;
  bankAccount: string | null;
  address: string | null;
  phone: string | null;
  legalRepresentative: string | null;
  archived: boolean;
};

/**
 * 由 buildTemplateData 结果 + 模板/卖方/首单项目事实组装 digest 输入。
 * expected（preflight）与 actual（tx 内重载）共用，避免两处映射漂移。
 */
function buildRenderFacts(
  orderIds: string[],
  built: BuildResult,
  seller: FactSeller,
  template: { category: string; archived: boolean; fileHash: string },
  primaryOrderProjectId: string | null,
): ContractRenderFacts {
  return {
    orderIds,
    lines: built.lines.map((l) => ({
      itemName: l.itemName,
      spec: l.spec,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
    })),
    totalCents: built.totalCents,
    buyer: {
      buyerName: built.buyerName,
      buyerOrgName: built.buyerOrgName,
      buyerTaxId: built.buyerTaxId,
      buyerAddress: built.buyerAddress,
      buyerPhone: built.buyerPhone,
      buyerEmail: built.buyerEmail,
    },
    // 显式挑字段：preflight 传入全量 BillingProfile（含 isDefault/createdAt 等额外字段），
    // tx 内传入 select 的 9 字段；若直接透传对象，JSON.stringify 会因额外字段产生假阳性 mismatch。
    seller: {
      id: seller.id,
      name: seller.name,
      taxId: seller.taxId,
      bankName: seller.bankName,
      bankAccount: seller.bankAccount,
      address: seller.address,
      phone: seller.phone,
      legalRepresentative: seller.legalRepresentative,
      archived: seller.archived,
    },
    template,
    primaryOrderProjectId,
  };
}

// 3. 主流程：preflight → 渲染 → 落库 → 写文件（写失败回滚）
export async function generateContract(
  input: GenerateInput,
  userId: string,
  role: string,
  /** 部门归属；未提供时下游 getOrderScopeWhere 从 DB 实时解析（fail-closed）。 */
  department?: string,
): Promise<GenerateOutput> {
  // ===== Preflight =====
  // 3a. 订单存在性 + deleted 校验（一次性查询，供 assertSameBuyer + buildTemplateData 复用，避免重复查询）。
  // findMany({ id: in }) 不保证返回顺序：sortOrdersByInputIds 按 input.orderIds 重排，
  // 与事务内重载同口径，保证行项目 flatMap 顺序（进入 digest）跨两次查询确定一致（P2 修复）。
  const ordersRaw = await prisma.order.findMany({
    where: { id: { in: input.orderIds }, deleted: false },
    include: CONTRACT_ORDER_INCLUDE,
  });
  if (ordersRaw.length !== input.orderIds.length) {
    throw new Error(`有 ${input.orderIds.length - ordersRaw.length} 个订单不存在或已删除`);
  }
  const orders = sortOrdersByInputIds(ordersRaw, input.orderIds);

  // 3a-2. 同买方校验（在任何写操作之前执行）
  assertSameBuyer(orders);

  // 3b. 模板存在
  const template = await prisma.contractTemplate.findFirst({
    where: { id: input.templateId, archived: false },
  });
  if (!template) throw new Error("模板不存在或已归档");

  // 3c. 开票主体存在且未归档（C7：domain 层也校验 archived，不只靠 application 层）
  const profile = await prisma.billingProfile.findUnique({
    where: { id: input.sellerProfileId },
  });
  if (!profile || profile.archived) throw new Error("开票主体不存在或已归档");

  // 3d. 模板文件可读
  const absTemplatePath = path.join(process.cwd(), "public", template.fileUrl);
  let templateBuffer: Buffer;
  try {
    templateBuffer = await fs.readFile(absTemplatePath);
  } catch {
    throw new Error(`模板文件读取失败：${template.fileUrl}`);
  }

  // ===== 生成合同编号和签订日期 =====
  const now = new Date();
  const contractNo = `HT-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${Date.now().toString(36).toUpperCase()}`;
  const signingDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  // ===== 组装数据 =====
  const built = await buildTemplateData(orders, input, contractNo, signingDate, profile);

  // ===== 渲染 .docx =====
  const docxBuffer = renderDocx(templateBuffer, built.data);

  // 首单关联项目（附件 projectId + digest 事实）；多关联时按 PRIMARY_PROJECT_LINK_ORDER_BY 确定选取（P2 修复）
  const primaryOrderLink = await prisma.orderProjectLink.findFirst({
    where: { orderId: input.orderIds[0] },
    orderBy: PRIMARY_PROJECT_LINK_ORDER_BY,
    select: { projectId: true },
  });

  // 构造权威事实 digest（TOCTOU 防护）：覆盖完整渲染/落库事实（行项/买方/卖方/模板内容/首单项目），
  // 写事务开头用 tx 重载后比较；漂移 -> FACT_DIGEST_MISMATCH -> 回滚 + 清理临时文件 + 要求重新 prepare。
  const expectedTemplateFileHash = createHash("sha256").update(templateBuffer).digest("hex");
  const expectedFactDigest = computeFactDigest(
    buildRenderFacts(
      input.orderIds,
      built,
      profile,
      { category: template.category, archived: template.archived, fileHash: expectedTemplateFileHash },
      primaryOrderLink?.projectId ?? null,
    ),
  );

  // ===== 状态机：先写临时文件 → 单事务落库 → 原子 rename → 标记 READY =====
  // 预生成 contract ID 以构建路径
  const contractId = `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const contractDir = path.join(contractsUploadRoot(), contractId);
  const docxFileName = `${contractNo}.docx`;
  const snapshotFileName = "template-snapshot.docx";
  const tmpDocxPath = path.join(contractDir, `.tmp-${contractId}.docx`);
  const tmpSnapshotPath = path.join(contractDir, `.tmp-template-snapshot.docx`);
  const finalDocxPath = path.join(contractDir, docxFileName);
  const finalSnapshotPath = path.join(contractDir, snapshotFileName);
  const relDir = `/uploads/contracts/${contractId}`;

  // Phase 1: 写临时文件（失败 = 无 DB 副作用，只清理临时文件）
  // 快照直接写自用于渲染的 templateBuffer（消除二次读盘），保证「渲染字节 ≡ 快照字节」恒成立。
  await fs.mkdir(contractDir, { recursive: true });
  try {
    await fs.writeFile(tmpDocxPath, docxBuffer);
    await fs.writeFile(tmpSnapshotPath, templateBuffer);
  } catch (fileErr) {
    await Promise.allSettled([
      fs.rm(tmpDocxPath, { force: true }),
      fs.rm(tmpSnapshotPath, { force: true }),
    ]);
    throw new Error(`合同文件写入失败：${fileErr instanceof Error ? fileErr.message : String(fileErr)}`);
  }

  // Phase 2: 单事务创建所有 DB 记录（status = PENDING_FILE）
  const attachmentKind =
    template.category === CONTRACT_CATEGORY.DELIVERY_NOTE ? "DELIVERY_NOTE" : "CONTRACT";

  try {
    await prisma.$transaction(async (tx) => {
      // 事务内权威授权复核（TOCTOU 防护，P1-1）：按 actor 当前 scope 重新确认全部 orderIds 可见。
      // 口径与 loadOrdersForContractAction 逐字一致；非 ADMIN 失配 -> SCOPE_REVOKED -> Forbidden。
      // ADMIN（scopeWhere null）跳过 scope 复核；软删除/订单缺失由下方 freshOrders
      //（deleted:false + 数量比对）与 digest 兜底 -> FACT_DIGEST_MISMATCH。
      if (role !== "ADMIN") {
        const scopeWhere = await getOrderScopeWhere(userId, role, tx, department);
        if (scopeWhere) {
          const scopedCount = await tx.order.count({
            where: { AND: [scopeWhere, { id: { in: input.orderIds } }, { deleted: false }] },
          });
          if (scopedCount !== input.orderIds.length) {
            throw new Error(
              "SCOPE_REVOKED: 订单访问权限已变化（归属/成员/CRM 权限被撤销或订单被删），请重新调用 contracts.prepare_draft",
            );
          }
        }
      }

      // Phase E：Agent channel 技术负责人最终写事务内复核（防 TOCTOU：pre-check 后 owner 可能被改）。
      if (input.agentOwnerRecheck) {
        const { assertAgentCanWriteOrders } = await import(
          "@/lib/orders/application/technical-owner-gate"
        );
        await assertAgentCanWriteOrders(
          input.agentOwnerRecheck.actor as import("@/lib/application/actor").BusinessActor,
          input.agentOwnerRecheck.invocation as import("@/lib/application/actor").InvocationContext,
          input.orderIds,
          { tx },
        );
      }

      // 事务内完整渲染事实复核（TOCTOU 防护，P1-2）：重载订单/模板/卖方/首单项目，
      // 重建 built 并比较 digest；任一字段漂移 -> FACT_DIGEST_MISMATCH -> Conflict。
      // 必须 AND deleted:false：ADMIN 跳过上方 scope 复核，软删除只能靠此处数量不符兜底。
      const freshOrdersRaw = await tx.order.findMany({
        where: { id: { in: input.orderIds }, deleted: false },
        include: CONTRACT_ORDER_INCLUDE,
      });
      if (freshOrdersRaw.length !== input.orderIds.length) {
        throw new Error(
          "FACT_DIGEST_MISMATCH: 生成事实已变化（订单不存在或已删除），请重新调用 contracts.prepare_draft",
        );
      }
      // 与 preflight 同口径按 input.orderIds 重排（P2 修复）
      const freshOrders = sortOrdersByInputIds(freshOrdersRaw, input.orderIds);
      assertSameBuyer(freshOrders);
      const freshTemplate = await tx.contractTemplate.findUnique({
        where: { id: template.id },
        select: { category: true, archived: true, fileUrl: true },
      });
      if (!freshTemplate || freshTemplate.archived) {
        throw new Error(
          "FACT_DIGEST_MISMATCH: 生成事实已变化（模板不存在或已归档），请重新调用 contracts.prepare_draft",
        );
      }
      let freshTemplateBuffer: Buffer;
      try {
        freshTemplateBuffer = await fs.readFile(path.join(process.cwd(), "public", freshTemplate.fileUrl));
      } catch {
        throw new Error(
          "FACT_DIGEST_MISMATCH: 生成事实已变化（模板文件不可读），请重新调用 contracts.prepare_draft",
        );
      }
      const freshSeller = await tx.billingProfile.findUnique({
        where: { id: profile.id },
        select: {
          id: true,
          name: true,
          taxId: true,
          bankName: true,
          bankAccount: true,
          address: true,
          phone: true,
          legalRepresentative: true,
          archived: true,
        },
      });
      if (!freshSeller || freshSeller.archived) {
        throw new Error(
          "FACT_DIGEST_MISMATCH: 生成事实已变化（卖方不存在或已归档），请重新调用 contracts.prepare_draft",
        );
      }
      const freshPrimaryLink = await tx.orderProjectLink.findFirst({
        where: { orderId: input.orderIds[0] },
        orderBy: PRIMARY_PROJECT_LINK_ORDER_BY,
        select: { projectId: true },
      });
      const freshBuilt = await buildTemplateData(freshOrders, input, contractNo, signingDate, freshSeller);
      const freshTemplateFileHash = createHash("sha256").update(freshTemplateBuffer).digest("hex");
      const actualDigest = computeFactDigest(
        buildRenderFacts(
          input.orderIds,
          freshBuilt,
          freshSeller,
          { category: freshTemplate.category, archived: freshTemplate.archived, fileHash: freshTemplateFileHash },
          freshPrimaryLink?.projectId ?? null,
        ),
      );
      if (actualDigest !== expectedFactDigest) {
        throw new Error(
          "FACT_DIGEST_MISMATCH: 生成事实已变化（订单明细/买方/卖方/模板内容或首单项目），请重新调用 contracts.prepare_draft",
        );
      }

      await tx.contractDocument.create({
        data: {
          id: contractId,
          templateId: template.id,
          snapshotTemplateUrl: `${relDir}/${snapshotFileName}`,
          contractNo,
          sellerName: String(built.data.sellerName),
          sellerTaxId: String(built.data.sellerTaxId || ""),
          sellerBankName: String(built.data.sellerBankName || ""),
          sellerBankAccount: String(built.data.sellerBankAccount || ""),
          sellerAddress: String(built.data.sellerAddress || ""),
          sellerPhone: String(built.data.sellerPhone || ""),
          sellerLegalRepresentative: String(built.data.sellerLegalRepresentative || ""),
          buyerName: built.buyerName,
          buyerOrgName: built.buyerOrgName,
          buyerTaxId: built.buyerTaxId,
          buyerAddress: built.buyerAddress,
          buyerPhone: built.buyerPhone,
          buyerEmail: built.buyerEmail,
          totalAmount: built.totalCents,
          itemsJson: JSON.stringify(built.lines),
          remark: input.remark,
          status: "PENDING_FILE",
          createdById: userId,
          generationIntentId: input.generationIntentId ?? null,
        },
      });
      await tx.orderContractCoverage.createMany({
        data: input.orderIds.map((orderId) => ({ contractId, orderId })),
      });
      await tx.contractAttachment.create({
        data: {
          projectId: primaryOrderLink?.projectId ?? null,
          orderId: input.orderIds.length === 1 ? input.orderIds[0] : null,
          kind: attachmentKind,
          fileName: docxFileName,
          fileUrl: `${relDir}/${docxFileName}`,
          fileSize: docxBuffer.length,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          source: "GENERATED",
          uploadedById: userId,
          contractDocumentId: contractId,
        },
      });
    });
  } catch (dbErr) {
    // DB 事务失败：清理本次尝试写入的临时文件（无孤儿 DB 行）
    await Promise.allSettled([
      fs.rm(tmpDocxPath, { force: true }),
      fs.rm(tmpSnapshotPath, { force: true }),
    ]);

    // generationIntentId 唯一约束冲突（P2002）：说明该 intent 已有合同（claim 阶段本应走
    // 幂等快路径拦截，这里是最后一道兜底）。查已有合同返回，而非报错。
    if (input.generationIntentId && isUniqueConstraintViolation(dbErr)) {
      const existing = await prisma.contractDocument.findUnique({
        where: { generationIntentId: input.generationIntentId },
      });
      if (existing) {
        const resolved =
          existing.status === "PENDING_FILE"
            ? await resumePendingFileContract(existing.id)
            : null;
        const finalContractNo = resolved?.contractNo ?? existing.contractNo;
        const finalStatus = resolved
          ? resolved.outcome === "resumed"
            ? "GENERATED"
            : existing.status
          : existing.status;
        if (finalStatus === "GENERATED") {
          const existingDocxBuffer = await fs.readFile(
            path.join(contractsUploadRoot(), existing.id, `${finalContractNo}.docx`)
          );
          return {
            contractId: existing.id,
            contractNo: finalContractNo,
            docxBuffer: existingDocxBuffer,
          };
        }
      }
    }

    // 保留语义前缀错误（事务内授权/digest 复核抛出）原样上抛，供 mapGenerateContractError
    // 翻译为 Forbidden(403)/Conflict(409)/Validation(400)，而非被「合同落库失败」前缀吞成 500。
    if (dbErr instanceof Error && /^(SCOPE_REVOKED|FACT_DIGEST_MISMATCH|CROSS_BUYER_ORDERS):/.test(dbErr.message)) {
      throw dbErr;
    }

    throw new Error(`合同落库失败：${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
  }

  // Phase 3: 原子 rename 临时文件到最终路径
  try {
    await fs.rename(tmpDocxPath, finalDocxPath);
    await fs.rename(tmpSnapshotPath, finalSnapshotPath);
  } catch (renameErr) {
    // rename 失败：DB 记录保持 PENDING_FILE，可通过 resume 恢复
    console.error("[contracts] rename failed, record stays PENDING_FILE:", renameErr);
    throw new Error(`合同文件归档失败（可重试）：${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
  }

  // Phase 4: 标记 READY
  // Agent 路径（generationIntentId + processingProposalId 均存在）：ContractDocument 状态
  // 与 intent 终态在同一事务内原子写入，intent 更新带 processingProposalId fencing，
  // 防止已被接管的旧 worker 提交错误终态（此时应放弃并交由新 worker/恢复流程处理）。
  // API 直接调用路径（两者皆无）：行为与改造前完全一致，单条 update，无事务开销。
  if (input.generationIntentId && input.processingProposalId) {
    await prisma.$transaction(async (tx) => {
      await tx.contractDocument.update({
        where: { id: contractId },
        data: { status: "GENERATED" },
      });
      const marked = await markIntentGenerated({
        intentId: input.generationIntentId!,
        processingProposalId: input.processingProposalId!,
        tx,
      });
      if (!marked) {
        throw new Error(
          "INTENT_FENCING_FAILED：生成意图已被其他执行接管（fencing 校验失败），本次合同文件已写入但未提交终态，请通过恢复流程核对最终状态后重试"
        );
      }
    });
  } else {
    await prisma.contractDocument.update({
      where: { id: contractId },
      data: { status: "GENERATED" },
    });
  }

  return {
    contractId,
    contractNo,
    docxBuffer,
  };
}

/** 恢复安全窗口：仅处理创建超过 5 分钟的 PENDING_FILE 记录，避免与正在生成的流程竞态。 */
const RECOVERY_TTL_MS = 5 * 60 * 1000;
/** 孤儿目录最小存活时间（1 小时），避免删除未知或正在写入的目录。 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

export type ResumeContractOutcome = {
  outcome: "resumed" | "cleaned" | "skipped";
  contractId: string;
  contractNo?: string;
};

/**
 * 单合同 PENDING_FILE 恢复核心逻辑（幂等）：
 * 1. 优先尝试 resume：临时/staging 文件存在则推进完成 rename → GENERATED
 * 2. 最终文件已就位 → 直接标记 GENERATED（清理残留 tmp/staging）
 * 3. 均不存在 → 清理 DB + 文件（视为已废弃的半成品）
 * 4. 部分推进 / rename 出错 → 保留 PENDING_FILE，返回 skipped，下次重试
 *
 * 标记 GENERATED 时：若 contract.generationIntentId 非空，在同一事务内一并将关联 intent
 * 更新为 GENERATED（markIntentGeneratedLenient：无外部 proposal 上下文，以 intent 自身当前
 * processingProposalId 做 fencing；没有则宽松更新）。
 */
async function recoverContractFiles(contract: {
  id: string;
  contractNo: string;
  generationIntentId?: string | null;
}): Promise<ResumeContractOutcome> {
  const contractDir = path.join(contractsUploadRoot(), contract.id);
  const docxFileName = `${contract.contractNo}.docx`;
  const finalDocxPath = path.join(contractDir, docxFileName);
  const finalSnapshotPath = path.join(contractDir, "template-snapshot.docx");

  const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);

  /**
   * 逐文件状态推进：tmp -> staging -> final
   * 每个文件独立处理，任何部分状态都可重试。
   * rename 是幂等的（如果源不存在说明已经推进过）。
   */
  async function advanceToFinal(
    tmpPath: string,
    stagingPath: string,
    finalPath: string,
  ): Promise<"final" | "missing" | "error"> {
    const finalExists = await exists(finalPath);

    if (finalExists) {
      // final 已就位：清理可能残留的 tmp/staging 文件
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      await fs.rm(stagingPath, { force: true }).catch(() => {});
      return "final";
    }

    // 从当前位置推进
    const tmpExists = await exists(tmpPath);
    const stagingExists = await exists(stagingPath);
    const sourcePath = tmpExists ? tmpPath : (stagingExists ? stagingPath : null);
    if (!sourcePath) return "missing";

    try {
      // 先推到 staging（如果还在 tmp）
      if (tmpExists && !stagingExists) {
        await fs.rename(tmpPath, stagingPath);
      }
      // staging -> final
      if (await exists(stagingPath)) {
        await fs.rename(stagingPath, finalPath);
      }
      return (await exists(finalPath)) ? "final" : "error";
    } catch {
      return "error";
    }
  }

  const docxResult = await advanceToFinal(
    path.join(contractDir, `.tmp-${contract.id}.docx`),
    `${finalDocxPath}.staging`,
    finalDocxPath,
  );
  const snapshotResult = await advanceToFinal(
    path.join(contractDir, ".tmp-template-snapshot.docx"),
    `${finalSnapshotPath}.staging`,
    finalSnapshotPath,
  );

  if (docxResult === "final" && snapshotResult === "final") {
    // 两个最终文件都就位
    if (contract.generationIntentId) {
      await prisma.$transaction(async (tx) => {
        await tx.contractDocument.update({ where: { id: contract.id }, data: { status: "GENERATED" } });
        await markIntentGeneratedLenient(contract.generationIntentId!, tx);
      });
    } else {
      await prisma.contractDocument.update({ where: { id: contract.id }, data: { status: "GENERATED" } });
    }
    return { outcome: "resumed", contractId: contract.id, contractNo: contract.contractNo };
  }

  if (docxResult === "missing" && snapshotResult === "missing") {
    // 两个文件都不存在 -> 确认已废弃，安全清理
    // DB 清理先于文件删除（事务保证一致性；fs.rm 在 commit 后，crash 由孤儿扫描兜底）
    await prisma
      .$transaction(async (tx) => {
        await tx.contractAttachment.deleteMany({ where: { contractDocumentId: contract.id } });
        await tx.orderContractCoverage.deleteMany({ where: { contractId: contract.id } });
        await tx.contractDocument.delete({ where: { id: contract.id } });
      })
      .catch(() => {});
    await fs.rm(contractDir, { recursive: true, force: true }).catch(() => {});
    return { outcome: "cleaned", contractId: contract.id, contractNo: contract.contractNo };
  }

  // 部分推进或 rename 错误 -> 保留 PENDING_FILE，下次重试
  if (docxResult === "error" || snapshotResult === "error") {
    console.error(`[contracts] resume partial for ${contract.id}: docx=${docxResult}, snapshot=${snapshotResult}`);
  }
  return { outcome: "skipped", contractId: contract.id, contractNo: contract.contractNo };
}

/**
 * 恢复单个 PENDING_FILE 合同（幂等，无 TTL 限制——调用方已通过其他信号（如 intent
 * PROCESSING + 关联合同存在）确认应立即恢复，不必等待 RECOVERY_TTL_MS 窗口）。
 * 合同不存在时返回 skipped（无副作用）。
 */
export async function resumePendingFileContract(contractId: string): Promise<ResumeContractOutcome> {
  const contract = await prisma.contractDocument.findUnique({
    where: { id: contractId },
    select: { id: true, contractNo: true, generationIntentId: true },
  });
  if (!contract) {
    return { outcome: "skipped", contractId };
  }
  return recoverContractFiles(contract);
}

/**
 * 批量恢复 PENDING_FILE 状态的合同（幂等）：
 * 1. 仅处理超过 TTL 的记录（防止与生成流程竞态）
 * 2. 逐条复用 recoverContractFiles（resumePendingFileContract 的共享核心）
 * 3. 清理超过 ORPHAN_MIN_AGE 的孤儿目录
 *
 * 接入点：POST /api/internal/contract-recovery/run
 *   - cron: Bearer REMINDER_CRON_TOKEN（systemd timer，参见 deploy-remote-prod.sh）
 *   - 手动: ADMIN session
 */
export async function resumePendingFileContracts(): Promise<{ resumed: number; cleaned: number; skipped: number }> {
  const cutoff = new Date(Date.now() - RECOVERY_TTL_MS);
  const pending = await prisma.contractDocument.findMany({
    where: { status: "PENDING_FILE", createdAt: { lt: cutoff } },
    select: { id: true, contractNo: true, createdAt: true, generationIntentId: true },
  });

  let resumed = 0;
  let cleaned = 0;
  let skipped = 0;

  for (const contract of pending) {
    const result = await recoverContractFiles(contract);
    if (result.outcome === "resumed") resumed += 1;
    else if (result.outcome === "cleaned") cleaned += 1;
    else skipped += 1;
  }

  // 清理孤儿目录（有文件但无 DB 记录，且超过最小存活时间）
  const contractsBase = contractsUploadRoot();
  const dirs = await fs.readdir(contractsBase).catch(() => [] as string[]);
  const knownIds = new Set(
    (await prisma.contractDocument.findMany({ select: { id: true } })).map((c) => c.id),
  );
  const orphanCutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  for (const dir of dirs) {
    if (dir.startsWith(".") || knownIds.has(dir)) continue;
    // 仅删除 ct_ 前缀的目录（本系统生成），避免误删未知目录
    if (!dir.startsWith("ct_")) continue;
    const dirPath = path.join(contractsBase, dir);
    const stat = await fs.stat(dirPath).catch(() => null);
    if (stat?.isDirectory() && stat.mtimeMs < orphanCutoff) {
      await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
      cleaned += 1;
    }
  }

  return { resumed, cleaned, skipped };
}
