import { canContributeProject } from "@/lib/permissions";
import { isDraftAIConfigured } from "@/lib/draft/providers";
import {
  isProjectNoteCategory,
  PROJECT_NOTE_CATEGORIES,
  PROJECT_NOTE_CATEGORY_LABELS,
  PROJECT_NOTE_MAX_LENGTH,
  type ProjectNoteCategory,
} from "@/lib/project-notes/constants";
import { canAccessAgent } from "@/lib/role-guards";
import { runProjectAutoDraft } from "../draft-helpers";
import {
  AgentActionForbiddenError,
  AgentActionInputError,
  mapDomainErrorToAgentError,
} from "../errors";
import { registerAgentAction } from "../registry";
import { arraySchema, clampLimit, ensureObject, integerSchema, numberSchema, objectSchema, readOptionalInteger, readOptionalNumber, readOptionalString, readRequiredString, stringSchema } from "../schemas";
import {
  ATTACHMENT_MAX_FILES_PER_MESSAGE,
} from "@/lib/agent-attachments/constants";
import {
  NOTE_ATTACHMENT_PROPOSAL_LIFECYCLE_KEY,
  registerNoteAttachmentProposalLifecycle,
} from "@/lib/projects/application/note-attachment-proposal-lifecycle";
import {
  addProjectNoteForActor,
  listProjectNotesForActor,
  previewAddProjectNoteForActor,
  type NoteAttachmentInput,
} from "@/lib/projects/application/project-notes";
import {
  searchProjectsForActor,
  shapeProjectSearchItem,
} from "@/lib/projects/application/query-projects";
import { getProjectSummaryForActor } from "@/lib/projects/application/get-project-summary";
import {
  createProjectForActor,
  previewCreateProjectForActor,
} from "@/lib/projects/application/create-project";
import { buildInvocationContext } from "@/lib/application/actor";

async function mapQueryError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "项目" });
  }
}

function projectSearchInputSchema() {
  return objectSchema({
    query: stringSchema("关键词，可匹配项目名、描述、客户名、代表"),
    status: stringSchema("项目状态"),
    limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
  });
}

function projectSearchOutputSchema() {
  return objectSchema({
    items: {
      type: "array",
      items: objectSchema({
        id: stringSchema(),
        name: stringSchema(),
        status: stringSchema(),
        customerName: stringSchema(),
        representative: stringSchema(),
        updatedAt: stringSchema(),
      }),
    },
  });
}

function projectSummaryInputSchema() {
  return objectSchema({
    projectId: stringSchema("项目 ID"),
  }, ["projectId"]);
}

function projectSummaryOutputSchema() {
  return objectSchema({
    project: objectSchema({
      id: stringSchema(),
      name: stringSchema(),
      status: stringSchema(),
      customerName: stringSchema(),
      representative: stringSchema(),
      updatedAt: stringSchema(),
    }),
    counts: objectSchema({
      tickets: integerSchema(),
      comments: integerSchema(),
      attachments: integerSchema(),
      linkedOrders: integerSchema(),
      members: integerSchema(),
    }),
    recentTickets: {
      type: "array",
      items: objectSchema({
        id: stringSchema(),
        title: stringSchema(),
        status: stringSchema(),
        updatedAt: stringSchema(),
      }),
    },
    recentNotes: {
      type: "array",
      items: objectSchema({
        id: stringSchema(),
        category: stringSchema(),
        content: stringSchema(),
        authorName: stringSchema(),
        createdAt: stringSchema(),
      }),
    },
  });
}

function projectNoteCategorySchema(description: string) {
  return stringSchema(description, { enum: [...PROJECT_NOTE_CATEGORIES] });
}

function projectNoteOutputSchema() {
  return objectSchema({
    id: stringSchema(),
    category: stringSchema(),
    content: stringSchema(),
    createdAt: stringSchema(),
  });
}

function projectDraftInputSchema() {
  return objectSchema({
    text: stringSchema("原始文本输入"),
    projectId: stringSchema("可选，已有项目 ID"),
    formMode: stringSchema("create 或 edit"),
  }, ["text"]);
}

function projectDraftOutputSchema() {
  return objectSchema({
    formKey: stringSchema(),
    summary: stringSchema(),
    draft: {
      type: "object",
      additionalProperties: true,
    },
    warnings: {
      type: "array",
      items: stringSchema(),
    },
  });
}

export function registerProjectActions() {
  registerNoteAttachmentProposalLifecycle();
  registerAgentAction({
    key: "projects.search",
    title: "搜索项目",
    description: "按关键词和状态搜索当前用户可见的项目。",
    domain: "projects",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: projectSearchInputSchema(),
    outputSchema: projectSearchOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        query: readOptionalString(input, "query"),
        status: readOptionalString(input, "status"),
        limit: clampLimit(readOptionalInteger(input, "limit", { min: 1, max: 30 }), 10, 30),
      };
    },
    async availability(actor) {
      return canAccessAgent(actor.role);
    },
    async execute(ctx, input) {
      const projects = await mapQueryError(() =>
        searchProjectsForActor(ctx.actor, {
          query: input.query,
          status: input.status,
          limit: input.limit,
        }),
      );
      return { items: projects.map(shapeProjectSearchItem) };
    },
  });

  registerAgentAction({
    key: "projects.get_summary",
    title: "查看项目摘要",
    description: "读取单个项目的概览、数量统计和最近工单。",
    domain: "projects",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: projectSummaryInputSchema(),
    outputSchema: projectSummaryOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { projectId: readRequiredString(input, "projectId") };
    },
    async availability(actor) {
      return canAccessAgent(actor.role);
    },
    async execute(ctx, input) {
      return mapQueryError(() =>
        getProjectSummaryForActor(ctx.actor, input.projectId),
      );
    },
  });

  registerAgentAction({
    key: "projects.add_note",
    title: "添加项目备注",
    description:
      "为指定项目添加一条备注记录。分类：GENERAL（通用）、REQUIREMENT（需求）、RISK（风险）、DECISION（决策）、FOLLOW_UP（待跟进）。",
    domain: "projects",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      projectId: stringSchema("项目 ID"),
      content: stringSchema(`备注内容（1-${PROJECT_NOTE_MAX_LENGTH} 字）`),
      category: projectNoteCategorySchema("备注分类"),
      attachments: arraySchema(
        objectSchema({
          stagingFileId: stringSchema("通用附件 staging ID"),
          expectedSha256: stringSchema("附件 SHA-256"),
          expectedVersion: integerSchema("附件 version"),
        }, ["stagingFileId", "expectedSha256", "expectedVersion"]),
        `可选，随备注保存的附件（最多 ${ATTACHMENT_MAX_FILES_PER_MESSAGE} 个，来自当前会话已验证附件）`,
      ),
    }, ["projectId", "content"]),
    outputSchema: objectSchema({
      note: projectNoteOutputSchema(),
      attachments: arraySchema(
        objectSchema({
          attachmentId: stringSchema(),
          fileName: stringSchema(),
          mimeType: stringSchema(),
          url: stringSchema(),
        }),
      ),
      // P2#2: 落盘失败的附件（备注本体已成功）。这些附件保留 PENDING_FILE，由恢复任务续接，
      // 不再标 FAILED（那样会阻断恢复重试）。
      partialFailures: arraySchema(
        objectSchema({
          fileName: stringSchema(),
          reason: stringSchema(),
        }),
      ),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const content = readRequiredString(input, "content");
      if (content.length > PROJECT_NOTE_MAX_LENGTH) {
        throw new AgentActionInputError(`备注内容须为 1–${PROJECT_NOTE_MAX_LENGTH} 字`);
      }
      const category = readOptionalString(input, "category") ?? "GENERAL";
      if (!isProjectNoteCategory(category)) {
        throw new AgentActionInputError(`不支持的备注分类：${category}`);
      }
      const rawAttachments = input.attachments;
      const attachments: NoteAttachmentInput[] = [];
      if (Array.isArray(rawAttachments)) {
        for (const entry of rawAttachments.slice(0, ATTACHMENT_MAX_FILES_PER_MESSAGE)) {
          const rec = ensureObject(entry, "attachments[]");
          const expectedVersion = readOptionalInteger(rec, "expectedVersion", { min: 1 });
          if (expectedVersion == null) throw new AgentActionInputError("attachments[].expectedVersion is required");
          attachments.push({
            stagingFileId: readRequiredString(rec, "stagingFileId"),
            expectedSha256: readRequiredString(rec, "expectedSha256"),
            expectedVersion,
          });
        }
      }
      return {
        projectId: readRequiredString(input, "projectId"),
        content,
        category,
        attachments,
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async buildProposal(ctx, input) {
      const { actor, invocation } = ctx;
      // P0 安全修复：写备注属于贡献操作，必须用 canContributeProject（写权限），
      // 不能以 canReadProject（读权限）代替，否则可读但不可写的用户可经 Agent 越权写备注。
      const canContribute = await canContributeProject(input.projectId, actor.userId, actor.role);
      if (!canContribute) throw new AgentActionForbiddenError();

      const preview = await mapQueryError(() =>
        previewAddProjectNoteForActor(
          {
            ...ctx.actor,
            agentRunId: invocation.agentRunId,
            chatSessionId: invocation.chatSessionId,
          },
          {
            projectId: input.projectId,
            content: input.content,
            category: input.category,
            attachments: input.attachments,
          },
        ),
      );

      const { project, verifiedAttachments } = preview;
      const label = PROJECT_NOTE_CATEGORY_LABELS[input.category];
      const truncatedContent =
        input.content.length > 200 ? input.content.slice(0, 197) + "…" : input.content;
      const attachmentLines = verifiedAttachments.length > 0
        ? `\n附件（${verifiedAttachments.length}）：${verifiedAttachments.map((v) => `${v.staging.originalName}（${v.staging.mimeType}，${v.staging.sizeBytes} bytes）`).join("、")}`
        : "";
      return {
        title: `添加${label}备注：${project.name}`,
        summary: `将为项目「${project.name}」添加一条${label}备注：\n"${truncatedContent}"${attachmentLines}`,
        target: { type: "project", id: project.id },
        proposalInput: {
          projectId: project.id,
          content: input.content,
          category: input.category,
          attachments: verifiedAttachments.map((v) => ({
            stagingFileId: v.staging.id,
            expectedSha256: v.input.expectedSha256,
            expectedVersion: v.input.expectedVersion,
          })),
        },
        displayProps: {
          projectName: project.name,
          category: input.category,
          attachmentCount: String(verifiedAttachments.length),
        },
      };
    },
    // 领域生命周期（§4.3.2 / T1.1）：附件路由 persist 收敛到
    // `@/lib/projects/application/note-attachment-proposal-lifecycle`，proposal service
    // 通过 registry 在自身事务内调用，transaction client 不再进入本 action 文件。
    proposalLifecycleKey: NOTE_ATTACHMENT_PROPOSAL_LIFECYCLE_KEY,
    async execute(ctx, input) {
      const actor = ctx.actor;
      // P0 安全修复：与 buildProposal 同口径，confirm 执行同样要求写权限。
      const canContribute = await canContributeProject(input.projectId, actor.userId, actor.role);
      if (!canContribute) throw new AgentActionForbiddenError();

      const invocation = buildInvocationContext({
        channel: "agent",
        agentRunId: ctx.invocation.agentRunId ?? null,
        proposalId: ctx.invocation.proposalId ?? null,
        chatSessionId: ctx.invocation.chatSessionId ?? null,
        idempotencyKey: ctx.invocation.proposalId ? `agent-proposal:${ctx.invocation.proposalId}` : null,
      });

      return mapQueryError(() =>
        addProjectNoteForActor(ctx.actor, invocation, {
          projectId: input.projectId,
          content: input.content,
          category: input.category,
          attachments: input.attachments,
        }),
      );
    },
    resolveTarget(input) {
      return { type: "project", id: input.projectId };
    },
  });

  registerAgentAction({
    key: "projects.get_notes",
    title: "查看项目备注",
    description: "查询指定项目的备注记录，可按分类筛选，返回最近的备注列表。",
    domain: "projects",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({
      projectId: stringSchema("项目 ID"),
      category: projectNoteCategorySchema("可选，按分类筛选"),
      limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
      cursor: stringSchema("可选，分页游标（上一页最后一条的 id）"),
    }, ["projectId"]),
    outputSchema: objectSchema({
      items: {
        type: "array",
        items: objectSchema({
          id: stringSchema(),
          category: stringSchema(),
          content: stringSchema(),
          authorName: stringSchema(),
          createdAt: stringSchema(),
        }),
      },
      nextCursor: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "下一页游标，null 表示无更多",
      },
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const category = readOptionalString(input, "category");
      if (category && !isProjectNoteCategory(category)) {
        throw new AgentActionInputError(`不支持的备注分类：${category}`);
      }
      return {
        projectId: readRequiredString(input, "projectId"),
        category: category as ProjectNoteCategory | undefined,
        limit: clampLimit(
          readOptionalInteger(input, "limit", { min: 1, max: 30 }),
          10,
          30,
        ),
        cursor: readOptionalString(input, "cursor"),
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async execute(ctx, input) {
      return mapQueryError(() =>
        listProjectNotesForActor(ctx.actor, {
          projectId: input.projectId,
          category: input.category,
          limit: input.limit,
          cursor: input.cursor,
        }),
      );
    },
  });

  registerAgentAction({
    key: "projects.draft_from_text",
    title: "从文本生成项目草稿",
    description: "调用现有 AI 草稿编排器，从文本提取项目字段草稿。",
    domain: "projects",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: projectDraftInputSchema(),
    outputSchema: projectDraftOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        text: readRequiredString(input, "text"),
        projectId: readOptionalString(input, "projectId"),
        formMode: readOptionalString(input, "formMode"),
      };
    },
    async availability() {
      return isDraftAIConfigured();
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      const formKey = input.formMode === "edit" || input.projectId
        ? "project.edit"
        : "project.create";
      const drafted = await runProjectAutoDraft(actor, formKey, input.text, input.projectId);
      return {
        formKey,
        summary: drafted.summary || "已生成项目草稿",
        draft: drafted.draft,
        warnings: drafted.warnings || [],
      };
    },
  });

  // ─── projects.create ─────────────────────────────────────────────────────────
  registerAgentAction({
    key: "projects.create",
    title: "创建项目",
    description: "创建新项目。必须指定项目名称，可选关联客户档案、设置类型、日期和预算。",
    domain: "projects",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      name: stringSchema("项目名称"),
      profileId: stringSchema("客户档案 ID（CrmCustomerProfile.id），关联后自动填充客户名、机构、代表"),
      description: stringSchema("项目描述"),
      projectType: stringSchema("项目类型（如 单细胞测序、空间转录组 等）"),
      startDate: stringSchema("开始日期 ISO 字符串"),
      endDate: stringSchema("结束日期 ISO 字符串"),
      budgetAmount: numberSchema("预算金额（元）"),
      projectContent: stringSchema("项目内容/服务描述"),
      quantity: numberSchema("样本数量"),
      techSupport: stringSchema("技术支持负责人姓名"),
    }, ["name"]),
    outputSchema: objectSchema({
      project: objectSchema({
        id: stringSchema(),
        name: stringSchema(),
        projectNo: stringSchema(),
        status: stringSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        name: readRequiredString(input, "name"),
        profileId: readOptionalString(input, "profileId"),
        description: readOptionalString(input, "description"),
        projectType: readOptionalString(input, "projectType"),
        startDate: readOptionalString(input, "startDate"),
        endDate: readOptionalString(input, "endDate"),
        budgetAmount: readOptionalNumber(input, "budgetAmount", { min: 0 }),
        projectContent: readOptionalString(input, "projectContent"),
        quantity: readOptionalNumber(input, "quantity"),
        techSupport: readOptionalString(input, "techSupport"),
      };
    },
    async availability(actor) {
      // REPRESENTATIVE 不能创建项目（与 API route 一致）
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async buildProposal(ctx, input) {
      const { customerName } = await mapQueryError(() =>
        previewCreateProjectForActor(ctx.actor, {
          profileId: input.profileId,
        }),
      );
      return {
        title: `创建项目：${input.name}`,
        summary: `将创建项目「${input.name}」${customerName ? `，客户为「${customerName}」` : ""}${input.projectType ? `，类型 ${input.projectType}` : ""}${input.budgetAmount ? `，预算 ${input.budgetAmount} 元` : ""}。`,
        target: { type: "project", id: "" },
        displayProps: customerName ? { customerName } : undefined,
      };
    },
    async execute(ctx, input) {
      const invocation = buildInvocationContext({
        channel: "agent",
        agentRunId: ctx.invocation.agentRunId ?? null,
        proposalId: ctx.invocation.proposalId ?? null,
        chatSessionId: ctx.invocation.chatSessionId ?? null,
        idempotencyKey: ctx.invocation.proposalId
          ? `agent-proposal:${ctx.invocation.proposalId}`
          : null,
      });
      const { project } = await mapQueryError(() =>
        createProjectForActor(ctx.actor, invocation, {
          name: input.name,
          profileId: input.profileId,
          description: input.description,
          projectType: input.projectType,
          startDate: input.startDate,
          endDate: input.endDate,
          budgetAmount: input.budgetAmount,
          projectContent: input.projectContent,
          quantity: input.quantity,
          techSupport: input.techSupport,
        }),
      );

      return {
        project: {
          id: project.id,
          name: project.name,
          projectNo: project.projectNo,
          status: project.status,
        },
      };
    },
    resolveTarget(_input, output) {
      return { type: "project", id: output.project.id };
    },
  });
}
