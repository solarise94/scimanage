/**
 * P0-4 测试：4 条 preview→confirm 断链修复。
 *
 * 覆盖（docs/agent-public-surface-cleanup-plan-2026-07-26.md §五 P0-4）：
 *  - 项目开票（propose_invoice 项目路径）：plan_* 后 submit_* 产 PENDING proposal；空计划不产 proposal。
 *  - 合同生成（prepare_contract）：prepare_draft 后 generate 产 PENDING proposal；preview 不写 ContractDocument。
 *  - 发票登记（propose_invoice_registration）：analyze EXACT 唯一匹配自动产 register proposal；多候选不产。
 *  - 拜访签到（propose_visit_checkin）：prepare 落 DRAFT intent（checkinId）；create 消费该 checkinId 完成。
 *  - 通用：preview 不写业务表；proposal 内容展示最终目标（title/summary 含关键实体）；confirm 后只写一次。
 *  - 文案回归：4 个 facade 的 modelFacing 文本不含 internal action key（finance./contracts./crm. 前缀）。
 *
 * OCR 通过 vi.mock 注入固定 extract 结果，避免真实 GLM HTTP 依赖。
 * 全部场景共享单个 withTempSmokeDb 临时库。
 * ⚠️ 顶层 type-only import + vi.mock。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { PrismaClient } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";

// ── mock OCR：注入固定 extract 结果，避免真实 GLM HTTP ──
// ocrInvoiceBuffer 内部调用 parseDocumentWithGlmOcr（在 glm-ocr-client.ts，跨文件 mock）。
// 我们改写 parseDocumentWithGlmOcr 返回结构化 rawText，让 extractInvoiceFields 解析出固定字段。
// rawText 用「键: 值」格式，与 extractInvoiceFields 的正则匹配。
const ocrReturn = vi.hoisted(() => ({
  current: null as null | {
    invoiceNumber: string | null;
    issuedAt: string | null;
    buyerName: string | null;
    buyerTaxId: string | null;
    sellerName: string | null;
    sellerTaxId: string | null;
    invoiceType: "NORMAL" | "SPECIAL" | "UNKNOWN";
    totalAmountCents: number | null;
    isRedInvoice: boolean | null;
  },
}));

vi.mock("@/lib/finance/glm-ocr-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/finance/glm-ocr-client")>();
  return {
    ...actual,
    parseDocumentWithGlmOcr: async () => {
      const c = ocrReturn.current;
      if (!c) throw new Error("ocrReturn.current not set in test");
      // 构造 rawText：extractInvoiceFields 用正则解析这些字段（见 invoice-ocr.ts）。
      // 票种/红字通过关键词检测；税号需「购买方 ... 纳税人识别号 ...」结构。
      const typeKeyword =
        c.invoiceType === "SPECIAL" ? "增值税专用发票" : c.invoiceType === "NORMAL" ? "增值税普通发票" : "";
      const redKeyword = c.isRedInvoice === true ? "红字发票" : "";
      const yuanStr = c.totalAmountCents != null ? (c.totalAmountCents / 100).toFixed(2) : "";
      const lines = [
        typeKeyword,
        redKeyword,
        c.invoiceNumber ? `发票号码: ${c.invoiceNumber}` : "",
        c.issuedAt ? `开票日期: ${c.issuedAt.replace(/-(\d{2})-(\d{2})/, "年$1月$2日")}` : "",
        c.buyerName ? `购买方名称: ${c.buyerName}` : "",
        c.buyerTaxId ? `购买方 纳税人识别号: ${c.buyerTaxId}` : "",
        c.sellerName ? `销售方名称: ${c.sellerName}` : "",
        c.sellerTaxId ? `销售方 纳税人识别号: ${c.sellerTaxId}` : "",
        yuanStr ? `价税合计: ¥${yuanStr}` : "",
      ].filter(Boolean);
      return {
        rawText: lines.join("\n"),
        truncated: false,
      };
    },
  };
});

/**
 * P1-3 适配：channel="agent" 的 proposal 创建现在必须消费 AgentUserConfirmationEvent
 * （P1-3 allowProposal 门；门行为由 tests/allow-proposal-events.test.ts 独立覆盖）。
 * 注意：prepare_visit_checkin 仅在 agent channel 持久化 DRAFT intent（Web channel 不创建），
 * 因此本测试必须保留 agent channel，并在创建 proposal 前为对应 confirm actionKey 颁发事件。
 * 见 seedConfirmationEvent helper。
 */
const agentInv = (over: Partial<{ agentRunId: string }> = {}) => ({
  channel: "agent" as const,
  ...(over.agentRunId ? { agentRunId: over.agentRunId } : {}),
});

/**
 * 为 agent channel 的 proposal 创建颁发可信确认事件（P1-3 门）。
 * targetIntent 必须与 confirm actionKey 一致（createAgentProposal 用 action.key 作 targetIntent）。
 * idempotencyKey 每次唯一，避免 unique 冲突。
 */
let p13EventSeed = 0;
function seedConfirmationEvent(
  prisma: PrismaClient,
  opts: { actorUserId: string; agentRunId: string; targetIntent: string },
): Promise<unknown> {
  p13EventSeed += 1;
  return prisma.agentUserConfirmationEvent.create({
    data: {
      actorUserId: opts.actorUserId,
      agentRunId: opts.agentRunId,
      targetIntent: opts.targetIntent,
      action: "create_proposal",
      idempotencyKey: `p13-seed-${process.pid}-${p13EventSeed}-${Date.now()}`,
    },
  });
}

/** 构造最小合法 docx（zip），用于合同模板渲染。与 web-agent-parity.test.ts 同源。 */
async function buildTestDocx(placeholders: string[]): Promise<Buffer> {
  const { default: PizZip } = await import("pizzip");
  const zip = new PizZip();
  const bodyText = placeholders.join(" ");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">${bodyText}</w:t></w:r></w:p></w:body>
</w:document>`;
  zip.file("word/document.xml", docXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  return Buffer.from(zip.generate({ type: "nodebuffer" }));
}

describe("P0-4 preview→confirm 断链修复", () => {
  it("project invoice / contract / invoice-registration / visit-checkin end-to-end + text regression", async () => {
    // 隔离 invoice staging 存储 + 合同输出目录（process-level env，在 prisma 单例 import 前）
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-phase-c3-"));
    const origInvoiceStaging = process.env.INVOICE_STAGING_DIR;
    const origContractUploads = process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
    const origZhipu = process.env.ZHIPU_API_KEY;
    process.env.INVOICE_STAGING_DIR = path.join(tempRoot, "invoice-staging");
    process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = path.join(tempRoot, "contract-uploads");
    process.env.ZHIPU_API_KEY = "test-key";
    await fs.mkdir(process.env.INVOICE_STAGING_DIR, { recursive: true });
    await fs.mkdir(process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR, { recursive: true });

    try {
      await withTempSmokeDb(async () => {
        const { prisma } = await import("@/lib/prisma");
        const { hashSync } = await import("bcryptjs");
        const { executePublicTool, __clearPublicFacadeRegistryForTests } = await import(
          "@/lib/agent-actions/public/public-executor"
        );
        const { __resetPublicReadFacadesForTests, registerPublicReadFacades } = await import(
          "@/lib/agent-actions/public/facades"
        );
        const { ensureBuiltinAgentActionsRegistered } = await import("@/lib/agent-actions/registry");
        const { confirmAgentProposal } = await import("@/lib/agent-actions/proposals");

        __clearPublicFacadeRegistryForTests();
        __resetPublicReadFacadesForTests();
        ensureBuiltinAgentActionsRegistered();
        registerPublicReadFacades();

        const admin = await prisma.user.create({
          data: { email: "c3-admin@t.test", name: "C3Admin", password: hashSync("x", 4), role: "ADMIN" },
        });
        const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };

        // ────────────────────────────────────────────────────────────────────
        // 1. 项目开票（propose_invoice 项目路径）：plan→submit 产 PENDING proposal
        // ────────────────────────────────────────────────────────────────────
        {
          const org = await prisma.organization.create({
            data: {
              orgCode: "C3-INV-ORG",
              canonicalName: "项目开票单位",
              normalizedName: "项目开票单位",
              isInvoiceSubject: true,
              taxId: "91110000000000091X",
            },
          });
          const seller = await prisma.billingProfile.create({
            data: { name: "C3销方", taxId: "91110000000000092X", isDefault: true },
          });
          const project = await prisma.project.create({
            data: { name: "C3项目", projectNo: "C3-P1", technicalOwnerUserId: admin.id },
          });
          const order = await prisma.order.create({
            data: {
              orderNo: "C3-ORD-1",
              title: "测序服务",
              status: "CONFIRMED",
              totalAmount: 50_000,
              createdById: admin.id,
              technicalOwnerUserId: admin.id,
              financeTreatment: "STANDALONE",
              buyerOrganizationId: org.id,
              lines: { create: [{ itemName: "测序服务", amount: 50_000, sortOrder: 0 }] },
            },
          });
          await prisma.orderProjectLink.create({ data: { orderId: order.id, projectId: project.id } });

          const invoicesBefore = await prisma.externalOrderInvoiceRequest.count();

          // P1-3 门：为 agent channel 的 submit_invoice_request proposal 颁发事件。
          await seedConfirmationEvent(prisma, {
            actorUserId: admin.id,
            agentRunId: "c3-invoice",
            targetIntent: "finance.submit_invoice_request",
          });

          // preview（plan）→ submit 产 PENDING proposal
          // invoiceType 由用户/模型明示（plan 默认会问），传 NORMAL 让计划就绪。
          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-invoice" }),
            publicToolKey: "propose_invoice",
            publicInput: { projectId: project.id, invoiceType: "NORMAL" },
          });
          expect(outcome.ok, `propose_invoice failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
          if (!outcome.ok) throw new Error(`propose_invoice failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            plan?: { status?: string; plans?: unknown[] };
            proposal?: { id?: string; title?: string; summary?: string };
            mode?: string;
            nextStep?: string;
          };
          expect(facing.proposal?.id).toBeTruthy();
          expect(facing.mode).toBe("proposal");
          // proposal title 含订单号（展示最终目标）
          const submitTitle = String(facing.proposal?.title ?? "");
          expect(submitTitle).toContain("C3-ORD-1");

          // preview 不写业务表（开票申请/coverage 无新行）
          expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore);
          expect(await prisma.orderInvoiceCoverage.count()).toBe(0);

          // PENDING proposal 落库
          const stored = await prisma.agentProposal.findUnique({ where: { id: facing.proposal!.id! } });
          expect(stored?.status).toBe("PENDING");
          expect(stored?.actionKey).toBe("finance.submit_invoice_request");
          expect(stored?.publicToolKey).toBe("propose_invoice");

          // confirm 后只写一次：开票申请 +1，coverage 1 条
          await confirmAgentProposal(
            { actor: adminActor, invocation: agentInv({ agentRunId: "c3-invoice" }) },
            facing.proposal!.id!,
          );
          expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore + 1);
          expect(await prisma.orderInvoiceCoverage.count()).toBe(1);
          const confirmed = await prisma.agentProposal.findUnique({ where: { id: facing.proposal!.id! } });
          expect(confirmed?.status).toBe("CONFIRMED");

          // 文案回归：面向用户/模型的文本（title/summary/nextStep）无 internal action key。
          // 注意：proposal.actionKey 是路由元数据（卡片按它 dispatch），不属于「文案」，
          // 不在断言范围内（否则会误伤必要的内部路由字段）。
          const userText = [
            facing.proposal?.title,
            facing.proposal?.summary,
            facing.nextStep,
          ].filter((x): x is string => typeof x === "string").join(" || ");
          expect(userText).not.toMatch(/finance\.(submit_invoice_request|plan_project_invoice_requests|register_issued_invoice|analyze_invoice_file)/);
          expect(userText).not.toMatch(/contracts\.(generate|prepare_draft)/);
          expect(userText).not.toMatch(/crm\.(create_visit_checkin|prepare_visit_checkin)/);
        }

        // ────────────────────────────────────────────────────────────────────
        // 1b. 项目开票：空计划（无可开票订单）不产 proposal
        // ────────────────────────────────────────────────────────────────────
        {
          const emptyProject = await prisma.project.create({
            data: { name: "C3空项目", projectNo: "C3-P-EMPTY", technicalOwnerUserId: admin.id },
          });
          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-invoice-empty" }),
            publicToolKey: "propose_invoice",
            publicInput: { projectId: emptyProject.id },
          });
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw new Error(`empty plan failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as { proposal?: { id?: string }; needsUserInput?: boolean; nextStep?: string };
          expect(facing.proposal?.id).toBeFalsy();
          expect(outcome.result.needsUserInput).toBe(true);
          // 无新 PENDING proposal
          const pending = await prisma.agentProposal.findFirst({
            where: { userId: admin.id, actionKey: "finance.submit_invoice_request", status: "PENDING" },
          });
          expect(pending).toBeNull();
        }

        // ────────────────────────────────────────────────────────────────────
        // 1c. 项目开票：多张可执行计划 → needs_selection（plans 含 planKey）；不产 proposal
        // ────────────────────────────────────────────────────────────────────
        let multiPlanKeyFor1d = "";
        let multiProjectIdFor1d = "";
        {
          const orgA = await prisma.organization.create({
            data: {
              orgCode: "C3-MULTI-ORGA",
              canonicalName: "多计划购方A",
              normalizedName: "多计划购方A",
              isInvoiceSubject: true,
              taxId: "91110000000000093X",
            },
          });
          const orgB = await prisma.organization.create({
            data: {
              orgCode: "C3-MULTI-ORGB",
              canonicalName: "多计划购方B",
              normalizedName: "多计划购方B",
              isInvoiceSubject: true,
              taxId: "91110000000000094X",
            },
          });
          // 复用场景 1 已建的 isDefault 销方（共享临时库）；无需新建。
          const multiProject = await prisma.project.create({
            data: { name: "C3多计划项目", projectNo: "C3-P-MULTI", technicalOwnerUserId: admin.id },
          });
          multiProjectIdFor1d = multiProject.id;
          const orderA = await prisma.order.create({
            data: {
              orderNo: "C3-MULTI-1",
              title: "测序服务A",
              status: "CONFIRMED",
              totalAmount: 30_000,
              createdById: admin.id,
              technicalOwnerUserId: admin.id,
              financeTreatment: "STANDALONE",
              buyerOrganizationId: orgA.id,
              lines: { create: [{ itemName: "测序服务A", amount: 30_000, sortOrder: 0 }] },
            },
          });
          const orderB = await prisma.order.create({
            data: {
              orderNo: "C3-MULTI-2",
              title: "测序服务B",
              status: "CONFIRMED",
              totalAmount: 40_000,
              createdById: admin.id,
              technicalOwnerUserId: admin.id,
              financeTreatment: "STANDALONE",
              buyerOrganizationId: orgB.id,
              lines: { create: [{ itemName: "测序服务B", amount: 40_000, sortOrder: 0 }] },
            },
          });
          await prisma.orderProjectLink.create({ data: { orderId: orderA.id, projectId: multiProject.id } });
          await prisma.orderProjectLink.create({ data: { orderId: orderB.id, projectId: multiProject.id } });

          // 首次 plan：2 张可执行计划 → needs_selection
          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-invoice-multi" }),
            publicToolKey: "propose_invoice",
            publicInput: { projectId: multiProject.id, invoiceType: "NORMAL" },
          });
          expect(outcome.ok, `multi-plan propose failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
          if (!outcome.ok) throw new Error(`multi-plan propose failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            plan?: { plans?: Array<{ planKey: string; mainOrderId: string }> };
            plans?: Array<{ planKey: string; mainOrderId: string; buyerOrganizationName: string; totalAmountCents: number }>;
            proposal?: { id?: string };
            needsSelection?: boolean;
            optionType?: string;
            nextStep?: string;
          };
          expect(facing.proposal?.id).toBeFalsy();
          expect(outcome.result.needsSelection).toBe(true);
          expect(outcome.result.optionType).toBe("invoice_plan");
          // nextStep 文案引导用户用 planKey 重新调用，且不含 internal action key
          expect(facing.nextStep ?? "").toContain("planKey");
          // plans 列表每项含 planKey + mainOrderId + buyerOrganizationName + totalAmountCents
          const plans = facing.plans ?? [];
          expect(plans.length).toBe(2);
          for (const p of plans) {
            expect(typeof p.planKey).toBe("string");
            expect(p.planKey.length).toBeGreaterThan(0);
            expect(typeof p.mainOrderId).toBe("string");
            expect(typeof p.buyerOrganizationName).toBe("string");
            expect(typeof p.totalAmountCents).toBe("number");
          }
          multiPlanKeyFor1d = plans[0].planKey;
        }

        // ────────────────────────────────────────────────────────────────────
        // 1d. 项目开票：用户选定 planKey 后重调 → 命中产 PENDING proposal
        // ────────────────────────────────────────────────────────────────────
        {
          // P1-3 门：为 agent channel 的 submit proposal 颁发事件
          await seedConfirmationEvent(prisma, {
            actorUserId: admin.id,
            agentRunId: "c3-invoice-multi",
            targetIntent: "finance.submit_invoice_request",
          });
          const invoicesBefore1d = await prisma.externalOrderInvoiceRequest.count();

          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-invoice-multi" }),
            publicToolKey: "propose_invoice",
            publicInput: { projectId: multiProjectIdFor1d, invoiceType: "NORMAL", planKey: multiPlanKeyFor1d },
          });
          expect(outcome.ok, `planKey submit failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
          if (!outcome.ok) throw new Error(`planKey submit failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            planKey?: string;
            proposal?: { id?: string; title?: string };
            mode?: string;
            nextStep?: string;
          };
          expect(facing.proposal?.id).toBeTruthy();
          expect(facing.mode).toBe("proposal");
          expect(facing.planKey).toBe(multiPlanKeyFor1d);
          // preview 不写业务表
          expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore1d);
          // PENDING proposal 落库
          const stored = await prisma.agentProposal.findUnique({ where: { id: facing.proposal!.id! } });
          expect(stored?.status).toBe("PENDING");
          expect(stored?.actionKey).toBe("finance.submit_invoice_request");
          // 文案无 internal action key
          const userText = [facing.proposal?.title, facing.nextStep].filter((x): x is string => typeof x === "string").join(" || ");
          expect(userText).not.toMatch(/finance\.(submit_invoice_request|plan_project_invoice_requests)/);
        }

        // ────────────────────────────────────────────────────────────────────
        // 1e. 项目开票：planKey 失效（计划集变化）→ needs_input 报错且附最新计划
        // ────────────────────────────────────────────────────────────────────
        {
          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-invoice-multi-stale" }),
            publicToolKey: "propose_invoice",
            // 用一个不存在的 planKey（plan-99 永远不会出现）
            publicInput: { projectId: multiProjectIdFor1d, invoiceType: "NORMAL", planKey: "plan-99" },
          });
          expect(outcome.ok, `stale planKey failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
          if (!outcome.ok) throw new Error(`stale planKey failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            error?: string;
            plans?: Array<{ planKey: string }>;
            needsSelection?: boolean;
            nextStep?: string;
            proposal?: { id?: string };
          };
          expect(facing.proposal?.id).toBeFalsy();
          expect(facing.error ?? "").toContain("已变化或不存在");
          // 附最新可执行计划
          expect((facing.plans ?? []).length).toBe(2);
          expect(outcome.result.needsSelection).toBe(true);
          expect(facing.nextStep ?? "").toContain("planKey");
        }

        // ────────────────────────────────────────────────────────────────────
        // 2. 合同生成（prepare_contract）：prepare→generate 产 PENDING proposal
        // ────────────────────────────────────────────────────────────────────
        {
          const seller = await prisma.billingProfile.create({ data: { name: "C3合同销方" } });
          const profile = await prisma.crmCustomerProfile.create({
            data: { name: "C3合同客户", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
          });
          const order = await prisma.order.create({
            data: {
              orderNo: "C3-CT-1",
              title: "合同订单",
              status: "CONFIRMED",
              totalAmount: 100_000,
              category: "SERVICE",
              profileId: profile.id,
              buyerNameSnapshot: "李四",
              createdById: admin.id,
              technicalOwnerUserId: admin.id,
              lines: { create: [{ itemName: "测序服务", quantity: 1, unitPrice: 100_000, amount: 100_000, sortOrder: 0 }] },
            },
          });
          // 模板 docx 文件（generate execute 会渲染模板）
          const templatesDir = path.join(process.cwd(), "public", "uploads", "contract-templates", "c3-test");
          await fs.mkdir(templatesDir, { recursive: true });
          const fileUrl = "/uploads/contract-templates/c3-test/template.docx";
          const template = await prisma.contractTemplate.create({
            data: { name: "C3模板", category: "SEQUENCING", fileName: "c3.docx", fileUrl, createdById: admin.id, isDefault: true },
          });
          const abs = path.join(process.cwd(), "public", fileUrl);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, await buildTestDocx(["{sellerName}", "{buyerName}", "{contractNo}", "{totalAmount}"]));

          const docsBefore = await prisma.contractDocument.count();

          // P1-3 门：为 agent channel 的 contracts.generate proposal 颁发事件。
          await seedConfirmationEvent(prisma, {
            actorUserId: admin.id,
            agentRunId: "c3-contract",
            targetIntent: "contracts.generate",
          });

          // preview（prepare_draft）→ generate 产 PENDING proposal
          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-contract" }),
            publicToolKey: "prepare_contract",
            publicInput: { orderIds: [order.id] },
          });
          expect(outcome.ok, `prepare_contract failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
          if (!outcome.ok) throw new Error(`prepare_contract failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            preview?: { draft?: { generationIntentId?: string; template?: { name?: string } } };
            proposal?: { id?: string; title?: string; summary?: string };
            mode?: string;
            nextStep?: string;
          };
          expect(facing.preview?.draft?.generationIntentId).toBeTruthy();
          expect(facing.proposal?.id).toBeTruthy();
          expect(facing.mode).toBe("proposal");
          // proposal title/summary 展示最终目标（模板名/合同关键词）
          const title = String(facing.proposal?.title ?? "");
          const summary = String(facing.proposal?.summary ?? "");
          expect(title).toContain("C3模板");
          expect(summary).toContain("合同");

          // preview 不写业务表（ContractDocument 无新行）
          expect(await prisma.contractDocument.count()).toBe(docsBefore);

          // PENDING proposal 落库
          const stored = await prisma.agentProposal.findUnique({ where: { id: facing.proposal!.id! } });
          expect(stored?.status).toBe("PENDING");
          expect(stored?.actionKey).toBe("contracts.generate");
          expect(stored?.publicToolKey).toBe("prepare_contract");

          // confirm 后只写一次：ContractDocument +1
          await confirmAgentProposal(
            { actor: adminActor, invocation: agentInv({ agentRunId: "c3-contract" }) },
            facing.proposal!.id!,
          );
          expect(await prisma.contractDocument.count()).toBe(docsBefore + 1);

          // 清理模板文件目录
          await fs.rm(templatesDir, { recursive: true, force: true }).catch(() => undefined);

          // 文案回归：面向用户/模型的文本无 internal action key（proposal.actionKey 是路由元数据，不计）。
          const userText2 = [
            facing.proposal?.title,
            facing.proposal?.summary,
            facing.nextStep,
          ].filter((x): x is string => typeof x === "string").join(" || ");
          expect(userText2).not.toMatch(/contracts\.(generate|prepare_draft)/);
          expect(userText2).not.toMatch(/finance\.(submit_invoice_request|register_issued_invoice)/);
        }

        // ────────────────────────────────────────────────────────────────────
        // 3. 发票登记（propose_invoice_registration）：EXACT 唯一匹配 → register proposal
        // ────────────────────────────────────────────────────────────────────
        {
          const org = await prisma.organization.create({
            data: {
              orgCode: "C3-REG-ORG",
              canonicalName: "登记单位",
              normalizedName: "登记单位",
              isInvoiceSubject: true,
              taxId: "91110000000000081X",
            },
          });
          const seller = await prisma.billingProfile.create({
            data: { name: "C3登记销方", taxId: "91110000000000082X", isDefault: true },
          });
          const order = await prisma.order.create({
            data: {
              orderNo: "C3-REG-1",
              title: "登记订单",
              status: "CONFIRMED",
              totalAmount: 30_000,
              createdById: admin.id,
              technicalOwnerUserId: admin.id,
              financeTreatment: "STANDALONE",
              buyerOrganizationId: org.id,
              lines: { create: [{ itemName: "服务", amount: 30_000, sortOrder: 0 }] },
            },
          });
          // 提前提交一张 REQUESTED 开票申请，作为 OCR 匹配目标
          const { submitInvoiceRequestForActor } = await import("@/lib/finance/application/submit-invoice-request");
          const invoice = await submitInvoiceRequestForActor(adminActor, {
            mainOrderId: order.id,
            coverageAllocations: [{ orderId: order.id, amountCents: 30_000 }],
            sellerProfileId: seller.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            invoiceType: "NORMAL",
            items: [{ itemName: "服务", amountCents: 30_000 }],
          });

          // 上传 invoice staging（私有 staging），拿 stagingFileId + sha256 + version
          const { createInvoiceStagingFile } = await import("@/lib/finance/invoice-staging");
          const buffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
          const staging = await createInvoiceStagingFile({
            createdById: admin.id,
            originalFileName: "c3-invoice.pdf",
            declaredMime: "application/pdf",
            buffer,
          });

          // 注入 OCR 结果：与 REQUESTED 申请金额/票号一致 → EXACT 唯一匹配
          ocrReturn.current = {
            invoiceNumber: "C3-REG-001",
            issuedAt: "2026-07-20",
            buyerName: org.canonicalName,
            buyerTaxId: org.taxId,
            sellerName: seller.name,
            sellerTaxId: seller.taxId,
            invoiceType: "NORMAL",
            totalAmountCents: 30_000,
            isRedInvoice: false,
          };

          const invoicesBefore = await prisma.externalOrderInvoiceRequest.count();

          // P1-3 门：为 agent channel 的 register_issued_invoice proposal 颁发事件。
          await seedConfirmationEvent(prisma, {
            actorUserId: admin.id,
            agentRunId: "c3-reg",
            targetIntent: "finance.register_issued_invoice",
          });

          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-reg" }),
            publicToolKey: "propose_invoice_registration",
            publicInput: {
              attachmentId: staging.id,
            },
          });
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw new Error(`propose_invoice_registration EXACT failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            analysis?: { match?: { status?: string } };
            proposal?: { id?: string; title?: string; summary?: string };
            mode?: string;
          };
          expect(facing.analysis?.match?.status).toBe("EXACT");
          expect(facing.proposal?.id).toBeTruthy();
          expect(facing.mode).toBe("proposal");
          // proposal title 含发票号（normalizeInvoiceNumber 去除分隔符）
          expect(String(facing.proposal?.title ?? "")).toContain("C3REG001");

          // preview 不写业务表（发票申请状态未变）
          expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore);
          const unchanged = await prisma.externalOrderInvoiceRequest.findUnique({ where: { id: invoice.invoice.id } });
          expect(unchanged?.status).toBe("REQUESTED");

          const stored = await prisma.agentProposal.findUnique({ where: { id: facing.proposal!.id! } });
          expect(stored?.status).toBe("PENDING");
          expect(stored?.actionKey).toBe("finance.register_issued_invoice");
          expect(stored?.publicToolKey).toBe("propose_invoice_registration");

          // confirm 后只写一次：发票状态 REQUESTED→ISSUED
          await confirmAgentProposal(
            { actor: adminActor, invocation: agentInv({ agentRunId: "c3-reg" }) },
            facing.proposal!.id!,
          );
          const after = await prisma.externalOrderInvoiceRequest.findUnique({ where: { id: invoice.invoice.id } });
          expect(after?.status).toBe("ISSUED");
        }

        // ────────────────────────────────────────────────────────────────────
        // 3b. 发票登记：多候选（AMBIGUOUS）不产 proposal
        // ────────────────────────────────────────────────────────────────────
        {
          const org = await prisma.organization.create({
            data: {
              orgCode: "C3-AMB-ORG",
              canonicalName: "歧义单位",
              normalizedName: "歧义单位",
              isInvoiceSubject: true,
              taxId: "91110000000000071X",
            },
          });
          const seller = await prisma.billingProfile.create({
            data: { name: "C3歧义销方", taxId: "91110000000000072X", isDefault: true },
          });
          const mkOrder = async (orderNo: string) => {
            const o = await prisma.order.create({
              data: {
                orderNo,
                title: `歧义订单 ${orderNo}`,
                status: "CONFIRMED",
                totalAmount: 20_000,
                createdById: admin.id,
                technicalOwnerUserId: admin.id,
                financeTreatment: "STANDALONE",
                buyerOrganizationId: org.id,
                lines: { create: [{ itemName: "服务", amount: 20_000, sortOrder: 0 }] },
              },
            });
            return o;
          };
          const orderA = await mkOrder("C3-AMB-1");
          const orderB = await mkOrder("C3-AMB-2");
          const { submitInvoiceRequestForActor } = await import("@/lib/finance/application/submit-invoice-request");
          // 两张同金额申请 → matcher 多候选
          await submitInvoiceRequestForActor(adminActor, {
            mainOrderId: orderA.id,
            coverageAllocations: [{ orderId: orderA.id, amountCents: 20_000 }],
            sellerProfileId: seller.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            invoiceType: "NORMAL",
            items: [{ itemName: "服务", amountCents: 20_000 }],
          });
          await submitInvoiceRequestForActor(adminActor, {
            mainOrderId: orderB.id,
            coverageAllocations: [{ orderId: orderB.id, amountCents: 20_000 }],
            sellerProfileId: seller.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            invoiceType: "NORMAL",
            items: [{ itemName: "服务", amountCents: 20_000 }],
          });

          const { createInvoiceStagingFile } = await import("@/lib/finance/invoice-staging");
          // 不同 buffer（不同 sha256），避免与 EXACT 用例的 staging 撞 hash → DUPLICATE。
          const buffer = Buffer.concat([Buffer.from("%PDF-1.4\nambiguity\n"), Buffer.alloc(64, 0x21)]);
          const staging = await createInvoiceStagingFile({
            createdById: admin.id,
            originalFileName: "c3-amb.pdf",
            declaredMime: "application/pdf",
            buffer,
          });

          // OCR：金额 20000，买方匹配同 org（两张申请都属同 org）→ AMBIGUOUS。
          // 注意：发票号必须与前序用例不同，否则 findDuplicateByInvoiceNumber 命中 REQUESTED/ISSUED → DUPLICATE。
          ocrReturn.current = {
            invoiceNumber: "C3-AMB-777",
            issuedAt: "2026-07-20",
            buyerName: org.canonicalName,
            buyerTaxId: org.taxId,
            sellerName: seller.name,
            sellerTaxId: seller.taxId,
            invoiceType: "NORMAL",
            totalAmountCents: 20_000,
            isRedInvoice: false,
          };

          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-amb" }),
            publicToolKey: "propose_invoice_registration",
            publicInput: {
              attachmentId: staging.id,
            },
          });
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw new Error(`ambiguous analyze failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            analysis?: { match?: { status?: string; candidates?: unknown[] } };
            proposal?: { id?: string };
          };
          // 多候选：不产 proposal，needsSelection
          expect(facing.proposal?.id).toBeFalsy();
          expect(outcome.result.needsSelection).toBe(true);
          expect(outcome.result.optionType).toBe("invoice_request");
          // 无新 PENDING register proposal
          const pending = await prisma.agentProposal.findFirst({
            where: { userId: admin.id, actionKey: "finance.register_issued_invoice", status: "PENDING" },
          });
          expect(pending).toBeNull();
        }

        // ────────────────────────────────────────────────────────────────────
        // 4. 拜访签到（propose_visit_checkin）：prepare 落 DRAFT intent（checkinId）
        // ────────────────────────────────────────────────────────────────────
        {
          const profile = await prisma.crmCustomerProfile.create({
            data: { name: "C3签到客户", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
          });

          const checkinsBefore = await prisma.crmVisitCheckin.count();

          // prepare_visit_checkin 经 facade → 落一条 DRAFT intent
          const outcome = await executePublicTool({
            actor: adminActor,
            invocation: agentInv({ agentRunId: "c3-checkin" }),
            publicToolKey: "propose_visit_checkin",
            publicInput: { customerId: profile.id },
          });
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw new Error(`propose_visit_checkin failed: ${JSON.stringify(outcome)}`);
          const facing = outcome.result.modelFacing as {
            preparation?: { checkinId?: string; customerName?: string };
            checkinId?: string | null;
            nextStep?: string;
          };
          expect(facing.checkinId).toBeTruthy();
          expect(facing.preparation?.checkinId).toBe(facing.checkinId);

          // preview 落了 DRAFT（intent，非业务终态）：DRAFT +1，COMPLETED 数仍为 0
          expect(await prisma.crmVisitCheckin.count()).toBe(checkinsBefore + 1);
          const drafts = await prisma.crmVisitCheckin.findMany({
            where: { profileId: profile.id, userId: admin.id, status: "DRAFT" },
          });
          expect(drafts.length).toBe(1);
          expect(drafts[0].lat).toBeNull();
          expect(drafts[0].completedAt).toBeNull();
          const interactionsBefore = await prisma.crmInteraction.count({ where: { type: "VISIT" } });

          // create_visit_checkin 经 proposal 链消费该 checkinId → COMPLETED
          const { createAgentProposal } = await import("@/lib/agent-actions/proposals");
          // P1-3 门：为 agent channel 的 create_visit_checkin proposal 颁发事件。
          await seedConfirmationEvent(prisma, {
            actorUserId: admin.id,
            agentRunId: "c3-checkin",
            targetIntent: "crm.create_visit_checkin",
          });
          const proposal = await createAgentProposal(
            { actor: adminActor, invocation: agentInv({ agentRunId: "c3-checkin" }) },
            "crm.create_visit_checkin",
            {
              profileId: profile.id,
              checkinId: facing.checkinId,
              lat: 31.2304,
              lng: 121.4737,
              accuracy: 10,
              capturedAt: new Date().toISOString(),
            },
          );
          await confirmAgentProposal(
            { actor: adminActor, invocation: agentInv({ agentRunId: "c3-checkin" }) },
            proposal.id,
          );

          // 终态：DRAFT 行被消费为 COMPLETED（不再新增行）
          const completed = await prisma.crmVisitCheckin.findUnique({ where: { id: facing.checkinId! } });
          expect(completed?.status).toBe("COMPLETED");
          expect(completed?.lat).toBe(31.2304);
          expect(completed?.completedAt).not.toBeNull();
          // VISIT interaction 落库（业务终态写）+1
          expect(await prisma.crmInteraction.count({ where: { type: "VISIT" } })).toBe(interactionsBefore + 1);
          // 总签到行数不变（DRAFT 复用，未重复创建）
          expect(await prisma.crmVisitCheckin.count()).toBe(checkinsBefore + 1);

          // 文案回归：面向用户/模型的文本无 internal action key。
          const userText4 = [facing.nextStep].filter((x): x is string => typeof x === "string").join(" || ");
          expect(userText4).not.toMatch(/crm\.(create_visit_checkin|prepare_visit_checkin)/);
        }
      });
    } finally {
      // 恢复 env + 清理临时目录
      if (origInvoiceStaging === undefined) delete process.env.INVOICE_STAGING_DIR;
      else process.env.INVOICE_STAGING_DIR = origInvoiceStaging;
      if (origContractUploads === undefined) delete process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
      else process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = origContractUploads;
      if (origZhipu === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origZhipu;
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
