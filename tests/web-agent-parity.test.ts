import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import PizZip from "pizzip";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { PrismaClient } from "@prisma/client";
import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

/**
 * T9.2 Web/Agent 跨渠道 parity smoke。
 *
 * 每个场景使用两套等价 fixture（*W / *A 后缀），分别从 Web 通道（canonical
 * *ForActor service + invocation channel:"web"）与 Agent 通道（生产确认链
 * createAgentProposal → confirmAgentProposal，channel:"agent"）执行同一业务
 * 命令，断言：
 *  - 正式主表结果等价（状态/金额/关键快照字段），每渠道恰好落库一份（零重复）
 *  - 副作用等价（ActivityLog / Notification / nextFollowUpAt）
 *  - 审计差异仅限渠道：Agent 多 AgentActionLog（PROPOSED + CONFIRMED_EXECUTED
 *    均挂 proposalId），Web 无
 *  - 错误语义等价（领域错误 vs Agent 映射错误，HTTP 含义一致）
 *
 * Agent 通道的 confirm action 一律走完整 proposal 链（live actor 刷新、
 * PENDING→PROCESSING claim、冻结输入、proposalId 幂等/审计、lifecycle），
 * 不直调 executeAgentAction({allowConfirm})——那是 confirm 链内部实现细节。
 * Web 通道的 route-level HTTP 映射由 tests/web-route-mapping.test.ts 覆盖。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（prisma 全局单例不跨 withTempSmokeDb
 * 重置，与既有测试文件 1:1 惯例一致）；场景间用独立 fixture + delta 断言隔离。
 *
 * ⚠️ 顶层只允许 type-only import：任何运行时 import 传递依赖 @/lib/prisma
 * 的模块都会在 withTempSmokeDb 之前实例化全局单例，把写入钉死到真实 dev.db。
 */

/**
 * P1-3 适配：channel="agent" 的 proposal 创建现在必须消费 AgentUserConfirmationEvent
 * （P1-3 allowProposal 门；门行为由 tests/allow-proposal-events.test.ts 独立覆盖）。
 * 本测试保留 agent channel（与生产确认链路径一致），并：
 *  - 为每个 actor 预创建一个 AgentRun（agentRunId 贯穿 invocation，符合 fail-closed 要求）；
 *  - 通过 agentCreateProposal 包装器在每次 createAgentProposal 前为对应 actionKey 颁发事件。
 */
const agentRunByUserId = new Map<string, string>();

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent", agentRunId: agentRunByUserId.get(actor.userId) ?? null },
});

/** 在 agent channel 创建 proposal 前为对应 confirm actionKey 颁发事件（P1-3 门）。 */
let p13EventSeed = 0;
async function agentCreateProposal(
  prisma: PrismaClient,
  createAgentProposalFn: typeof import("@/lib/agent-actions/proposals").createAgentProposal,
  actor: BusinessActor,
  actionKey: string,
  input: unknown,
) {
  const agentRunId = agentRunByUserId.get(actor.userId);
  if (!agentRunId) {
    throw new Error(`[test] agentRun not seeded for actor ${actor.userId}`);
  }
  p13EventSeed += 1;
  await prisma.agentUserConfirmationEvent.create({
    data: {
      actorUserId: actor.userId,
      agentRunId,
      targetIntent: actionKey,
      action: "create_proposal",
      idempotencyKey: `p13-parity-${process.pid}-${p13EventSeed}-${Date.now()}`,
    },
  });
  return createAgentProposalFn(agentExecCtx(actor), actionKey, input);
}

const TEMPLATES_DIR = path.join(process.cwd(), "public", "uploads", "contract-templates", "parity-test");
/**
 * 合同文件根经 env 注入为进程专属临时目录（contractsUploadRoot() 运行时读取）：
 * 测试永不触碰真实 public/uploads/contracts，afterEach 整体删除也只影响自己。
 * 后缀区分其他同样注入的测试文件（即使共 worker 进程也不互删）。
 */
const TEST_CONTRACTS_DIR = path.join(os.tmpdir(), `scimanage-contracts-parity-${process.pid}`);
const CONTRACT_UPLOADS_DIR_BEFORE = process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
const CONTRACTS_BASE = TEST_CONTRACTS_DIR;

function buildTestDocx(placeholders: string[]): Buffer {
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

/**
 * 清理安全：合同文件只写进程专属临时根（TEST_CONTRACTS_DIR，env 注入），
 * afterEach 整体删除只影响本测试自己——永不扫描/删除真实 contracts 目录。
 * （旧「目录名快照」方案的快照在回调内赋值，临时库初始化失败会让快照为空，
 * 把真实 contracts 根下所有目录当本测试新建删除。）
 */
beforeEach(() => {
  process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = TEST_CONTRACTS_DIR;
});

afterEach(async () => {
  await fs.rm(TEMPLATES_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(TEST_CONTRACTS_DIR, { recursive: true, force: true }).catch(() => {});
  // 恢复原值：全局 env 不能泄漏给同 worker 进程后续加载的其他测试文件
  if (CONTRACT_UPLOADS_DIR_BEFORE === undefined) {
    delete process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
  } else {
    process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = CONTRACT_UPLOADS_DIR_BEFORE;
  }
});

describe("T9.2 Web/Agent parity smoke", () => {
  it("7 业务场景双渠道等价 + 4 失败模式", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction, listAgentActions } = await import("@/lib/agent-actions/registry");
      const { createAgentProposal, confirmAgentProposal } = await import("@/lib/agent-actions/proposals");
      const { createOrderForActor } = await import("@/lib/orders/application/create-order");
      const { createProjectForActor } = await import("@/lib/projects/application/create-project");
      const { createTicketForActor } = await import("@/lib/tickets/application/create-ticket");
      const { replyToTicketForActor } = await import("@/lib/tickets/application/reply-ticket");
      const { createFollowUpTaskForActor } = await import("@/lib/crm/application/create-followup-task");
      const { submitInvoiceRequestForActor } = await import("@/lib/finance/application/submit-invoice-request");
      const { createReceiptForActor } = await import("@/lib/finance/application/create-receipt");
      const { prepareContractDraftForActor } = await import("@/lib/contracts/application/prepare-contract-draft");
      const { generateContractForActor } = await import("@/lib/contracts/application/generate-contract");
      const { ForbiddenError } = await import("@/lib/application/errors");
      const { AgentActionForbiddenError, AgentActionConflictError } = await import("@/lib/agent-actions/errors");

      const web = buildInvocationContext({ channel: "web" });
      const mkUser = (email: string, name: string, role: string) =>
        prisma.user.create({ data: { email, name, password: "h", role } });
      const asActor = (u: { id: string; email: string; name: string; role: string }): BusinessActor => ({
        userId: u.id,
        role: u.role,
        name: u.name,
        email: u.email,
      });

      const admin = asActor(await mkUser("parity-admin@example.com", "Admin", "ADMIN"));
      const user = asActor(await mkUser("parity-user@example.com", "员工", "USER"));
      const rep = asActor(await mkUser("parity-rep@example.com", "Rep", "REPRESENTATIVE"));

      // P1-3 门：为每个 actor 预创建 AgentRun（agentRunId 贯穿 invocation）。
      for (const actor of [admin, user, rep]) {
        const run = await prisma.agentRun.create({
          data: { userId: actor.userId, role: actor.role, status: "ACTIVE", source: "CHAT" },
        });
        agentRunByUserId.set(actor.userId, run.id);
      }

      /**
       * P1-2：confirm action 的 Agent 通道走生产确认链 createAgentProposal →
       * confirmAgentProposal（live actor 刷新、PENDING→PROCESSING 原子 claim、
       * 冻结输入、proposalId 幂等与审计、lifecycle persist/revert），并断言
       * proposal 终态与 proposalId 审计链（PROPOSED + CONFIRMED_EXECUTED）。
       */
      async function confirmViaProposal<T>(
        actor: BusinessActor,
        actionKey: string,
        input: unknown,
      ): Promise<{ result: T; proposalId: string }> {
        const proposal = await agentCreateProposal(prisma, createAgentProposal, actor, actionKey, input);
        const confirmed = await confirmAgentProposal(agentExecCtx(actor), proposal.id);
        const row = await prisma.agentProposal.findUniqueOrThrow({ where: { id: proposal.id } });
        expect(row.status).toBe("CONFIRMED");
        expect(row.resultJson).not.toBeNull();
        expect(row.decidedAt).not.toBeNull();
        // proposalId 审计链：创建时 PROPOSED，执行时 CONFIRMED_EXECUTED，均挂 proposalId
        expect(await prisma.agentActionLog.count({ where: { proposalId: proposal.id, status: "PROPOSED" } })).toBe(1);
        expect(await prisma.agentActionLog.count({ where: { proposalId: proposal.id, status: "CONFIRMED_EXECUTED" } })).toBe(1);
        return { result: confirmed.result as T, proposalId: proposal.id };
      }

      // ── S1 orders.create：订单主表/行项/活动日志等价 ──────────────────────
      {
        const profileW = await prisma.crmCustomerProfile.create({ data: { name: "订单客户-W", ownerUserId: admin.userId } });
        const profileA = await prisma.crmCustomerProfile.create({ data: { name: "订单客户-A", ownerUserId: admin.userId } });
        // Phase 1 review #2：新业务订单必须绑定 SKU。seed 一个供两渠道共用。
        const parityProduct = await prisma.product.create({
          data: {
            productCode: "PRD-000001",
            name: "单细胞测序",
            kind: "SERVICE",
            status: "ACTIVE",
            createdById: admin.userId,
            skus: {
              create: [{
                skuCode: "SKU-000001",
                name: "单细胞测序",
                standardUnit: "样本",
                sellable: true,
                purchasable: true,
                status: "ACTIVE",
                createdById: admin.userId,
              }],
            },
          },
          include: { skus: true },
        });
        const paritySkuId = parityProduct.skus[0].id;
        const logsBefore = await prisma.agentActionLog.count();
        // 同一输入（agent adapter 只暴露 title/profileId/lines，status 不开放
        // 覆盖——两渠道用相同默认归一化路径，结果必须一致）
        const input = (profileId: string, title: string) => ({
          title,
          profileId,
          moneyUnit: "yuan" as const,
          lines: [{ itemName: "单细胞测序", amount: 100, productSkuId: paritySkuId }],
        });

        const ordersBefore = await prisma.order.count();
        const webResult = await createOrderForActor(admin, web, input(profileW.id, "parity 订单 W"));
        const agentResult = await confirmViaProposal<{ order: { id: string } }>(
          admin,
          "orders.create",
          input(profileA.id, "parity 订单 A"),
        );
        // 正式表零重复：两渠道各恰好落库一单
        expect(await prisma.order.count()).toBe(ordersBefore + 2);

        const orderW = await prisma.order.findUniqueOrThrow({ where: { id: webResult.order.id }, include: { lines: true } });
        const orderA = await prisma.order.findUniqueOrThrow({ where: { id: agentResult.result.order.id }, include: { lines: true } });
        expect(orderA.status).toBe(orderW.status);
        expect(orderA.totalAmount).toBe(orderW.totalAmount);
        expect(orderA.lines.length).toBe(orderW.lines.length);
        expect(orderA.lines[0]?.itemName).toBe(orderW.lines[0]?.itemName);
        expect(orderA.lines[0]?.amount).toBe(orderW.lines[0]?.amount);
        // 审计差异仅限渠道：Agent 确认链新增恰好 2 条 AgentActionLog
        // （PROPOSED + CONFIRMED_EXECUTED），Web 无
        expect(await prisma.agentActionLog.count()).toBe(logsBefore + 2);
      }

      // ── S2 projects.create：项目/OWNER 成员/活动日志等价 ──────────────────
      {
        const projectsBefore = await prisma.project.count();
        const webResult = await createProjectForActor(user, web, { name: "parity 项目 W", budgetAmount: 10 });
        const agentResult = await confirmViaProposal<{ project: { id: string } }>(
          user,
          "projects.create",
          { name: "parity 项目 A", budgetAmount: 10 },
        );
        // 正式表零重复：两渠道各恰好落库一个项目
        expect(await prisma.project.count()).toBe(projectsBefore + 2);
        const projW = await prisma.project.findUniqueOrThrow({ where: { id: webResult.project.id } });
        const projA = await prisma.project.findUniqueOrThrow({ where: { id: agentResult.result.project.id } });
        expect(projA.status).toBe(projW.status);
        expect(projA.budgetAmount).toBe(projW.budgetAmount);
        expect(projA.budgetAmountSource).toBe(projW.budgetAmountSource);
        expect(projA.techSupport).toBe(projW.techSupport);
        const memberW = await prisma.projectMember.findFirst({ where: { projectId: projW.id, userId: user.userId } });
        const memberA = await prisma.projectMember.findFirst({ where: { projectId: projA.id, userId: user.userId } });
        expect(memberA?.role).toBe(memberW?.role);
        expect(!!await prisma.activityLog.findFirst({ where: { projectId: projA.id, type: "PROJECT_CREATED" } }))
          .toBe(!!await prisma.activityLog.findFirst({ where: { projectId: projW.id, type: "PROJECT_CREATED" } }));
      }

      // ── S3 tickets.reply：回复/活动日志/创建者通知等价 ────────────────────
      {
        const mkTicket = async (title: string) => {
          const project = await prisma.project.create({ data: { name: `工单项目 ${title}` } });
          await prisma.projectMember.create({ data: { projectId: project.id, userId: user.userId, role: "MEMBER" } });
          const { ticket } = await createTicketForActor(admin, web, { projectId: project.id, title, priority: "MEDIUM" });
          return ticket;
        };
        const ticketW = await mkTicket("parity 工单 W");
        const ticketA = await mkTicket("parity 工单 A");

        const notifBefore = await prisma.notification.count();
        const repliesBefore = await prisma.ticketReply.count();
        const replyW = await replyToTicketForActor(user, web, { ticketId: ticketW.id, content: "Web 渠道回复" });
        const notifAfterWeb = await prisma.notification.count();
        const replyA = await confirmViaProposal<{ reply: { id: string } }>(
          user,
          "tickets.reply",
          { ticketId: ticketA.id, content: "Agent 渠道回复" },
        );
        const notifAfterAgent = await prisma.notification.count();
        // 正式表零重复：两渠道各恰好一条回复
        expect(await prisma.ticketReply.count()).toBe(repliesBefore + 2);

        const rowW = await prisma.ticketReply.findUniqueOrThrow({ where: { id: replyW.reply.id } });
        const rowA = await prisma.ticketReply.findUniqueOrThrow({ where: { id: replyA.result.reply.id } });
        expect(rowA.authorId).toBe(rowW.authorId);
        // 创建者(ADMIN) ≠ 回复者(USER)：两渠道各产生 1 条创建者通知
        expect(notifAfterWeb - notifBefore).toBe(1);
        expect(notifAfterAgent - notifAfterWeb).toBe(1);
        expect(await prisma.activityLog.count({ where: { projectId: ticketA.projectId, type: "TICKET_UPDATED" } }))
          .toBe(await prisma.activityLog.count({ where: { projectId: ticketW.projectId, type: "TICKET_UPDATED" } }));
      }

      // ── S4 crm.create_followup_task：任务/nextFollowUpAt 等价 ─────────────
      {
        const profileW = await prisma.crmCustomerProfile.create({ data: { name: "跟进客户 W", ownerUserId: admin.userId } });
        const profileA = await prisma.crmCustomerProfile.create({ data: { name: "跟进客户 A", ownerUserId: admin.userId } });
        const dueAt = new Date(Date.now() + 86_400_000).toISOString();

        const tasksBefore = await prisma.crmFollowUpTask.count();
        const webResult = await createFollowUpTaskForActor(admin, web, { profileId: profileW.id, title: "parity 跟进 W", dueAt });
        const agentResult = await confirmViaProposal<{ task: { id: string } }>(
          admin,
          "crm.create_followup_task",
          { profileId: profileA.id, title: "parity 跟进 A", dueAt },
        );
        // 正式表零重复：两渠道各恰好一条跟进任务
        expect(await prisma.crmFollowUpTask.count()).toBe(tasksBefore + 2);
        const taskW = await prisma.crmFollowUpTask.findUniqueOrThrow({ where: { id: webResult.task.id } });
        const taskA = await prisma.crmFollowUpTask.findUniqueOrThrow({ where: { id: agentResult.result.task.id } });
        expect(taskA.status).toBe(taskW.status);
        expect(taskA.ownerUserId).toBe(taskW.ownerUserId);
        expect(taskA.taskType).toBe(taskW.taskType);
        const profW = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: profileW.id } });
        const profA = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: profileA.id } });
        expect(profA.nextFollowUpAt?.getTime()).toBe(profW.nextFollowUpAt?.getTime());
      }

      // ── S5 finance.submit_invoice_request：开票申请/覆盖行等价 ────────────
      {
        const org = await prisma.organization.create({
          data: { orgCode: "PARITY-INV-ORG", canonicalName: "开票单位", normalizedName: "开票单位", isInvoiceSubject: true },
        });
        const seller = await prisma.billingProfile.create({ data: { name: "开票销方" } });
        const mkOrder = (orderNo: string) =>
          prisma.order.create({
            data: { orderNo, title: `开票订单 ${orderNo}`, status: "CONFIRMED", totalAmount: 100_000, buyerOrganizationId: org.id, createdById: admin.userId, technicalOwnerUserId: admin.userId },
          });
        const orderW = await mkOrder("PARITY-INV-W");
        const orderA = await mkOrder("PARITY-INV-A");
        // agent adapter 要求 coverageAllocations 非空（Web 服务允许空=自动全覆盖），
        // 两渠道用同一显式分配输入保证归一化路径一致
        const submitInput = (mainOrderId: string) => ({
          mainOrderId,
          coverageAllocations: [{ orderId: mainOrderId, amountCents: 50_000 }],
          sellerProfileId: seller.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: "开票单位",
          invoiceType: "NORMAL" as const,
          items: [{ itemName: "测序服务", amountCents: 50_000 }],
        });

        const invoicesBefore = await prisma.externalOrderInvoiceRequest.count();
        const webResult = await submitInvoiceRequestForActor(admin, submitInput(orderW.id));
        const agentResult = await confirmViaProposal<{ invoice: { id: string } }>(
          admin,
          "finance.submit_invoice_request",
          submitInput(orderA.id),
        );
        // 正式表零重复：两渠道各恰好一条开票申请（serialByUser 串行键不阻止顺序创建）
        expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore + 2);
        const invW = await prisma.externalOrderInvoiceRequest.findUniqueOrThrow({ where: { id: webResult.invoice.id } });
        const invA = await prisma.externalOrderInvoiceRequest.findUniqueOrThrow({ where: { id: agentResult.result.invoice.id } });
        expect(invA.status).toBe(invW.status);
        expect(invA.totalAmount).toBe(invW.totalAmount);
        expect(await prisma.orderInvoiceCoverage.count({ where: { invoiceRequestId: invA.id } }))
          .toBe(await prisma.orderInvoiceCoverage.count({ where: { invoiceRequestId: invW.id } }));
      }

      // ── S6 finance.create_receipt：回款/核销行/发票终态等价（全额核销） ──
      {
        const org = await prisma.organization.create({
          data: { orgCode: "PARITY-RCPT-ORG", canonicalName: "回款单位", normalizedName: "回款单位" },
        });
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "回款客户", ownerUserId: admin.userId } });
        const mkInvoiceFixture = async (orderNo: string) => {
          const order = await prisma.order.create({
            data: {
              orderNo, title: `回款订单 ${orderNo}`, status: "CONFIRMED",
              totalAmount: 80_000, profileId: profile.id, buyerOrganizationId: org.id, createdById: admin.userId, technicalOwnerUserId: admin.userId,
            },
          });
          const invoice = await prisma.externalOrderInvoiceRequest.create({
            data: {
              orderId: order.id,
              status: "ISSUED",
              totalAmount: 80_000,
              buyerOrganizationId: org.id,
              buyerOrganizationName: "回款单位",
              createdById: admin.userId,
            },
          });
          await prisma.orderInvoiceCoverage.create({ data: { invoiceRequestId: invoice.id, orderId: order.id, amount: 80_000 } });
          return invoice;
        };
        const invoiceW = await mkInvoiceFixture("PARITY-RCPT-W");
        const invoiceA = await mkInvoiceFixture("PARITY-RCPT-A");
        // 两渠道 adapter 字段命名不同（agent: amount/receivedAt，web 服务:
        // amountYuan），归一化后应落到同一 canonical 命令
        const webInput = (invoiceId: string) => ({
          amountYuan: 800,
          organizationId: org.id,
          allocations: [{ invoiceId, amountYuan: 800 }],
        });
        const agentInput = (invoiceId: string) => ({
          amount: 800,
          receivedAt: new Date().toISOString(),
          organizationId: org.id,
          allocations: [{ invoiceId, amount: 800 }],
        });

        const receiptsBefore = await prisma.financeReceipt.count();
        const webResult = await createReceiptForActor(admin, webInput(invoiceW.id), { invocation: web });
        const agentResult = await confirmViaProposal<{ receipt: { id: string } }>(
          admin,
          "finance.create_receipt",
          agentInput(invoiceA.id),
        );
        // 正式表零重复：两渠道各恰好一条回款
        expect(await prisma.financeReceipt.count()).toBe(receiptsBefore + 2);
        const rcptW = await prisma.financeReceipt.findUniqueOrThrow({ where: { id: webResult.receipt.id } });
        const rcptA = await prisma.financeReceipt.findUniqueOrThrow({ where: { id: agentResult.result.receipt.id } });
        expect(rcptA.amount).toBe(rcptW.amount);
        // proposal 级幂等键端到端落库：Agent 渠道挂 proposalId，Web 渠道为空
        expect(rcptA.sourceAgentProposalId).toBe(agentResult.proposalId);
        expect(rcptW.sourceAgentProposalId).toBeNull();
        expect(await prisma.financeReceiptAllocation.count({ where: { receiptId: rcptA.id } }))
          .toBe(await prisma.financeReceiptAllocation.count({ where: { receiptId: rcptW.id } }));
        const invAfterW = await prisma.externalOrderInvoiceRequest.findUniqueOrThrow({ where: { id: invoiceW.id } });
        const invAfterA = await prisma.externalOrderInvoiceRequest.findUniqueOrThrow({ where: { id: invoiceA.id } });
        expect(invAfterA.status).toBe(invAfterW.status);
      }

      // ── S7 contracts.generate：合同文档/覆盖/附件等价 ─────────────────────
      {
        const seller = await prisma.billingProfile.create({ data: { name: "合同销方" } });
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "合同客户", ownerUserId: user.userId } });
        const mkOrder = async (orderNo: string) => {
          const order = await prisma.order.create({
            data: {
              orderNo, title: `合同订单 ${orderNo}`, status: "CONFIRMED",
              totalAmount: 100_000, profileId: profile.id, buyerNameSnapshot: "张三", createdById: user.userId, technicalOwnerUserId: user.userId,
            },
          });
          await prisma.orderLine.create({
            data: { orderId: order.id, itemName: "测序服务", quantity: 1, unitPrice: 100_000, amount: 100_000, sortOrder: 0 },
          });
          return order;
        };
        const orderW = await mkOrder("PARITY-CT-W");
        const orderA = await mkOrder("PARITY-CT-A");
        const fileUrl = "/uploads/contract-templates/parity-test/template.docx";
        const template = await prisma.contractTemplate.create({
          data: { name: "parity 模板", category: "SEQUENCING", fileName: "parity.docx", fileUrl, createdById: user.userId },
        });
        const abs = path.join(process.cwd(), "public", fileUrl);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, buildTestDocx(["{sellerName}", "{buyerName}", "{contractNo}", "{totalAmount}"]));

        const webResult = await generateContractForActor(user, {
          orderIds: [orderW.id],
          templateId: template.id,
          sellerProfileId: seller.id,
        });
        // Agent 通道为完整管线：prepare_draft 取 generationIntentId → 建 generate
        // proposal → confirm（proposalId fencing + intent 幂等锚点）
        const prepared = await executeAgentAction<{ draft: { generationIntentId: string } }>(
          agentExecCtx(user),
          "contracts.prepare_draft",
          { orderIds: [orderA.id], templateId: template.id, sellerProfileId: seller.id },
        );
        const genProposal = await agentCreateProposal(prisma, createAgentProposal, user, "contracts.generate", {
          generationIntentId: prepared.result.draft.generationIntentId,
          orderIds: [orderA.id],
          templateId: template.id,
          sellerProfileId: seller.id,
        });
        const confirmed = await confirmAgentProposal(agentExecCtx(user), genProposal.id);
        const agentContractId = (confirmed.result as { contractId: string }).contractId;
        const docW = await prisma.contractDocument.findUniqueOrThrow({ where: { id: webResult.contractId } });
        const docA = await prisma.contractDocument.findUniqueOrThrow({ where: { id: agentContractId } });
        expect(docA.status).toBe(docW.status);
        expect(docA.totalAmount).toBe(docW.totalAmount);
        expect(docA.buyerName).toBe(docW.buyerName);
        expect(await prisma.orderContractCoverage.count({ where: { contractId: docA.id } }))
          .toBe(await prisma.orderContractCoverage.count({ where: { contractId: docW.id } }));
        expect(!!await prisma.contractAttachment.findFirst({ where: { contractDocumentId: docA.id } }))
          .toBe(!!await prisma.contractAttachment.findFirst({ where: { contractDocumentId: docW.id } }));
        await expect(fs.access(path.join(CONTRACTS_BASE, docA.id, `${docA.contractNo}.docx`))).resolves.toBeUndefined();
      }

      // ── 冻结输入往返性：confirm 链把「proposalInput（buildProposal 声明）??
      //    parseInput 输出」冻结进 inputJson，confirm 时重跑 parseInput。无论
      //    冻结的是哪种形状，都必须可被 parseInput 重解析。finance.create_receipt
      //    曾冻结 amountYuan 中间形状，confirm 必报「amount is required」，
      //    修复为 buildProposal 声明 raw 形状 proposalInput（S6 场景 + 本块防回归）──
      {
        // create_receipt 的 buildProposal（preview）需真实发票做 scope 校验，建最小 fixture
        const rtOrg = await prisma.organization.create({
          data: { orgCode: "PARITY-RT-ORG", canonicalName: "往返单位", normalizedName: "往返单位" },
        });
        const rtProfile = await prisma.crmCustomerProfile.create({ data: { name: "往返客户", ownerUserId: admin.userId } });
        const rtOrder = await prisma.order.create({
          data: {
            orderNo: "PARITY-RT-ORDER", title: "往返订单", status: "CONFIRMED",
            totalAmount: 10_000, profileId: rtProfile.id, buyerOrganizationId: rtOrg.id, createdById: admin.userId,
          },
        });
        const rtInvoice = await prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: rtOrder.id, status: "ISSUED", totalAmount: 10_000,
            buyerOrganizationId: rtOrg.id, buyerOrganizationName: "往返单位", createdById: admin.userId,
          },
        });
        await prisma.orderInvoiceCoverage.create({ data: { invoiceRequestId: rtInvoice.id, orderId: rtOrder.id, amount: 10_000 } });

        const samples: Record<string, unknown> = {
          "finance.create_receipt": {
            amount: 100,
            receivedAt: new Date().toISOString(),
            organizationId: rtOrg.id,
            allocations: [{ invoiceId: rtInvoice.id, amount: 100 }],
          },
          "finance.prepare_invoice_draft": {
            orderId: "order-x",
            coverageAllocations: [{ orderId: "order-x", amountCents: 100 }],
            buyerOrganizationName: "单位",
          },
          "finance.register_issued_invoice": {
            stagingFileId: "staging-x",
            invoiceRequestId: "invreq-x",
            actualInvoiceNo: "NO-1",
            actualIssuedAt: "2026-01-01",
            expectedSha256: "sha-x",
            expectedStagingVersion: 1,
          },
          "finance.confirm_bank_flow_batch": { workspaceId: "ws-x", expectedVersion: 1 },
          "crm.request_organization_binding": { organizationId: "org-x", canonicalName: "单位" },
          "tickets.update_status": { ticketId: "ticket-x", status: "OPEN" },
        };
        for (const [key, raw] of Object.entries(samples)) {
          const action = listAgentActions().find((a) => a.key === key);
          expect(action, `action ${key} 已注册`).toBeTruthy();
          const once = action!.parseInput(raw);
          let frozen: unknown = once;
          if (key === "finance.create_receipt") {
            const buildProposal = action!.buildProposal as
              | ((ctx: AgentExecutionContext, input: unknown) => Promise<{ proposalInput?: unknown }>)
              | undefined;
            const bp = await buildProposal!(agentExecCtx(admin), once);
            expect(bp.proposalInput, "create_receipt buildProposal 必须声明 raw 形状 proposalInput").toBeTruthy();
            frozen = bp.proposalInput;
          }
          expect(() => action!.parseInput(frozen), `${key} 冻结输入可被 parseInput 重解析（confirm 链往返）`).not.toThrow();
        }
      }

      // ── F1 越权等价：REP 建订单，两渠道均拒绝且正式表零残留 ───────────────
      {
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "越权客户", ownerUserId: rep.userId } });
        const input = { title: "越权订单", profileId: profile.id, moneyUnit: "yuan" as const, totalAmount: 100 };
        const ordersBefore = await prisma.order.count();
        await expect(createOrderForActor(rep, web, input)).rejects.toBeInstanceOf(ForbiddenError);
        // 生产路径在 createAgentProposal 的 availability 门即拒绝（REP 无 orders.create 能力）
        await expect(
          createAgentProposal(agentExecCtx(rep), "orders.create", input),
        ).rejects.toBeInstanceOf(AgentActionForbiddenError);
        expect(await prisma.order.count()).toBe(ordersBefore);
      }

      // ── F2 重复 confirm：Conflict，正式表不重复 ───────────────────────────
      {
        const org = await prisma.organization.create({
          data: { orgCode: "PARITY-DUP-ORG", canonicalName: "重复确认单位", normalizedName: "重复确认单位", isInvoiceSubject: true },
        });
        const seller = await prisma.billingProfile.create({ data: { name: "重复确认销方" } });
        const order = await prisma.order.create({
          data: { orderNo: "PARITY-DUP-ORDER", title: "重复确认订单", status: "CONFIRMED", totalAmount: 100_000, buyerOrganizationId: org.id, createdById: admin.userId, technicalOwnerUserId: admin.userId },
        });
        const input = {
          mainOrderId: order.id,
          coverageAllocations: [{ orderId: order.id, amountCents: 50_000 }],
          sellerProfileId: seller.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: "重复确认单位",
          invoiceType: "NORMAL" as const,
          items: [{ itemName: "测序服务", amountCents: 50_000 }],
        };
        const proposal = await agentCreateProposal(prisma, createAgentProposal, admin, "finance.submit_invoice_request", input);
        await confirmAgentProposal(agentExecCtx(admin), proposal.id);
        expect(await prisma.externalOrderInvoiceRequest.count({ where: { orderId: order.id } })).toBe(1);
        await expect(confirmAgentProposal(agentExecCtx(admin), proposal.id)).rejects.toBeInstanceOf(
          AgentActionConflictError,
        );
        expect(await prisma.externalOrderInvoiceRequest.count({ where: { orderId: order.id } })).toBe(1);
      }

      // ── F3 confirm 后权限被撤销（profile 改派）→ Forbidden，任务零落库 ───
      {
        const otherRep = asActor(await mkUser("parity-revoke-other@example.com", "Other", "REPRESENTATIVE"));
        // 有效代表解析要求 owner 用户有活跃 HUMAN Representative 行（邮箱关联）
        await prisma.representative.create({ data: { name: "Rep", email: "parity-rep@example.com" } });
        await prisma.representative.create({ data: { name: "Other", email: "parity-revoke-other@example.com" } });
        const profile = await prisma.crmCustomerProfile.create({
          data: { name: "撤权客户", ownerUserId: rep.userId, assignmentStatus: "ASSIGNED" },
        });
        const dueAt = new Date(Date.now() + 86_400_000).toISOString();
        const proposal = await agentCreateProposal(prisma, createAgentProposal, rep, "crm.create_followup_task", {
          profileId: profile.id,
          title: "撤权跟进",
          dueAt,
        });
        // confirm 前改派给其他代表 → confirm 时服务端重检 scope 失败
        await prisma.crmCustomerProfile.update({ where: { id: profile.id }, data: { ownerUserId: otherRep.userId } });
        const tasksBefore = await prisma.crmFollowUpTask.count();
        await expect(confirmAgentProposal(agentExecCtx(rep), proposal.id)).rejects.toBeInstanceOf(
          AgentActionForbiddenError,
        );
        expect(await prisma.crmFollowUpTask.count()).toBe(tasksBefore);
      }

      // ── F4 多对象部分无权限（合同 prepare）两渠道均拒绝，意图零残留 ──────
      {
        const profileMine = await prisma.crmCustomerProfile.create({ data: { name: "部分权限-我的", ownerUserId: user.userId } });
        const profileOther = await prisma.crmCustomerProfile.create({ data: { name: "部分权限-他人", ownerUserId: admin.userId } });
        const orderMine = await prisma.order.create({
          data: { orderNo: "PARITY-PART-MINE", title: "我的订单", status: "CONFIRMED", totalAmount: 10_000, profileId: profileMine.id, createdById: user.userId },
        });
        const orderOther = await prisma.order.create({
          data: { orderNo: "PARITY-PART-OTHER", title: "他人订单", status: "CONFIRMED", totalAmount: 10_000, profileId: profileOther.id, createdById: admin.userId },
        });
        const seller = await prisma.billingProfile.create({ data: { name: "部分权限销方" } });
        const fileUrl = "/uploads/contract-templates/parity-test/partial.docx";
        const template = await prisma.contractTemplate.create({
          data: { name: "partial 模板", category: "SEQUENCING", fileName: "partial.docx", fileUrl, createdById: user.userId },
        });
        const abs = path.join(process.cwd(), "public", fileUrl);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, buildTestDocx(["{sellerName}"]));
        const input = { orderIds: [orderMine.id, orderOther.id], templateId: template.id, sellerProfileId: seller.id };

        const intentsBefore = await prisma.contractGenerationIntent.count();
        await expect(prepareContractDraftForActor(user, input)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(
          executeAgentAction(agentExecCtx(user), "contracts.prepare_draft", input),
        ).rejects.toBeInstanceOf(AgentActionForbiddenError);
        // 意图零新增（S7 已有一个 intent，用 delta 断言）
        expect(await prisma.contractGenerationIntent.count()).toBe(intentsBefore);
      }
    });
  }, 300_000);
});
