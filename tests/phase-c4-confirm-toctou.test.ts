// secret-scan:allow — 本测试需要字面量密码串（bcrypt hash 测试 fixture）；均为测试 fixture，非真实凭据。
/**
 * Phase C4 测试：补齐 cleanup plan §八.1 最后两条 confirm 链路 TOCTOU 缺口。
 *
 * 覆盖（docs/agent-public-surface-cleanup-plan-2026-07-26.md §八.1）：
 *  - prepare 后权限被撤销（Order scope 关系解除），confirm 失败且零落库。
 *  - technical owner 在 prepare 后变化，confirm 失败且零落库。
 *
 * 选定的代表性 confirm 链路（与 phase-c3 一致的 fixture 模式）：
 *  - contracts.generate（经 prepare_contract，USER actor）：写 ContractDocument。
 *    - 角色选择 USER：canGenerateContract 接受 USER；同时 USER 走 getOrderScopeWhere
 *      非 null 路径，使「权限撤销」场景能真实触发 scope 复核（ADMIN 全 scope 会绕过）。
 *    - 同时该路径覆盖 owner gate（事务内 assertAgentCanWriteOrders { tx }）。
 *  - finance.submit_invoice_request（经 propose_invoice 项目路径，ADMIN actor）：
 *    写 ExternalOrderInvoiceRequest。
 *    - 角色必须 ADMIN（submit 强制 assertAdminInvoiceRequestWrite）。
 *    - ADMIN 不走 scope 复核，但 Phase E owner gate 对 ADMIN 仍生效
 *      （AGENT_WRITE_ROLES 含 ADMIN，assertOwnerMatches 同口径）。
 *      因此 owner-change 场景对 ADMIN 仍可触发。
 *
 * 复核点证据（confirm 重校验 owner/scope 的位置）：
 *  - contracts.generate 路径：
 *    - src/lib/contracts/application/generate-contract.ts:123（事务外 loadOrdersForContractAction，
 *      scope 复核：getOrderScopeWhere）。
 *    - src/lib/contracts/application/generate-contract.ts:128-131（事务外 early pre-check：
 *      assertAgentCanWriteOrders）。
 *    - src/lib/contracts/generate.ts:435-447（事务内 scope 复核：SCOPE_REVOKED → Forbidden）。
 *    - src/lib/contracts/generate.ts:449-460（事务内 TOCTOU：assertAgentCanWriteOrders { tx }）。
 *  - finance.submit_invoice_request 路径：
 *    - src/lib/finance/application/submit-invoice-request.ts:199（事务外 assertFullOrderScopeForActor）。
 *    - src/lib/finance/application/submit-invoice-request.ts:202-205（事务外 early pre-check：
 *      assertAgentCanWriteOrders）。
 *    - src/lib/finance/order-invoice-request-write.ts:345-355（事务内 TOCTOU：
 *      assertAgentCanWriteOrders { tx }）。
 *
 * P1-3 适配：channel="agent" 的 proposal 创建必须先消费 AgentUserConfirmationEvent。
 * 参照 phase-c3-preview-confirm.test.ts 的 seedConfirmationEvent helper。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库。
 * ⚠️ 顶层 type-only import。
 */
import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { PrismaClient } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";

/** 构造 agent channel invocation（与 phase-c3 一致）。 */
const agentInv = (over: Partial<{ agentRunId: string }> = {}) => ({
  channel: "agent" as const,
  ...(over.agentRunId ? { agentRunId: over.agentRunId } : {}),
});

/**
 * 为 agent channel 的 proposal 创建颁发可信确认事件（P1-3 门）。
 * targetIntent 必须与 confirm actionKey 一致。
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
      idempotencyKey: `c4-seed-${process.pid}-${p13EventSeed}-${Date.now()}`,
    },
  });
}

/** 构造最小合法 docx（zip），用于合同模板渲染。与 phase-c3 / web-agent-parity 同源。 */
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

/** 失败断言：confirm 失败必须是 ForbiddenError(403) 或 NotFoundError(404) 系。 */
function expectForbiddenOrNotFound(caught: unknown) {
  expect(caught, "confirm 应当抛错").toBeInstanceOf(Error);
  const err = caught as Error & { status?: number };
  const status = err?.status;
  const msg = err?.message ?? "";
  const isForbidden =
    status === 403 ||
    /Forbidden|技术负责人|权限|FORBIDDEN/i.test(msg);
  const isNotFound =
    status === 404 ||
    /找不到|不存在|Not found|404|NOT_FOUND/i.test(msg);
  expect(isForbidden || isNotFound, `unexpected error: status=${status} msg=${msg}`).toBe(true);
}

describe("Phase C4 — confirm TOCTOU: 权限撤销 / technical owner 变化", () => {
  it("prepare 后权限撤销与 owner 变化均使 confirm 失败且零落库，对照组 confirm 成功", async () => {
    // 合同输出目录隔离（合同生成需要 SCIMANAGE_CONTRACT_UPLOADS_DIR）。
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-phase-c4-"));
    const origContractUploads = process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
    const origZhipu = process.env.ZHIPU_API_KEY;
    process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = path.join(tempRoot, "contract-uploads");
    process.env.ZHIPU_API_KEY = "test-key";
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

        const mkUser = async (email: string, name: string, role: string) =>
          prisma.user.create({ data: { email, name, password: hashSync("x", 4), role } });

        // otherUser：用于「把 owner/scope 关系转移给他人」。
        const otherUser = await mkUser("c4-other@t.test", "OtherUser", "USER");

        // ────────────────────────────────────────────────────────────────────
        // 1. contracts.generate（USER actor）：权限撤销 / owner 变化 / 对照
        // ────────────────────────────────────────────────────────────────────
        {
          // actorCt：USER 角色，可经 canGenerateContract；同时受 getOrderScopeWhere 约束。
          const actorCt = await mkUser("c4-ct@t.test", "ActorCt", "USER");
          const actorCtActor: BusinessActor = { userId: actorCt.id, role: "USER" };

          const profile = await prisma.crmCustomerProfile.create({
            data: { name: "C4合同客户", ownerUserId: actorCt.id, assignmentStatus: "ASSIGNED" },
          });
          const order = await prisma.order.create({
            data: {
              orderNo: "C4-CT-1",
              title: "合同订单C4",
              status: "CONFIRMED",
              totalAmount: 100_000,
              category: "SERVICE",
              profileId: profile.id,
              buyerNameSnapshot: "C4客户",
              createdById: actorCt.id,
              technicalOwnerUserId: actorCt.id,
              lines: {
                create: [
                  { itemName: "测序服务", quantity: 1, unitPrice: 100_000, amount: 100_000, sortOrder: 0 },
                ],
              },
            },
          });
          // 专用销方（不设 isDefault；显式通过 sellerOptionId 传入）。
          // 不设默认避免与后续 invoice 场景的 seller 抢占「唯一默认」位置。
          const ctSeller = await prisma.billingProfile.create({
            data: { name: "C4合同销方", taxId: "91110000000004993X" },
          });

          // 模板 docx（generate execute 会渲染）
          const templatesDir = path.join(process.cwd(), "public", "uploads", "contract-templates", "c4-test");
          await fs.mkdir(templatesDir, { recursive: true });
          const fileUrl = "/uploads/contract-templates/c4-test/template.docx";
          await prisma.contractTemplate.create({
            data: {
              name: "C4模板",
              category: "SEQUENCING",
              fileName: "c4.docx",
              fileUrl,
              createdById: actorCt.id,
              isDefault: true,
            },
          });
          const abs = path.join(process.cwd(), "public", fileUrl);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, await buildTestDocx(["{sellerName}", "{buyerName}", "{contractNo}", "{totalAmount}"]));

          // ── 对照组：owner 未变 → confirm 成功，写 1 行 ContractDocument ──
          {
            await seedConfirmationEvent(prisma, {
              actorUserId: actorCt.id,
              agentRunId: "c4-ct-control",
              targetIntent: "contracts.generate",
            });
            const docsBefore = await prisma.contractDocument.count();
            const outcome = await executePublicTool({
              actor: actorCtActor,
              invocation: agentInv({ agentRunId: "c4-ct-control" }),
              publicToolKey: "prepare_contract",
              publicInput: { orderIds: [order.id], sellerOptionId: ctSeller.id },
            });
            expect(outcome.ok, `control prepare_contract failed: ${JSON.stringify(outcome)}`).toBe(true);
            if (!outcome.ok) throw new Error(`control prepare failed: ${JSON.stringify(outcome)}`);
            const proposalId = (outcome.result.modelFacing as { proposal?: { id?: string } }).proposal
              ?.id;
            expect(proposalId).toBeTruthy();

            await confirmAgentProposal(
              { actor: actorCtActor, invocation: agentInv({ agentRunId: "c4-ct-control" }) },
              proposalId!,
            );
            expect(await prisma.contractDocument.count()).toBe(docsBefore + 1);
            const confirmed = await prisma.agentProposal.findUnique({ where: { id: proposalId! } });
            expect(confirmed?.status).toBe("CONFIRMED");
          }

          // ── 场景 1a：technical owner 变化 → confirm 失败 + 零落库 ──
          {
            await seedConfirmationEvent(prisma, {
              actorUserId: actorCt.id,
              agentRunId: "c4-ct-owner",
              targetIntent: "contracts.generate",
            });
            const docsBefore = await prisma.contractDocument.count();

            const outcome = await executePublicTool({
              actor: actorCtActor,
              invocation: agentInv({ agentRunId: "c4-ct-owner" }),
              publicToolKey: "prepare_contract",
              publicInput: { orderIds: [order.id], sellerOptionId: ctSeller.id },
            });
            expect(outcome.ok, `owner-change prepare failed: ${JSON.stringify(outcome)}`).toBe(true);
            if (!outcome.ok) throw new Error(`owner-change prepare failed: ${JSON.stringify(outcome)}`);
            const proposalId = (outcome.result.modelFacing as { proposal?: { id?: string } }).proposal
              ?.id;
            expect(proposalId).toBeTruthy();
            // preview 阶段零落库
            expect(await prisma.contractDocument.count()).toBe(docsBefore);

            // confirm 前把订单 technical owner 改成他人。
            await prisma.order.update({
              where: { id: order.id },
              data: { technicalOwnerUserId: otherUser.id },
            });

            // generateContractForActor 在 generate-contract.ts:128-131 调
            // assertAgentCanWriteOrders（事务外 early pre-check），命中 ForbiddenError → 403。
            let caught: unknown = null;
            try {
              await confirmAgentProposal(
                { actor: actorCtActor, invocation: agentInv({ agentRunId: "c4-ct-owner" }) },
                proposalId!,
              );
            } catch (err) {
              caught = err;
            }
            expectForbiddenOrNotFound(caught);

            // 零落库
            expect(await prisma.contractDocument.count()).toBe(docsBefore);
            const failed = await prisma.agentProposal.findUnique({ where: { id: proposalId! } });
            expect(failed?.status).toBe("FAILED");

            // 还原 owner，便于后续场景复用
            await prisma.order.update({
              where: { id: order.id },
              data: { technicalOwnerUserId: actorCt.id },
            });
          }

          // ── 场景 1b：权限撤销（CRM owner + createdById 都改成他人，USER 角色依赖
          //      这些 scope 关系）→ confirm 失败 + 零落库 ──
          {
            await seedConfirmationEvent(prisma, {
              actorUserId: actorCt.id,
              agentRunId: "c4-ct-revoke",
              targetIntent: "contracts.generate",
            });
            const docsBefore = await prisma.contractDocument.count();

            const outcome = await executePublicTool({
              actor: actorCtActor,
              invocation: agentInv({ agentRunId: "c4-ct-revoke" }),
              publicToolKey: "prepare_contract",
              publicInput: { orderIds: [order.id], sellerOptionId: ctSeller.id },
            });
            expect(outcome.ok, `revoke prepare failed: ${JSON.stringify(outcome)}`).toBe(true);
            if (!outcome.ok) throw new Error(`revoke prepare failed: ${JSON.stringify(outcome)}`);
            const proposalId = (outcome.result.modelFacing as { proposal?: { id?: string } }).proposal
              ?.id;
            expect(proposalId).toBeTruthy();
            expect(await prisma.contractDocument.count()).toBe(docsBefore);

            // 撤销 actorCt 对订单的全部 scope 关系：createdById + technicalOwnerUserId +
            // CRM profile owner 都改为他人，使 USER 的 getOrderScopeWhere 不再 match。
            await prisma.order.update({
              where: { id: order.id },
              data: { createdById: otherUser.id, technicalOwnerUserId: otherUser.id },
            });
            await prisma.crmCustomerProfile.update({
              where: { id: profile.id },
              data: { ownerUserId: otherUser.id },
            });

            // confirm 应失败：generate-contract.ts:123 loadOrdersForContractAction（scope 复核）
            // 在事务外就抛 NotFoundError/ForbiddenError；mapDomainErrorToAgentError 翻译。
            let caught: unknown = null;
            try {
              await confirmAgentProposal(
                { actor: actorCtActor, invocation: agentInv({ agentRunId: "c4-ct-revoke" }) },
                proposalId!,
              );
            } catch (err) {
              caught = err;
            }
            expectForbiddenOrNotFound(caught);

            expect(await prisma.contractDocument.count()).toBe(docsBefore);
            const failed = await prisma.agentProposal.findUnique({ where: { id: proposalId! } });
            expect(failed?.status).toBe("FAILED");
          }

          // 清理模板文件目录
          await fs.rm(templatesDir, { recursive: true, force: true }).catch(() => undefined);
        }

        // ────────────────────────────────────────────────────────────────────
        // 2. finance.submit_invoice_request（ADMIN actor）：owner 变化 / 对照
        //    （权限撤销场景对 ADMIN 无意义：ADMIN 全 scope；故本链只覆盖 owner 变化）
        // ────────────────────────────────────────────────────────────────────
        {
          // actorInv：必须 ADMIN（submit 强制 assertAdminInvoiceRequestWrite）。
          // ADMIN 仍受 Phase E owner gate 约束（assertOwnerMatches 同口径）。
          const actorInv2 = await mkUser("c4-inv@t.test", "ActorInv", "ADMIN");
          const actorInv2Actor: BusinessActor = { userId: actorInv2.id, role: "ADMIN" };

          const org = await prisma.organization.create({
            data: {
              orgCode: "C4-INV-ORG",
              canonicalName: "开票单位C4",
              normalizedName: "开票单位c4",
              isInvoiceSubject: true,
              taxId: "91110000000004991X",
            },
          });
          // seller 全局唯一默认，让 propose_invoice 自动解析销方。
          await prisma.billingProfile.create({
            data: { name: "C4销方", taxId: "91110000000004992X", isDefault: true },
          });

          // 每个场景独立的 project+order，避免开票额度互相挤占。
          let invOrderSeq = 0;
          const mkInvoiceFixture = async () => {
            invOrderSeq += 1;
            const proj = await prisma.project.create({
              data: { name: `C4项目${invOrderSeq}`, projectNo: `C4-P${invOrderSeq}`, technicalOwnerUserId: actorInv2.id },
            });
            const ord = await prisma.order.create({
              data: {
                orderNo: `C4-ORD-${invOrderSeq}`,
                title: `测序服务C4-${invOrderSeq}`,
                status: "CONFIRMED",
                totalAmount: 50_000,
                createdById: actorInv2.id,
                technicalOwnerUserId: actorInv2.id,
                financeTreatment: "STANDALONE",
                buyerOrganizationId: org.id,
                lines: { create: [{ itemName: "测序服务", amount: 50_000, sortOrder: 0 }] },
              },
            });
            await prisma.orderProjectLink.create({ data: { orderId: ord.id, projectId: proj.id } });
            return { proj, ord };
          };

          // ── 对照组：owner 未变 → confirm 成功 ──
          {
            const { proj } = await mkInvoiceFixture();
            await seedConfirmationEvent(prisma, {
              actorUserId: actorInv2.id,
              agentRunId: "c4-inv-control",
              targetIntent: "finance.submit_invoice_request",
            });
            const invoicesBefore = await prisma.externalOrderInvoiceRequest.count();
            const outcome = await executePublicTool({
              actor: actorInv2Actor,
              invocation: agentInv({ agentRunId: "c4-inv-control" }),
              publicToolKey: "propose_invoice",
              publicInput: { projectId: proj.id, invoiceType: "NORMAL" },
            });
            expect(outcome.ok, `control propose_invoice failed: ${JSON.stringify(outcome)}`).toBe(true);
            if (!outcome.ok) throw new Error(`control failed: ${JSON.stringify(outcome)}`);
            const proposalId = (outcome.result.modelFacing as { proposal?: { id?: string } }).proposal
              ?.id;
            expect(proposalId).toBeTruthy();

            await confirmAgentProposal(
              { actor: actorInv2Actor, invocation: agentInv({ agentRunId: "c4-inv-control" }) },
              proposalId!,
            );
            expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore + 1);
            const confirmed = await prisma.agentProposal.findUnique({ where: { id: proposalId! } });
            expect(confirmed?.status).toBe("CONFIRMED");
          }

          // ── 场景 2a：technical owner 变化 → confirm 失败 + 零落库 ──
          {
            const { proj, ord } = await mkInvoiceFixture();
            await seedConfirmationEvent(prisma, {
              actorUserId: actorInv2.id,
              agentRunId: "c4-inv-owner",
              targetIntent: "finance.submit_invoice_request",
            });
            const invoicesBefore = await prisma.externalOrderInvoiceRequest.count();

            const outcome = await executePublicTool({
              actor: actorInv2Actor,
              invocation: agentInv({ agentRunId: "c4-inv-owner" }),
              publicToolKey: "propose_invoice",
              publicInput: { projectId: proj.id, invoiceType: "NORMAL" },
            });
            expect(outcome.ok, `owner-change propose failed: ${JSON.stringify(outcome)}`).toBe(true);
            if (!outcome.ok) throw new Error(`owner-change propose failed: ${JSON.stringify(outcome)}`);
            const proposalId = (outcome.result.modelFacing as { proposal?: { id?: string } }).proposal
              ?.id;
            expect(proposalId).toBeTruthy();
            expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore);

            // confirm 前把订单 technical owner 改成他人。
            await prisma.order.update({
              where: { id: ord.id },
              data: { technicalOwnerUserId: otherUser.id },
            });

            // submitInvoiceRequestForActor 在事务外 early pre-check
            // （submit-invoice-request.ts:202-205）就抛 ForbiddenError → 403。
            let caught: unknown = null;
            try {
              await confirmAgentProposal(
                { actor: actorInv2Actor, invocation: agentInv({ agentRunId: "c4-inv-owner" }) },
                proposalId!,
              );
            } catch (err) {
              caught = err;
            }
            expectForbiddenOrNotFound(caught);

            // 零落库
            expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoicesBefore);
            const failed = await prisma.agentProposal.findUnique({ where: { id: proposalId! } });
            expect(failed?.status).toBe("FAILED");
          }
        }
      });
    } finally {
      if (origContractUploads === undefined) delete process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
      else process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = origContractUploads;
      if (origZhipu === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = origZhipu;
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
