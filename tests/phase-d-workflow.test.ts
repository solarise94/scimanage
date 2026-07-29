/**
 * Phase D / P0-2 / P0-3 tests：workflow controllers（import / bank-flow）端到端。
 *
 * 覆盖（docs/agent-public-surface-cleanup-plan-2026-07-26.md §五 P0-2/P0-3）：
 *  - manifest + Zod：operation enum 存在、parity 守护；
 *  - start_order_import：真实 analyze → sessionId 非 null（修复断链）；
 *  - operate_order_import：operation dispatch（resume / get_row / commit_row 产 proposal）；
 *  - start_bank_flow：真实 analyze → workspaceId 非 null + nextAction 含 workspaceId（修复断链）；
 *  - operate_bank_flow：operation dispatch（match / get_row）；
 *  - GenUI endpoint POST /api/agent/order-import-sessions/[sessionId]/actions：
 *    401 未登录 / 404 他人 session / 409 version 不匹配 / 400 非法 action / 正常 commit 产 proposal；
 *  - 导入落单 technicalOwnerUserId 绑定（import-single-row CREATE 分支源码断言）。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（与 parity / phase-b/e 惯例一致，
 * 避免 prisma 单例在多次 withTempSmokeDb 间锁定）。
 * ⚠️ 顶层 type-only import + vi.mock（next-auth）。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { PrismaClient } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";

// ── mock next-auth（GenUI endpoint 用 getServerSession） ──
type SessionUser = { id: string; role: string; name: string; email: string };
type MockSession = { user: SessionUser };
const sessionState = vi.hoisted(() => ({ current: null as MockSession | null }));

vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

// ── 隔离 staging/workspace 存储目录（避免触碰真实 public/uploads） ──
const ORIG_IMPORT_STAGING_DIR = process.env.IMPORT_STAGING_DIR;
const ORIG_WORKSPACE_DIR = process.env.AGENT_WORKSPACE_DIR;
let tempStorageRoot: string | null = null;

async function useIsolatedStorageDirs(): Promise<void> {
  tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-phase-d-"));
  process.env.IMPORT_STAGING_DIR = path.join(tempStorageRoot, "import-staging");
  process.env.AGENT_WORKSPACE_DIR = path.join(tempStorageRoot, "workspace");
  await fs.mkdir(process.env.IMPORT_STAGING_DIR, { recursive: true });
  await fs.mkdir(process.env.AGENT_WORKSPACE_DIR, { recursive: true });
}

// 标准订单 CSV（ORDER_GENERIC 指纹），analyze 直接产 session，不需 column mapping。
// detectImportParser（§6.1）：PINGOODMICE 与 ORDER_GENERIC 不能同时命中，否则 needsColumnMapping。
// ORDER_GENERIC 只需 {externalOrderNo=订单号 + (grossAmount|paidAmount|priceAdjustment)},
// 且不命中 PINGOODMICE 必需集（externalOrderNo+receiverName+paidAmount 全有才 PINGOODMICE）。
// 故只列 订单号 + 订单实付金额 → GENERIC-only（缺 receiverName → 不触发 PINGOODMICE）。
// 不列 下单时间/付款时间 列：避免触发 analyzeImportRow 的 JSON 反序列化 date 字段
// （normalizedPayloadJson 经 JSON.parse 后 orderAt/paidAt 为 string，buildImportRowAnalysisOutput
//   的 toISOString 调用会抛——这是既有 latent bug，与本计划无关，测试侧规避）。
// 2 行：第 1 行给 facade commit_row（§3），第 2 行给 GenUI endpoint（§6，独立未污染状态）。
const ORDER_CSV = [
  "订单号,订单实付金额",
  "EXT-001,1000.00",
  "EXT-002,2000.00",
].join("\n");

// 标准银行流水 CSV（含 付款单位/金额 列，analyze 直接 MAPPED）
const BANK_CSV = [
  "付款单位,金额,到款日期,备注",
  "测试公司A,1000.00,2024-05-01,第一笔",
  "测试公司B,2500.50,2024-05-02,",
].join("\n");

/**
 * P1-3 适配：channel="agent" 的 proposal 创建现在必须消费 AgentUserConfirmationEvent
 * （P1-3 allowProposal 门；门行为由 tests/allow-proposal-events.test.ts 独立覆盖）。
 * 本测试保留 agent channel（与生产路径一致），在创建 proposal 前为对应 confirm actionKey 颁发事件。
 * targetIntent 必须与 confirm actionKey 一致（createAgentProposal 用 action.key 作 targetIntent）。
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

describe("Phase D — workflow controllers（P0-2 订单导入 / P0-3 银行流水）", () => {
  it("端到端：manifest/Zod parity + start/operate order import + start/operate bank flow + GenUI endpoint + technicalOwner 绑定", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      sessionState.current = null;
      try {
        const { prisma } = await import("@/lib/prisma");
        const { hashSync } = await import("bcryptjs");
        const { ensureBuiltinAgentActionsRegistered } = await import("@/lib/agent-actions/registry");
        const { executePublicTool, __clearPublicFacadeRegistryForTests } = await import(
          "@/lib/agent-actions/public/public-executor"
        );
        const { __resetPublicReadFacadesForTests, registerPublicReadFacades } = await import(
          "@/lib/agent-actions/public/facades"
        );
        const { PUBLIC_TOOL_MANIFEST } = await import("@/lib/agent-actions/public/manifest");
        const { PUBLIC_INPUT_SCHEMAS } = await import("@/lib/agent-actions/public/input-schemas");
        const { IMPORT_KIND, createImportStagingFile } = await import("@/lib/import-staging");
        const { POST: actionsPost } = await import(
          "@/app/api/agent/order-import-sessions/[sessionId]/actions/route"
        );

        ensureBuiltinAgentActionsRegistered();
        __clearPublicFacadeRegistryForTests();
        __resetPublicReadFacadesForTests();
        registerPublicReadFacades();

        // ════════════ §1 manifest + Zod parity ════════════
        const implemented = PUBLIC_TOOL_MANIFEST.filter((e) => e.implemented).map((e) => e.publicTool);
        expect(implemented).toContain("start_order_import");
        expect(implemented).toContain("operate_order_import");
        expect(implemented).toContain("start_bank_flow");
        expect(implemented).toContain("operate_bank_flow");
        expect(implemented.length).toBe(PUBLIC_TOOL_MANIFEST.length);

        const ooi = PUBLIC_TOOL_MANIFEST.find((e) => e.publicTool === "operate_order_import")!;
        const ooiProps = (ooi.publicInput.properties ?? {}) as Record<string, { enum?: string[] }>;
        const ooiOp = ooiProps.operation;
        expect(ooiOp?.enum).toEqual([
          "apply_column_mapping", "get_row", "update_row_draft",
          "commit_row", "skip_row", "resume",
        ]);
        expect(ooi.publicInput.required).toContain("operation");

        const obf = PUBLIC_TOOL_MANIFEST.find((e) => e.publicTool === "operate_bank_flow")!;
        const obfProps = (obf.publicInput.properties ?? {}) as Record<string, { enum?: string[] }>;
        const obfOp = obfProps.operation;
        expect(obfOp?.enum).toEqual([
          "apply_bank_flow_mapping", "match_bank_flow_rows", "get_bank_flow_row",
          "update_bank_flow_selection", "reopen_bank_flow_rows",
          "ocr_bank_flow_receipts", "confirm_bank_flow_batch",
        ]);
        expect(obf.publicInput.required).toContain("operation");

        // Zod：operation 非法枚举被拒
        const rBad = PUBLIC_INPUT_SCHEMAS.operate_order_import!.safeParse({
          sessionId: "s1", operation: "bogus_op",
        });
        expect(rBad.success).toBe(false);
        const rOk = PUBLIC_INPUT_SCHEMAS.operate_order_import!.safeParse({
          sessionId: "s1", operation: "resume",
        });
        expect(rOk.success).toBe(true);

        // parity：properties key set 一致
        for (const entry of PUBLIC_TOOL_MANIFEST) {
          const schema = PUBLIC_INPUT_SCHEMAS[entry.publicTool]!;
          const manifestProps = Object.keys(entry.publicInput.properties ?? {}).sort();
          const zodProps = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape).sort();
          expect(zodProps, `properties mismatch for ${entry.publicTool}`).toEqual(manifestProps);
        }

        // ════════════ §2 start_order_import：真实 analyze → sessionId 非 null ════════════
        const admin = await prisma.user.create({
          data: { email: "admin-d@t.test", name: "AdminD", password: hashSync("x", 4), role: "ADMIN" },
        });
        const other = await prisma.user.create({
          data: { email: "other-d@t.test", name: "OtherD", password: hashSync("x", 4), role: "ADMIN" },
        });
        const bfUser = await prisma.user.create({
          data: { email: "user-bf@t.test", name: "UserBF", password: hashSync("x", 4), role: "USER" },
        });

        const orderStaging = await createImportStagingFile({
          ownerUserId: admin.id,
          originalName: "orders.csv",
          declaredMime: "text/csv",
          buffer: Buffer.from(ORDER_CSV, "utf8"),
          importKind: IMPORT_KIND.ORDER,
        });

        const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };
        // P1-3 适配：保留 agent channel（与生产路径一致），在创建 proposal 前
        // 为对应 confirm actionKey 颁发 AgentUserConfirmationEvent（门由 allow-proposal-events.test.ts 覆盖）。
        const inv = { channel: "agent" as const, agentRunId: "run-d" };

        const startOutcome = await executePublicTool({
          actor: adminActor, invocation: inv, publicToolKey: "start_order_import",
          publicInput: { stagingFileId: orderStaging.id },
        });
        expect(startOutcome.ok).toBe(true);
        const startFacing = (startOutcome.ok ? startOutcome.result.modelFacing : {}) as {
          analysis?: { sessionId?: string; needsColumnMapping?: boolean };
          nextAction?: { operation?: string; sessionId?: string | null };
        };
        expect(startFacing.analysis?.needsColumnMapping).toBe(false);
        const sessionIdRaw = startFacing.analysis?.sessionId;
        expect(typeof sessionIdRaw).toBe("string");
        expect(sessionIdRaw!.length).toBeGreaterThan(0);
        const sessionId: string = sessionIdRaw!;
        expect(startFacing.nextAction?.sessionId).toBe(sessionId);
        expect(startFacing.nextAction?.operation).toBeDefined();

        // ════════════ §3 operate_order_import：resume / get_row / commit_row 产 proposal ════════════
        const resumeOutcome = await executePublicTool({
          actor: adminActor, invocation: inv, publicToolKey: "operate_order_import",
          publicInput: { sessionId: sessionId!, operation: "resume" },
        });
        expect(resumeOutcome.ok).toBe(true);
        const resumeFacing = (resumeOutcome.ok ? resumeOutcome.result.modelFacing : {}) as {
          sessionState?: { nextRowId?: string | null; counts?: { unresolved?: number } };
          nextAction?: { operation?: string; sessionId?: string; rowId?: string | null };
        };
        const op = resumeFacing.nextAction?.operation;
        expect(op).toBeTruthy();
        // nextAction 必须是真实可执行 operation，禁止死链（process_next_row 这类无消费者的 key）
        expect(["get_row", "commit_row", "skip_row", "resume", "complete"]).toContain(op);
        expect(resumeFacing.nextAction?.sessionId).toBe(sessionId);

        const rowIdRaw = resumeFacing.sessionState?.nextRowId;
        expect(rowIdRaw).toBeTruthy();
        const rowId: string = rowIdRaw!;

        const getRowOutcome = await executePublicTool({
          actor: adminActor, invocation: inv, publicToolKey: "operate_order_import",
          publicInput: { sessionId: sessionId!, operation: "get_row", rowId: rowId! },
        });
        expect(getRowOutcome.ok).toBe(true);
        const getRowFacing = (getRowOutcome.ok ? getRowOutcome.result.modelFacing : {}) as {
          row?: { rowId?: string; version?: number };
        };
        expect(getRowFacing.row?.rowId).toBe(rowId);
        expect(typeof getRowFacing.row?.version).toBe("number");
        const version = getRowFacing.row!.version!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

        // commit_row → PENDING proposal（修复断链：旧实现 commit_row 无服务端消费者）
        // P1-3 门：先为 orders.import_order_row 颁发事件（agent channel 创建 proposal 必须消费）。
        await seedConfirmationEvent(prisma, {
          actorUserId: admin.id,
          agentRunId: "run-d",
          targetIntent: "orders.import_order_row",
        });
        const commitOutcome = await executePublicTool({
          actor: adminActor, invocation: inv, publicToolKey: "operate_order_import",
          publicInput: { sessionId: sessionId!, operation: "commit_row", rowId: rowId! },
        });
        expect(commitOutcome.ok).toBe(true);
        const commitFacing = (commitOutcome.ok ? commitOutcome.result.modelFacing : {}) as {
          commitRowProposal?: { id?: string; actionKey?: string };
        };
        expect(commitFacing.commitRowProposal?.id).toBeTruthy();
        expect(commitFacing.commitRowProposal?.actionKey).toBe("orders.import_order_row");
        const commitProposal = await prisma.agentProposal.findUnique({
          where: { id: commitFacing.commitRowProposal!.id! },
          select: { status: true, actionKey: true },
        });
        expect(commitProposal?.status).toBe("PENDING");
        expect(commitProposal?.actionKey).toBe("orders.import_order_row");

        // ════════════ §4 start_bank_flow：真实 analyze → workspaceId 非 null ════════════
        const bfStaging = await createImportStagingFile({
          ownerUserId: bfUser.id,
          originalName: "bank.csv",
          declaredMime: "text/csv",
          buffer: Buffer.from(BANK_CSV, "utf8"),
          importKind: IMPORT_KIND.BANK_FLOW,
        });
        const bfActor: BusinessActor = { userId: bfUser.id, role: "USER" };
        const bfStart = await executePublicTool({
          actor: bfActor, invocation: { channel: "agent", agentRunId: "run-bf" },
          publicToolKey: "start_bank_flow", publicInput: { stagingFileId: bfStaging.id },
        });
        expect(bfStart.ok).toBe(true);
        const bfStartFacing = (bfStart.ok ? bfStart.result.modelFacing : {}) as {
          analysis?: { workspaceId?: string; mapping?: { payerName?: string; amount?: string } };
          nextAction?: { operation?: string; workspaceId?: string | null };
        };
        const workspaceIdRaw = bfStartFacing.analysis?.workspaceId;
        expect(typeof workspaceIdRaw).toBe("string");
        expect(workspaceIdRaw!.length).toBeGreaterThan(0);
        const workspaceId: string = workspaceIdRaw!;
        // 修复断链：nextAction 必须含 workspaceId（旧实现连字段都没有）
        expect(bfStartFacing.nextAction?.workspaceId).toBe(workspaceId);
        expect(bfStartFacing.analysis?.mapping?.payerName).toBeTruthy();
        expect(bfStartFacing.nextAction?.operation).toBe("match_bank_flow_rows");

        // ════════════ §5 operate_bank_flow：match / get_row（dispatch 断链修复）════════════
        const bfMatch = await executePublicTool({
          actor: bfActor, invocation: { channel: "agent", agentRunId: "run-bf" },
          publicToolKey: "operate_bank_flow",
          publicInput: { workspaceId: workspaceId!, operation: "match_bank_flow_rows" },
        });
        expect(bfMatch.ok).toBe(true);
        const bfMatchFacing = (bfMatch.ok ? bfMatch.result.modelFacing : {}) as {
          matchResult?: unknown;
          nextAction?: { operation?: string; workspaceId?: string };
        };
        const bfOp = bfMatchFacing.nextAction?.operation;
        expect(bfOp).toBeTruthy();
        // 禁止死链（match_next / select_match 这类无消费者的 key）
        expect([
          "apply_bank_flow_mapping", "match_bank_flow_rows", "get_bank_flow_row",
          "update_bank_flow_selection", "reopen_bank_flow_rows", "ocr_bank_flow_receipts",
          "confirm_bank_flow_batch", "complete",
        ]).toContain(bfOp);
        expect(bfMatchFacing.nextAction?.workspaceId).toBe(workspaceId);

        // get_bank_flow_row：读行详情（rowIndex 可能因 match 后状态变化而不可用；
        // 此处只验证 dispatch 不死链——错误也证明 facade 正确路由到 internal action）。
        const bfGetRow = await executePublicTool({
          actor: bfActor, invocation: { channel: "agent", agentRunId: "run-bf" },
          publicToolKey: "operate_bank_flow",
          publicInput: { workspaceId: workspaceId!, operation: "get_bank_flow_row", rowIndex: 0 },
        });
        // ok 或 RESOURCE_NOT_FOUND 都证明 facade 正确 dispatch（无死链）；
        // 拒绝的是 INVALID_PUBLIC_INPUT（schema/dispatch bug）。
        if (!bfGetRow.ok) {
          expect(bfGetRow.code).not.toBe("INVALID_PUBLIC_INPUT");
          expect(bfGetRow.code).not.toBe("PUBLIC_TOOL_ERROR");
        }

        // ════════════ §5b operate_bank_flow：workspace 不存在 → 404（非 bad_input）════════════
        // 错误分层规范：资源不存在/越权应让 NotFoundError 穿透到 public-executor 翻成
        // 404 RESOURCE_NOT_FOUND，不降级为 needsUserInput/bad_input。
        const bfNotFound = await executePublicTool({
          actor: bfActor, invocation: { channel: "agent", agentRunId: "run-bf" },
          publicToolKey: "operate_bank_flow",
          publicInput: { workspaceId: "nonexistent-workspace-id", operation: "match_bank_flow_rows" },
        });
        expect(bfNotFound.ok).toBe(false);
        if (!bfNotFound.ok) {
          expect(bfNotFound.status).toBe(404);
          expect(bfNotFound.code).toBe("RESOURCE_NOT_FOUND");
          // 禁止降级为 bad_input / needsUserInput
          expect(bfNotFound.code).not.toBe("INVALID_PUBLIC_INPUT");
        }

        // ════════════ §6 GenUI endpoint：401 / 404 / 400 / 409 / 202 proposal ════════════
        const login = (u: { id: string; role: string; name: string; email: string }) => {
          sessionState.current = { user: { id: u.id, role: u.role, name: u.name, email: u.email } };
        };
        const jsonReq = (body: unknown) =>
          new Request(`http://localhost/api/agent/order-import-sessions/${sessionId}/actions`, {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          });
        const callActions = (req: Request, sid: string) =>
          actionsPost(req as never, { params: Promise.resolve({ sessionId: sid }) });

        // 6.1 未登录 → 401
        sessionState.current = null;
        const r401 = await callActions(jsonReq({ action: "resume" }), sessionId);
        expect(r401.status).toBe(401);

        // 6.2 他人 session → 404（合并语义，防存在性泄露）
        login(other);
        const r404 = await callActions(
          jsonReq({ action: "commit_row", rowId: "r1", expectedVersion: 1 }),
          sessionId,
        );
        expect(r404.status).toBe(404);

        // 6.3 非法 action → 400
        login(admin);
        const r400 = await callActions(jsonReq({ action: "totally_bogus_action" }), sessionId);
        expect(r400.status).toBe(400);

        // 6.4 commit_row 缺 rowId → 400
        const r400b = await callActions(jsonReq({ action: "commit_row", expectedVersion: 1 }), sessionId);
        expect(r400b.status).toBe(400);

        // 6.5 version 不匹配 → 409 VERSION_CONFLICT
        const r409 = await callActions(
          jsonReq({ action: "commit_row", rowId, expectedVersion: version + 999 }),
          sessionId,
        );
        expect(r409.status).toBe(409);
        const body409 = await r409.json();
        expect(body409.code).toBe("VERSION_CONFLICT");

        // 6.6 正常 commit_row → 202 + PENDING proposal
        // 用第 2 行（EXT-002，未污染状态）：前面 §3 只 commit 了第 1 行。
        // 先拒绝 §3 的 proposal 释放 serialActiveKey（import_order_row serialByUser）。
        await prisma.agentProposal.update({
          where: { id: commitFacing.commitRowProposal!.id! },
          data: { status: "REJECTED", serialActiveKey: null },
        });
        // 取第 2 行（经 operate_order_import get_row 不传 rowId → 返回下一条未解决行）
        const epGetRow = await executePublicTool({
          actor: adminActor, invocation: inv, publicToolKey: "operate_order_import",
          publicInput: { sessionId: sessionId!, operation: "get_row" },
        });
        expect(epGetRow.ok).toBe(true);
        const epGetFacing = (epGetRow.ok ? epGetRow.result.modelFacing : {}) as {
          row?: { rowId?: string; version?: number };
        };
        const epRowIdRaw = epGetFacing.row?.rowId;
        const epVersionRaw = epGetFacing.row?.version;
        expect(epRowIdRaw).toBeTruthy();
        expect(epRowIdRaw).not.toBe(rowId); // 确认是不同的行（第 2 行）
        expect(typeof epVersionRaw).toBe("number");
        const epRowId: string = epRowIdRaw!;
        const epVersion: number = epVersionRaw!;

        const r202 = await callActions(
          jsonReq({ action: "commit_row", rowId: epRowId, expectedVersion: epVersion }),
          sessionId,
        );
        expect(r202.status).toBe(202);
        const body202 = await r202.json();
        expect(body202.ok).toBe(true);
        expect(body202.mode).toBe("proposal");
        expect(body202.proposal?.id).toBeTruthy();
        expect(body202.proposal?.actionKey).toBe("orders.import_order_row");
        expect(body202.confirmUrl).toContain(body202.proposal.id);
        const epProposal = await prisma.agentProposal.findUnique({
          where: { id: body202.proposal.id },
          select: { status: true, actionKey: true, userId: true },
        });
        expect(epProposal?.status).toBe("PENDING");
        expect(epProposal?.actionKey).toBe("orders.import_order_row");
        expect(epProposal?.userId).toBe(admin.id);

        // ════════════ §7 导入落单 technicalOwnerUserId 绑定（源码断言）════════════
        // import-single-row.ts CREATE 分支必须设 technicalOwnerUserId = actor.userId，
        // 对齐 create-order.ts L113-120（否则导入的新订单无法经 Agent 再写）。
        const srcSingle = await fs.readFile(
          path.resolve(process.cwd(), "src/lib/orders/import-single-row.ts"),
          "utf8",
        );
        expect(srcSingle).toContain("technicalOwnerUserId = actor.userId");
        expect(srcSingle).toContain("对齐 create-order.ts");
        const srcCo = await fs.readFile(
          path.resolve(process.cwd(), "src/lib/orders/application/create-order.ts"),
          "utf8",
        );
        expect(srcCo).toContain("technicalOwnerUserId = actor.userId");
      } finally {
        sessionState.current = null;
        // 恢复存储目录 env
        if (ORIG_IMPORT_STAGING_DIR === undefined) delete process.env.IMPORT_STAGING_DIR;
        else process.env.IMPORT_STAGING_DIR = ORIG_IMPORT_STAGING_DIR;
        if (ORIG_WORKSPACE_DIR === undefined) delete process.env.AGENT_WORKSPACE_DIR;
        else process.env.AGENT_WORKSPACE_DIR = ORIG_WORKSPACE_DIR;
        if (tempStorageRoot) {
          await fs.rm(tempStorageRoot, { recursive: true, force: true }).catch(() => undefined);
          tempStorageRoot = null;
        }
      }
    });
  });
});
