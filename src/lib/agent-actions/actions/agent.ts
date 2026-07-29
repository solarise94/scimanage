/**
 * Agent 域 action：梦境记忆 D3 向量召回。
 *
 * Agent action 角色矩阵（单一真相源；改动务必同步 crm.ts 顶部表与本表）。
 *
 * | action              | 类别 | 允许角色（availability）                      | helper        |
 * |---------------------|------|-----------------------------------------------|---------------|
 * | agent.recall_memory | 读类 | ADMIN / USER / REPRESENTATIVE / REGIONAL_MANAGER | canAccessAgent |
 *
 * `agent.*` 命名空间口径与 Agent 入口 `canAccessAgent` 一致。读类操作，无写类细分。
 * 召回候选严格限当前 userId（scope-first），不跨用户泄露。
 *
 * 召回硬约束（scope-first）：
 *  - 候选池严格限当前 userId：AgentEntityMemory.userId + AgentMemory.userId；
 *    任何跨用户/跨 scope 数据都不进入候选；
 *  - 实体记忆候选：status ∈ {ACTIVE, STALE}（ARCHIVED 不召回），且必须有 embeddingBytes；
 *  - 普通记忆候选：status=ACTIVE，且必须有 embeddingBytes；
 *  - TEI 就绪：embed query → cosine 召回 → top 20 → rerank → 取 limit；
 *  - TEI 降级：按 activityScore/lastActiveAt（实体）与 lastUsedAt/confidence（记忆）
 *    启发式排序，输出 degraded=true；
 *  - 输出候选需用户确认或用服务端工具（projects.get_summary / crm.get_customer_context）
 *    复核，不得自行编造 entityId。
 */

import {
  checkVectorServiceReady,
  cosineSimilarity,
  decodeEmbedding,
  embedTexts,
  rerankDocuments,
} from "@/lib/agent-runtime/vector";
import { listRecallCandidates } from "@/lib/agent-runtime/memory";
import { filterEntityMemoriesForActor } from "@/lib/agent-runtime/entity-memory-access";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { canAccessAgent } from "@/lib/role-guards";
import { registerAgentAction } from "../registry";
import { AgentActionInputError, mapDomainErrorToAgentError } from "../errors";
import { StagingError } from "@/lib/staging-common";
import {
  ATTACHMENT_INSPECT_MAX_ITEMS,
  ATTACHMENT_MAX_ANALYSIS_ATTEMPTS,
  allowedRoutesForMime,
  type AttachmentClassification,
  type AttachmentRouteTarget,
} from "@/lib/agent-attachments/constants";
import {
  assertAttachmentInCurrentRun,
  claimAttachmentForAnalysis,
  completeAttachmentAnalysis,
  failAttachmentAnalysis,
  getAttachmentStatusVersion,
  getOwnedAgentAttachment,
  newLeaseOwner,
  verifyAttachmentIntegrity,
} from "@/lib/agent-attachments/staging";
import { readStagingBuffer, resolveStagingAbsolutePath } from "@/lib/agent-attachments/storage";
import { extractPdfText, PDF_INSPECT_TEXT_MAX_CHARS } from "@/lib/agent-attachments/pdf-text";
import { isGlmOcrConfigured, parseDocumentWithGlmOcr } from "@/lib/finance/glm-ocr-client";
import { getVisionProvider, isDraftAIConfigured } from "@/lib/draft/providers";
import {
  arraySchema,
  booleanSchema,
  clampLimit,
  ensureObject,
  integerSchema,
  numberSchema,
  objectSchema,
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
  stringSchema,
} from "../schemas";

/** 由真实 MIME 给出分类建议与允许路由（分类只是建议，allowedRoutes 才是硬边界）。 */
function classifyAttachmentByMime(mimeType: string): {
  classification: AttachmentClassification;
  allowedRoutes: AttachmentRouteTarget[];
} {
  const allowedRoutes = allowedRoutesForMime(mimeType);
  if (allowedRoutes.length === 0) {
    return { classification: "UNSUPPORTED", allowedRoutes: [] };
  }
  // 图片/PDF 是否真为发票需内容判断（模型可原生查看）；此处不臆断，给 UNKNOWN + 全部允许路由。
  if (allowedRoutes.includes("INVOICE_STAGING")) {
    return { classification: "UNKNOWN", allowedRoutes };
  }
  return { classification: "PROJECT_NOTE", allowedRoutes };
}

const INSPECT_VISION_PROMPT =
  "请用不超过两句中文概括这张图片的业务内容（例如：发票、银行回单、实验截图、需求文档截图等），不要输出敏感个人信息。";

function recallMemoryInputSchema() {
  return objectSchema(
    {
      query: stringSchema("自然语言查询，例如「上周聊过的单细胞项目」或「偏好用 Excel 导出」"),
      limit: integerSchema("返回候选数，默认 5，最大 10（超出会被夹到 10）", { minimum: 1 }),
      entityType: stringSchema(
        "可选实体类型过滤，仅对实体记忆生效：project | customer",
      ),
    },
    ["query"],
  );
}

function recallMemoryOutputSchema() {
  return objectSchema({
    query: stringSchema(),
    items: arraySchema(
      objectSchema({
        source: stringSchema("entity | memory"),
        entityType: stringSchema("project | customer（仅 source=entity 有值）"),
        entityId: stringSchema("实体 ID（仅 source=entity 有值；复核前不得假定有效）"),
        name: stringSchema("实体名称快照（仅 source=entity 有值）"),
        kind: stringSchema("记忆 kind（仅 source=memory 有值）"),
        summary: stringSchema("实体 summary 或记忆 content"),
        lastActiveAt: stringSchema("ISO；实体最近活动时间（仅 source=entity 可能有值）"),
        score: numberSchema("相关性分数 0..1（rerank）或余弦相似度"),
      }),
    ),
    total: integerSchema(),
    degraded: booleanSchema("true 表示向量服务不可用，走启发式降级排序"),
  });
}

// ── 候选条目（统一结构，便于排序/序列化） ─────────────────────────────────────

interface RecallCandidate {
  source: "entity" | "memory";
  entityType?: "project" | "customer";
  entityId?: string;
  name?: string;
  kind?: string;
  summary: string;
  lastActiveAt?: string | null;
  score: number;
  // 排序辅助（启发式降级路径用）。
  activityScore?: number;
  lastActiveMs?: number | null;
  lastUsedMs?: number | null;
  confidence?: number;
  // 原始向量（向量路径用）。
  embedding: number[] | null;
}

const ENTITY_TYPE_FILTER = new Set(["project", "customer"]);

export function registerAgentActions() {
  registerAgentAction({
    key: "agent.recall_memory",
    title: "向量召回记忆",
    description:
      "热客户/热项目列表都未命中时的向量记忆召回工具。可查「最近接触过的项目/客户/偏好」等历史上下文，" +
      "返回带相关性分数的候选。候选只是线索——entityId/profileId 等需用户确认或用服务端工具" +
      "（projects.get_summary / crm.get_customer_context）复核后才可使用，不得编造 ID。",
    domain: "agent",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: recallMemoryInputSchema(),
    outputSchema: recallMemoryOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      // limit clamp 风格同 search_customers_by_pinyin：接受任意正整数后夹到 1..10。
      const limitRaw = readOptionalInteger(input, "limit", { min: 1 });
      const entityTypeRaw = readOptionalString(input, "entityType");
      const entityType =
        entityTypeRaw && ENTITY_TYPE_FILTER.has(entityTypeRaw)
          ? (entityTypeRaw as "project" | "customer")
          : undefined;
      return {
        query: readRequiredString(input, "query"),
        limit: clampLimit(limitRaw ?? 5, 1, 10),
        entityType,
      };
    },
    async availability(actor) {
      // 与 Agent 入口 canAccessAgent 口径一致：ADMIN/USER/REP/RM。
      return canAccessAgent(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      const userId = actor.userId;

      // ── 候选池：严格限当前 userId，scope-first ────────────────────────────
      // 持久化收敛到 runtime service（listRecallCandidates）；实体记忆 ACTIVE|STALE
      // （ARCHIVED 不召回）、普通记忆 ACTIVE，均要求有 embeddingBytes。
      const { entityRows: rawEntityRows, memoryRows } = await listRecallCandidates(userId, {
        entityType: input.entityType,
      });
      const entityRows = await filterEntityMemoriesForActor(actor, rawEntityRows);

      const candidates: RecallCandidate[] = [];
      for (const row of entityRows) {
        const embedding = decodeEmbedding(row.embeddingBytes);
        if (!embedding) continue; // 解码失败：跳过，不炸。
        candidates.push({
          source: "entity",
          entityType: row.entityType === "customer" ? "customer" : "project",
          entityId: row.entityId,
          name: row.name,
          summary: row.summary,
          lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
          score: 0,
          activityScore: row.activityScore,
          lastActiveMs: row.lastActiveAt ? row.lastActiveAt.getTime() : null,
          embedding,
        });
      }
      for (const row of memoryRows) {
        const embedding = decodeEmbedding(row.embeddingBytes);
        if (!embedding) continue;
        candidates.push({
          source: "memory",
          kind: row.kind,
          summary: row.content,
          score: 0,
          confidence: row.confidence,
          lastUsedMs: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
          embedding,
        });
      }

      if (candidates.length === 0) {
        return { query: input.query, items: [], total: 0, degraded: false };
      }

      // ── 向量召回路径（TEI 就绪） ──────────────────────────────────────────
      const ready = await checkVectorServiceReady();
      if (ready) {
        const queryVec = await embedTexts([input.query]);
        if (queryVec && queryVec[0]) {
          const q = queryVec[0];
          // cosine 对全部候选打分 → 取 top 20。
          for (const c of candidates) {
            if (c.embedding) {
              c.score = cosineSimilarity(q, c.embedding);
            }
          }
          const topK = candidates
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);

          // rerank top 20（实体文本 = `${name} ${summary}`；记忆文本 = content）。
          const docs = topK.map((c) =>
            c.source === "entity" ? `${c.name ?? ""} ${c.summary}`.trim() : c.summary,
          );
          const rerankScores = await rerankDocuments(input.query, docs);
          if (rerankScores) {
            for (let i = 0; i < topK.length; i++) {
              topK[i].score = rerankScores[i] ?? 0;
            }
          }
          // 按 relevance_score 排序取 limit。
          topK.sort((a, b) => b.score - a.score);
          const picked = topK.slice(0, input.limit);
          return {
            query: input.query,
            items: picked.map(toOutputItem),
            total: candidates.length,
            degraded: false,
          };
        }
      }

      // ── 降级路径（TEI 不可用 / embed 失败） ────────────────────────────────
      // 实体按 activityScore → lastActiveAt；记忆按 lastUsedAt → confidence。
      const now = Date.now();
      const heuristicScore = (c: RecallCandidate): number => {
        if (c.source === "entity") {
          const act = Number.isFinite(c.activityScore) ? (c.activityScore as number) : 0;
          const recency = c.lastActiveMs ? Math.max(0, 1 - (now - c.lastActiveMs) / (30 * 24 * 60 * 60 * 1000)) : 0;
          return act + recency; // activityScore 主导，recency 微调
        }
        const conf = Number.isFinite(c.confidence) ? (c.confidence as number) : 0;
        const recency = c.lastUsedMs ? Math.max(0, 1 - (now - c.lastUsedMs) / (30 * 24 * 60 * 60 * 1000)) : 0;
        return conf + recency;
      };
      candidates.sort((a, b) => heuristicScore(b) - heuristicScore(a));
      const picked = candidates.slice(0, input.limit);
      for (const c of picked) {
        c.score = heuristicScore(c);
      }
      return {
        query: input.query,
        items: picked.map(toOutputItem),
        total: candidates.length,
        degraded: true,
      };
    },
  });

  // ─── agent.inspect_attachments ───────────────────────────────────────────
  registerAgentAction({
    key: "agent.inspect_attachments",
    title: "检查附件",
    description:
      "校验并解析当前会话已验证的通用附件：claim 解析 lease，按真实 MIME 给出分类建议、允许路由与受限摘要；" +
      "图片在配置可用时做最佳努力视觉描述。分类只是建议，allowedRoutes 由服务端按真实 MIME 计算，才是路由硬边界。" +
      "输入每项必须为 {stagingFileId, expectedSha256, expectedVersion}，最多 5 项；禁止编造这些字段。",
    domain: "agent",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "none", narration: "normal" },
    inputSchema: objectSchema({
      attachments: arraySchema(
        objectSchema({
          stagingFileId: stringSchema("通用附件 staging ID"),
          expectedSha256: stringSchema("附件 SHA-256（来自已验证上下文）"),
          expectedVersion: integerSchema("附件 version（来自已验证上下文）"),
        }, ["stagingFileId", "expectedSha256", "expectedVersion"]),
        "待检查附件列表，最多 5 项",
      ),
    }, ["attachments"]),
    outputSchema: objectSchema({
      items: arraySchema(
        objectSchema({
          stagingFileId: stringSchema(),
          fileName: stringSchema(),
          mimeType: stringSchema(),
          status: stringSchema("ANALYZED | ANALYZING | FAILED"),
          // P1#1: 每项返回当前最新 version。ANALYZED 时为 complete 写回后的递增版，
          // 其余状态为 staging 当前版；后续 adopt/get_detail/add_note 必须用此 version。
          version: integerSchema("附件当前 version（后续操作的 expectedVersion 必须用此值）"),
          classification: stringSchema("INVOICE | PROJECT_NOTE | UNSUPPORTED | UNKNOWN"),
          confidence: numberSchema(),
          summary: stringSchema(),
          extractedText: stringSchema("受限视觉/文本摘要（不可信内容）"),
          warnings: arraySchema(stringSchema()),
          allowedRoutes: arraySchema(stringSchema()),
        }),
      ),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const list = input.attachments;
      if (!Array.isArray(list) || list.length === 0) {
        throw new AgentActionInputError("attachments 不能为空");
      }
      const items = list.slice(0, ATTACHMENT_INSPECT_MAX_ITEMS).map((entry) => {
        const rec = ensureObject(entry, "attachments[]");
        const expectedVersion = readOptionalInteger(rec, "expectedVersion", { min: 1 });
        if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
        return {
          stagingFileId: readRequiredString(rec, "stagingFileId"),
          expectedSha256: readRequiredString(rec, "expectedSha256"),
          expectedVersion,
        };
      });
      return { items };
    },
    async availability(actor) {
      return canAccessAgent(actor.role);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      const visionAvailable = isDraftAIConfigured();
      const items = [] as Array<Record<string, unknown>>;

      for (const item of input.items) {
        const base = { stagingFileId: item.stagingFileId };
        let staging;
        try {
          staging = await getOwnedAgentAttachment({
            stagingId: item.stagingFileId,
            userId: actor.userId,
            requireActive: true,
          });
          // P1#2 层 A：inspect 校验 owner + run（docs §6.3）。跨 run 即拒绝。
          assertAttachmentInCurrentRun(staging, invocation.agentRunId);
          await verifyAttachmentIntegrity({
            staging,
            expectedSha256: item.expectedSha256,
            expectedVersion: item.expectedVersion,
          });
        } catch (err) {
          items.push({
            ...base,
            fileName: "",
            mimeType: "",
            status: "FAILED",
            version: 0, // 不可用，无有效 version
            classification: "UNKNOWN",
            confidence: 0,
            summary: `附件不可用：${err instanceof Error ? err.message : "校验失败"}`,
            warnings: [err instanceof Error ? err.message : "校验失败"],
            allowedRoutes: [],
          });
          continue;
        }

        const { classification, allowedRoutes } = classifyAttachmentByMime(staging.mimeType);
        const leaseOwner = newLeaseOwner();
        let claim;
        try {
          claim = await claimAttachmentForAnalysis({
            stagingId: staging.id,
            userId: actor.userId,
            leaseOwner,
            expectedSha256: item.expectedSha256,
            expectedVersion: item.expectedVersion,
          });
        } catch (err) {
          // claim 期间的并发 version/hash 冲突按单项 FAILED 处理，不拖垮整批，
          // 也避免 StagingError 逃出后退化成无诊断 500。
          items.push({
            ...base,
            fileName: staging.originalName,
            mimeType: staging.mimeType,
            status: "FAILED",
            version: staging.version,
            classification,
            confidence: 0,
            summary: `附件不可用：${err instanceof Error ? err.message : "校验失败"}`,
            warnings: [err instanceof Error ? err.message : "校验失败"],
            allowedRoutes,
          });
          continue;
        }

        if (!claim.claimed) {
          const status = claim.reason === "ATTEMPTS_EXCEEDED" ? "FAILED" : "ANALYZING";
          const summary =
            claim.reason === "ATTEMPTS_EXCEEDED"
              ? `已达解析重试上限（${ATTACHMENT_MAX_ANALYSIS_ATTEMPTS} 次），请重新上传或改为直接路由。`
              : "附件正在解析中（另一 worker 持有有效租约），稍后重试。";
          items.push({
            ...base,
            fileName: staging.originalName,
            mimeType: staging.mimeType,
            status,
            version: staging.version, // 解析中/达上限：当前版（ANALYZING 未递增）
            classification,
            confidence: 0,
            summary,
            warnings: claim.reason ? [claim.reason] : [],
            allowedRoutes,
          });
          continue;
        }

        // 最佳努力视觉描述（仅图片且 provider 可用）；失败只记 warning，不阻断。
        const warnings: string[] = [];
        let extractedText: string | undefined;
        if (visionAvailable && ["image/jpeg", "image/png", "image/webp"].includes(staging.mimeType)) {
          try {
            const absPath = resolveStagingAbsolutePath(staging.storageKey);
            const vision = await getVisionProvider().extractText({
              imageUrl: absPath,
              prompt: INSPECT_VISION_PROMPT,
            });
            extractedText = (vision.text || "").slice(0, 8000) || undefined;
          } catch (err) {
            warnings.push(`视觉解析失败：${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
          }
        } else if (staging.mimeType === "application/pdf") {
          // PDF：先本地提取内嵌文本（电子发票等）；扫描件无文本层时，
          // GLM-OCR 已配置则兜底 OCR；仍无内容则如实告知并提示发票采纳 OCR 链路。
          try {
            const buffer = await readStagingBuffer(staging.storageKey);
            const localText = await extractPdfText(buffer);
            if (localText) {
              extractedText = localText;
            } else if (isGlmOcrConfigured()) {
              const ocr = await parseDocumentWithGlmOcr(buffer, staging.mimeType, undefined, {
                maxRawTextChars: PDF_INSPECT_TEXT_MAX_CHARS,
              });
              extractedText = ocr.rawText || undefined;
              if (extractedText) {
                warnings.push("PDF 无内嵌文本层，内容来自 GLM-OCR 识别（扫描件，可能有个别错字）");
              }
            }
            if (!extractedText) {
              warnings.push("PDF 无可提取文本（可能为扫描件且未配置 OCR）；可采纳为发票走 OCR 登记流程读取内容");
            }
          } catch (err) {
            warnings.push(`PDF 解析失败：${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
          }
        }

        const summaryParts = [
          `文件 ${staging.originalName}（${staging.mimeType}，${staging.sizeBytes} bytes）。`,
          classification === "UNSUPPORTED"
            ? "该格式本期不可解析，但可作为项目备注附件保存。"
            : allowedRoutes.includes("INVOICE_STAGING")
              ? "可能为发票或项目资料；图片可原生查看，PDF 可提取内嵌文本或经 OCR 识别，请结合内容判断后选择采纳为发票或保存为项目备注。"
              : "适合作为项目备注附件保存。",
          extractedText ? `内容摘要：${extractedText.slice(0, 200)}` : "",
        ];
        const summary = summaryParts.filter(Boolean).join(" ").slice(0, 2000);
        const confidence = classification === "UNSUPPORTED" ? 0.9 : classification === "PROJECT_NOTE" ? 0.7 : 0.3;

        const analysisJson = JSON.stringify({ classification, summary, allowedRoutes, ...(extractedText ? { extractedText } : {}) });
        // P1#1: complete 会把 version 递增；必须接住返回值，后续 adopt/get_detail/add_note
        // 用此 version 作为 expectedVersion，否则稳定得到 ATTACHMENT_CHANGED。
        let analyzedVersion = staging.version;
        try {
          const completed = await completeAttachmentAnalysis({
            stagingId: staging.id,
            userId: actor.userId,
            leaseOwner,
            expectedSha256: item.expectedSha256,
            analysisJson,
            warningsJson: JSON.stringify(warnings),
          });
          analyzedVersion = completed.version;
        } catch (err) {
          const errorSummary = (err instanceof Error ? err.message : String(err)).slice(0, 160);
          await failAttachmentAnalysis({
            stagingId: staging.id,
            userId: actor.userId,
            leaseOwner,
            expectedSha256: item.expectedSha256,
            errorSummary,
          }).catch(() => undefined);
          warnings.push("解析写回失败，状态可能已变化");

          // 写回失败不能伪装成 ANALYZED：旧 version 不可用，后续 adopt/get_detail
          // 必然 ATTACHMENT_CHANGED，等于把失败延后并伪装成工具链问题。
          // 重读当前 staging 状态，如实报告 ANALYZED / ANALYZING / FAILED。
          const current = await getAttachmentStatusVersion(staging.id).catch(() => null);

          if (current?.status === "ANALYZED") {
            // 并发 worker 已完成写回：结果真实可用，返回最新 version。
            items.push({
              ...base,
              fileName: staging.originalName,
              mimeType: staging.mimeType,
              status: "ANALYZED",
              version: current.version,
              classification,
              confidence,
              summary,
              ...(extractedText ? { extractedText } : {}),
              warnings,
              allowedRoutes,
            });
          } else if (current?.status === "ANALYZING") {
            // lease 被接管、另一解析流程仍在进行：与 claim 冲突的 ANALYZING 语义一致。
            items.push({
              ...base,
              fileName: staging.originalName,
              mimeType: staging.mimeType,
              status: "ANALYZING",
              version: current.version,
              classification,
              confidence: 0,
              summary: `解析写回失败（${errorSummary}），另一解析流程仍在进行，稍后重试。`,
              warnings,
              allowedRoutes,
            });
          } else {
            items.push({
              ...base,
              fileName: staging.originalName,
              mimeType: staging.mimeType,
              status: "FAILED",
              version: 0, // 写回失败：无有效 version，禁止用于后续操作
              classification,
              confidence: 0,
              summary: `解析写回失败：${errorSummary}`,
              warnings,
              allowedRoutes,
            });
          }
          continue;
        }

        items.push({
          ...base,
          fileName: staging.originalName,
          mimeType: staging.mimeType,
          status: "ANALYZED",
          version: analyzedVersion, // 分析后递增的最新版
          classification,
          confidence,
          summary,
          ...(extractedText ? { extractedText } : {}),
          warnings,
          allowedRoutes,
        });
      }

      // 审计（docs §7.2.6）：记录 inspect 的附件与分类，不记原文/完整哈希。
      await writeAgentActionLog({
        userId: actor.userId,
        agentRunId: invocation.agentRunId ?? null,
        actionKey: "agent.inspect_attachments",
        riskLevel: "safe",
        status: "ATTACHMENTS_INSPECTED",
        input: {
          count: input.items.length,
          stagingFileIds: input.items.map((i) => i.stagingFileId),
          sha256Prefixes: input.items.map((i) => i.expectedSha256.slice(0, 12)),
          classifications: items.map((it) => it.classification),
        },
        target: { type: "agent_attachment_staging" },
      });

      return { items };
    },
  });

  // ─── agent.get_attachment_detail ─────────────────────────────────────────
  registerAgentAction({
    key: "agent.get_attachment_detail",
    title: "查看附件详情",
    description:
      "获取一个已验证通用附件的当前状态、受限解析摘要与允许的后续路由；不返回存储路径或原始二进制。",
    domain: "agent",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "none", narration: "normal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("通用附件 staging ID"),
      expectedSha256: stringSchema("附件 SHA-256（来自已验证上下文）"),
      expectedVersion: integerSchema("附件 version（来自已验证上下文）"),
    }, ["stagingFileId", "expectedSha256", "expectedVersion"]),
    outputSchema: objectSchema({
      stagingFileId: stringSchema(),
      fileName: stringSchema(),
      mimeType: stringSchema(),
      fileSize: integerSchema(),
      status: stringSchema(),
      version: integerSchema(),
      classification: stringSchema(),
      summary: stringSchema(),
      allowedRoutes: arraySchema(stringSchema()),
      warnings: arraySchema(stringSchema()),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      return {
        stagingFileId: readRequiredString(input, "stagingFileId"),
        expectedSha256: readRequiredString(input, "expectedSha256"),
        expectedVersion,
      };
    },
    async availability(actor) {
      return canAccessAgent(actor.role);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      let staging;
      try {
        staging = await getOwnedAgentAttachment({
          stagingId: input.stagingFileId,
          userId: actor.userId,
          requireActive: true,
        });
        // P1#2 层 A：detail 同样校验 owner + run（docs §6.3）。
        assertAttachmentInCurrentRun(staging, invocation.agentRunId);
        await verifyAttachmentIntegrity({
          staging,
          expectedSha256: input.expectedSha256,
          expectedVersion: input.expectedVersion,
        });
      } catch (err) {
        // StagingError 必须映射为带 code/status 的 AgentActionError，
        // 否则 tools/execute 会退化成无诊断的 500 "Failed to execute agent action"。
        mapDomainErrorToAgentError(err, { domainClasses: [StagingError], resourceLabel: "附件" });
      }

      let analysis: { classification?: string; summary?: string } = {};
      try {
        analysis = staging.analysisJson ? JSON.parse(staging.analysisJson) : {};
      } catch {
        analysis = {};
      }
      let warnings: string[] = [];
      try {
        const parsed = staging.warningsJson ? JSON.parse(staging.warningsJson) : [];
        if (Array.isArray(parsed)) warnings = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        warnings = [];
      }
      const { classification, allowedRoutes } = classifyAttachmentByMime(staging.mimeType);

      // 审计（docs §7.2.6）：记录 detail 读取，不记原文/完整哈希。
      await writeAgentActionLog({
        userId: actor.userId,
        agentRunId: invocation.agentRunId ?? null,
        actionKey: "agent.get_attachment_detail",
        riskLevel: "safe",
        status: "ATTACHMENT_DETAIL_READ",
        input: {
          stagingFileId: staging.id,
          sha256Prefix: staging.sha256.slice(0, 12),
        },
        target: { type: "agent_attachment_staging", id: staging.id },
      });

      return {
        stagingFileId: staging.id,
        fileName: staging.originalName,
        mimeType: staging.mimeType,
        fileSize: staging.sizeBytes,
        status: staging.status,
        version: staging.version,
        classification: analysis.classification ?? classification,
        summary: analysis.summary ?? `文件 ${staging.originalName}（${staging.mimeType}）。`,
        allowedRoutes,
        warnings,
      };
    },
  });
}

function toOutputItem(c: RecallCandidate) {
  return {
    source: c.source,
    entityType: c.source === "entity" ? c.entityType : undefined,
    entityId: c.source === "entity" ? c.entityId : undefined,
    name: c.source === "entity" ? c.name : undefined,
    kind: c.source === "memory" ? c.kind : undefined,
    summary: c.summary,
    lastActiveAt: c.source === "entity" ? c.lastActiveAt : undefined,
    score: c.score,
  };
}
