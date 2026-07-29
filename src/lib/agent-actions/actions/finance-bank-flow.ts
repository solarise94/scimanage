/**
 * Agent actions：银行流水自动匹配（finance.*_bank_flow_*）。
 * 见 docs/agent-bankflow-contract-design-2026-07-23.md §1。
 */

import { StagingError } from "@/lib/import-staging";
import type { BankFlowColumnMapping } from "@/lib/finance/bank-flow-parser";
import { ApplicationError } from "@/lib/application/errors";
import { analyzeBankFlowFileForActor } from "@/lib/finance/application/analyze-bank-flow-file";
import { applyBankFlowMappingForActor } from "@/lib/finance/application/apply-bank-flow-mapping";
import { getBankFlowRowForActor } from "@/lib/finance/application/get-bank-flow-row";
import { matchBankFlowRowsForActor } from "@/lib/finance/application/match-bank-flow-rows";
import { loadBankFlowWorkspaceForActor } from "@/lib/finance/application/bank-flow-workspace-access";
import {
  confirmBankFlowBatchForActor,
  previewConfirmBankFlowBatchForActor,
} from "@/lib/finance/application/confirm-bank-flow-batch";
import { ocrBankFlowReceiptsForActor } from "@/lib/finance/application/ocr-bank-flow-receipts";
import { reopenBankFlowRowsForActor } from "@/lib/finance/application/reopen-bank-flow-rows";
import { updateBankFlowSelectionForActor } from "@/lib/finance/application/update-bank-flow-selection";
import { canReadFinance, canWriteFinance } from "@/lib/finance/permissions";
import { isGlmOcrConfigured } from "@/lib/finance/glm-ocr";
import {
  AgentActionConflictError,
  AgentActionForbiddenError,
  AgentActionInputError,
  mapDomainErrorToAgentError,
} from "../errors";
import { registerAgentAction } from "../registry";
import {
  arraySchema,
  booleanSchema,
  ensureObject,
  integerSchema,
  objectSchema,
  readOptionalArray,
  readOptionalBoolean,
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
  stringSchema,
} from "../schemas";

export {
  bankFlowStagingIdsMatch,
  stagingIdsNeedingOcr,
} from "@/lib/finance/application/ocr-bank-flow-receipts";

function readMapping(input: Record<string, unknown>): BankFlowColumnMapping {
  const mappingRaw = ensureObject(input.mapping ?? input, "mapping");
  const payerName = readRequiredString(mappingRaw, "payerName");
  const amount = readRequiredString(mappingRaw, "amount");
  return {
    payerName,
    amount,
    date: readOptionalString(mappingRaw, "date"),
    remark: readOptionalString(mappingRaw, "remark"),
    payerAccount: readOptionalString(mappingRaw, "payerAccount"),
  };
}

export function registerFinanceBankFlowActions() {
  // ─── finance.analyze_bank_flow_file ─────────────────────────
  registerAgentAction({
    key: "finance.analyze_bank_flow_file",
    title: "分析银行流水文件",
    description:
      "对私有 staging 中的银行流水文件做服务端解析、自动列映射，并创建 BANK_FLOW 工作区。接收 UPLOADED staging；已 ANALYZED 时幂等返回已有 workspace。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      { stagingFileId: stringSchema("import-staging 文件 ID") },
      ["stagingFileId"],
    ),
    outputSchema: objectSchema({
      workspaceId: stringSchema(),
      rowCount: integerSchema(),
      columns: arraySchema(stringSchema()),
      mapping: objectSchema({}),
      preview: arraySchema(objectSchema({})),
      encoding: stringSchema(),
      version: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { stagingFileId: readRequiredString(input, "stagingFileId") };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await analyzeBankFlowFileForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          input,
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.stagingFileId });
        }
        if (err instanceof StagingError) {
          throw new AgentActionConflictError(err.message);
        }
        throw err;
      }
    },
  });

  // ─── finance.apply_bank_flow_mapping ────────────────────────
  registerAgentAction({
    key: "finance.apply_bank_flow_mapping",
    title: "应用银行流水列映射",
    description:
      "修正列映射（及可选编码）后重新解析流水文件，写回 workspace manifest（phase=MAPPED）。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        workspaceId: stringSchema(),
        mapping: objectSchema({
          payerName: stringSchema(),
          amount: stringSchema(),
          date: stringSchema(),
          remark: stringSchema(),
          payerAccount: stringSchema(),
        }, ["payerName", "amount"]),
        encoding: stringSchema("utf-8 或 gb18030"),
        expectedVersion: integerSchema(),
      },
      ["workspaceId", "mapping", "expectedVersion"],
    ),
    outputSchema: objectSchema({
      rowCount: integerSchema(),
      preview: arraySchema(objectSchema({})),
      warnings: arraySchema(stringSchema()),
      newVersion: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const encoding = readOptionalString(input, "encoding");
      if (encoding && encoding !== "utf-8" && encoding !== "gb18030") {
        throw new AgentActionInputError("encoding 只能是 utf-8 或 gb18030");
      }
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      return {
        workspaceId: readRequiredString(input, "workspaceId"),
        mapping: readMapping(input),
        encoding: encoding as "utf-8" | "gb18030" | undefined,
        expectedVersion,
      };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await applyBankFlowMappingForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          input,
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        if (err instanceof StagingError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });

  // ─── finance.match_bank_flow_rows ───────────────────────────
  registerAgentAction({
    key: "finance.match_bank_flow_rows",
    title: "匹配银行流水行",
    description:
      "对已映射的流水行做组织解析 + 发票子集匹配。≤50 行同步；>50 行或 async=true 时创建后台 Job（phase=MATCHING）。只处理 status=PENDING 的行。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        workspaceId: stringSchema(),
        rowIndices: arraySchema(integerSchema()),
        expectedVersion: integerSchema(),
        async: booleanSchema("强制异步匹配"),
      },
      ["workspaceId", "expectedVersion"],
    ),
    outputSchema: objectSchema({
      mode: stringSchema(),
      results: arraySchema(objectSchema({})),
      summary: objectSchema({}),
      newVersion: integerSchema(),
      jobId: stringSchema(),
      workspaceId: stringSchema(),
      rowCount: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      const rowIndicesRaw = readOptionalArray(input, "rowIndices");
      const rowIndices = rowIndicesRaw?.map((v, i) => {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          throw new AgentActionInputError(`rowIndices[${i}] must be a non-negative integer`);
        }
        return v;
      });
      return {
        workspaceId: readRequiredString(input, "workspaceId"),
        rowIndices,
        expectedVersion,
        async: readOptionalBoolean(input, "async") ?? false,
      };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await matchBankFlowRowsForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          {
            workspaceId: input.workspaceId,
            rowIndices: input.rowIndices,
            expectedVersion: input.expectedVersion,
            async: input.async,
            agentRunId: invocation.agentRunId ?? null,
          },
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });

  // ─── finance.get_bank_flow_row ──────────────────────────────
  registerAgentAction({
    key: "finance.get_bank_flow_row",
    title: "查看银行流水行详情",
    description: "返回单行完整匹配详情（候选组织、发票组合、最近邻）。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        workspaceId: stringSchema(),
        rowIndex: integerSchema(),
      },
      ["workspaceId", "rowIndex"],
    ),
    outputSchema: objectSchema({
      row: objectSchema({}),
      match: objectSchema({}),
      phase: stringSchema(),
      version: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const rowIndex = readOptionalInteger(input, "rowIndex", { min: 0 });
      if (rowIndex == null) throw new AgentActionInputError("rowIndex is required");
      return {
        workspaceId: readRequiredString(input, "workspaceId"),
        rowIndex,
      };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await getBankFlowRowForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          input,
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });

  // ─── finance.update_bank_flow_selection ─────────────────────
  registerAgentAction({
    key: "finance.update_bank_flow_selection",
    title: "更新银行流水行选择",
    description: "修正某一行的组织或匹配组合选择；可标记跳过。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        workspaceId: stringSchema(),
        rowIndex: integerSchema(),
        organizationId: stringSchema(),
        combinationIndex: integerSchema(),
        skip: booleanSchema(),
        expectedVersion: integerSchema(),
      },
      ["workspaceId", "rowIndex", "expectedVersion"],
    ),
    outputSchema: objectSchema({
      updated: booleanSchema(),
      row: objectSchema({}),
      newVersion: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const rowIndex = readOptionalInteger(input, "rowIndex", { min: 0 });
      if (rowIndex == null) throw new AgentActionInputError("rowIndex is required");
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      return {
        workspaceId: readRequiredString(input, "workspaceId"),
        rowIndex,
        organizationId: readOptionalString(input, "organizationId"),
        combinationIndex: readOptionalInteger(input, "combinationIndex", { min: 0 }),
        skip: readOptionalBoolean(input, "skip"),
        expectedVersion,
      };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await updateBankFlowSelectionForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          input,
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });

  // ─── finance.reopen_bank_flow_rows ──────────────────────────
  registerAgentAction({
    key: "finance.reopen_bank_flow_rows",
    title: "重开失败的银行流水行",
    description:
      "仅 PARTIAL_FAILED 可用：将指定 FAILED 行重置为 PENDING，phase→MATCHED，清空 boundProposalId。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "none", narration: "normal" },
    inputSchema: objectSchema(
      {
        workspaceId: stringSchema(),
        rowIndices: arraySchema(integerSchema()),
        expectedVersion: integerSchema(),
      },
      ["workspaceId", "rowIndices", "expectedVersion"],
    ),
    outputSchema: objectSchema({
      reopened: integerSchema(),
      newVersion: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      const rowIndicesRaw = readOptionalArray(input, "rowIndices");
      if (!rowIndicesRaw || rowIndicesRaw.length === 0) {
        throw new AgentActionInputError("rowIndices is required");
      }
      const rowIndices = rowIndicesRaw.map((v, i) => {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          throw new AgentActionInputError(`rowIndices[${i}] must be a non-negative integer`);
        }
        return v;
      });
      return {
        workspaceId: readRequiredString(input, "workspaceId"),
        rowIndices,
        expectedVersion,
      };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await reopenBankFlowRowsForActor(actor, input);
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });

  // ─── finance.confirm_bank_flow_batch ────────────────────────
  registerAgentAction({
    key: "finance.confirm_bank_flow_batch",
    title: "确认银行流水批次核销",
    description:
      "用户确认后，按匹配结果逐行创建回款。行级幂等键防重复；部分失败保持 ACTIVE 供重试。",
    domain: "finance",
    riskLevel: "confirm",
    readOnly: false,
    serialByUser: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        workspaceId: stringSchema(),
        expectedVersion: integerSchema(),
      },
      ["workspaceId", "expectedVersion"],
    ),
    outputSchema: objectSchema({
      created: integerSchema(),
      failed: integerSchema(),
      skipped: integerSchema(),
      totalAmountCents: integerSchema(),
      results: arraySchema(objectSchema({})),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      return {
        workspaceId: readRequiredString(input, "workspaceId"),
        expectedVersion,
      };
    },
    async availability(actor) {
      return canWriteFinance(actor.role);
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      if (!canWriteFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        return await previewConfirmBankFlowBatchForActor(actor, input);
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canWriteFinance(actor.role)) throw new AgentActionForbiddenError();
      const proposalId = invocation.proposalId;
      if (!proposalId) {
        throw new AgentActionInputError("confirm 执行缺少 proposalId");
      }
      try {
        return await confirmBankFlowBatchForActor(
          actor,
          { ...input, proposalId },
          { invocation: { channel: "agent", proposalId } },
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });

  // ─── finance.ocr_bank_flow_receipts ─────────────────────────
  registerAgentAction({
    key: "finance.ocr_bank_flow_receipts",
    title: "OCR 识别银行回单图片",
    description:
      "对已上传到 import-staging（importKind=BANK_FLOW）的回单图片/PDF 调用 GLM-OCR，合成流水行并创建 BANK_FLOW workspace（phase=MAPPED）。"
      + "整批 staging 原子 claim + sessionId 绑定，逐文件 CAS 进度，重试幂等复用已有 workspace 并跳过已完成文件。"
      + "计费语义为至少一次：GLM 无供应商侧幂等键，OCR 成功到 CAS 落盘之间崩溃时，该未完成文件最多再请求一次。"
      + "不自动匹配/核销。OCR 未配置时不可用。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        stagingFileIds: arraySchema(stringSchema("import-staging 文件 ID")),
      },
      ["stagingFileIds"],
    ),
    outputSchema: objectSchema({
      workspaceId: stringSchema(),
      rowCount: integerSchema(),
      preview: arraySchema(objectSchema({})),
      warnings: arraySchema(stringSchema()),
      version: integerSchema(),
      source: stringSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const idsRaw = readOptionalArray(input, "stagingFileIds");
      if (!idsRaw || idsRaw.length === 0) {
        throw new AgentActionInputError("stagingFileIds is required");
      }
      if (idsRaw.length > 20) {
        throw new AgentActionInputError("单次最多 20 张回单");
      }
      const stagingFileIds = idsRaw.map((v, i) => {
        if (typeof v !== "string" || !v.trim()) {
          throw new AgentActionInputError(`stagingFileIds[${i}] must be a non-empty string`);
        }
        return v.trim();
      });
      // 排序后去重，保证同一批文件指纹稳定，便于幂等复用
      return { stagingFileIds: [...new Set(stagingFileIds)].sort() };
    },
    async availability(actor) {
      return canReadFinance(actor.role) && isGlmOcrConfigured();
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        return await ocrBankFlowReceiptsForActor(actor, input);
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: "回单 OCR" });
        }
        throw err;
      }

    },
  });

  // ─── finance.get_bank_flow_workspace_state（safe / 只读）─────────────────────
  // P0-3 断链修复辅助：public facade（operate_bank_flow）需要 workspace 当前
  // version + phase 以编排 operation dispatch 与 nextAction，但 facade 不得直连
  // canonical service（AGENTS.md 铁律）。本 action 经 loadBankFlowWorkspaceForActor
  // （owner gate + phase 校验）解析，返回 version/phase 供 facade 注入。
  // owner gate 在 loadBankFlowWorkspaceForActor 内（不存在/越权合并 404）。
  registerAgentAction({
    key: "finance.get_bank_flow_workspace_state",
    title: "读取银行流水工作区状态",
    description:
      "按 owner gate 读取银行流水工作区当前 version 与 phase，供 operate_bank_flow facade 编排 operation dispatch 与 nextAction。不写任何数据。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "none", narration: "minimal" },
    inputSchema: objectSchema(
      { workspaceId: stringSchema("流水工作区 ID") },
      ["workspaceId"],
    ),
    outputSchema: objectSchema({
      workspaceId: stringSchema(),
      version: integerSchema(),
      phase: stringSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { workspaceId: readRequiredString(input, "workspaceId") };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();
      try {
        const ws = await loadBankFlowWorkspaceForActor({
          workspaceId: input.workspaceId,
          actorUserId: actor.userId,
        });
        return {
          workspaceId: ws.workspaceId,
          version: ws.version,
          phase: ws.manifest.phase,
        };
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.workspaceId });
        }
        throw err;
      }
    },
  });
}
