import { canContributeProject, canReadProject } from "@/lib/permissions";
import { isDraftAIConfigured } from "@/lib/draft/providers";
import { canAccessAgent } from "@/lib/role-guards";
import { buildInvocationContext } from "@/lib/application/actor";
import { getProjectResourceForActor } from "@/lib/projects/application/get-project-resource";
import { createTicketForActor } from "@/lib/tickets/application/create-ticket";
import { getTicketDetailForActor } from "@/lib/tickets/application/get-ticket-detail";
import {
  listTicketsForProject,
  shapeTicketListItemForAgent,
} from "@/lib/tickets/application/query-tickets";
import { replyToTicketForActor } from "@/lib/tickets/application/reply-ticket";
import {
  TICKET_STATUSES,
  updateTicketStatusForActor,
} from "@/lib/tickets/application/update-ticket-status";
import { runProjectAutoDraft } from "../draft-helpers";
import {
  AgentActionForbiddenError,
  AgentActionInputError,
  mapDomainErrorToAgentError,
} from "../errors";
import { registerAgentAction } from "../registry";
import { arraySchema, clampLimit, ensureObject, integerSchema, objectSchema, readOptionalInteger, readOptionalString, readRequiredString, stringSchema } from "../schemas";

async function mapQueryError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "工单" });
  }
}

type TicketTextDraftInput = {
  text: string;
  projectId: string;
  assigneeId?: string;
  reminderDate?: string;
};

type TicketProposalExecutionInput = {
  projectId: string;
  title: string;
  description: string;
  priority: string;
  assigneeId?: string | null;
  reminderDate?: string | null;
  draft?: unknown;
  warnings?: unknown[];
};

type TicketActionInput = TicketTextDraftInput | TicketProposalExecutionInput;

function createTicketFromTextInputSchema() {
  return objectSchema({
    text: stringSchema("原始文本输入"),
    projectId: stringSchema("项目 ID"),
    assigneeId: stringSchema("可选，指派用户 ID"),
    reminderDate: stringSchema("可选，提醒时间 ISO 字符串"),
  }, ["text", "projectId"]);
}

function createTicketFromTextOutputSchema() {
  return objectSchema({
    ticket: objectSchema({
      id: stringSchema(),
      projectId: stringSchema(),
      title: stringSchema(),
      status: stringSchema(),
      priority: stringSchema(),
    }),
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

export function registerTicketActions() {
  registerAgentAction({
    key: "tickets.create_from_text",
    title: "从文本创建工单",
    description: "先用现有 AI 草稿编排器提取工单字段，再走 proposal / confirm 创建工单。",
    domain: "tickets",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: createTicketFromTextInputSchema(),
    outputSchema: createTicketFromTextOutputSchema(),
    parseInput(raw): TicketActionInput {
      const input = ensureObject(raw);
      const projectId = readRequiredString(input, "projectId");
      const title = readOptionalString(input, "title");
      if (title) {
        return {
          projectId,
          title,
          description: readOptionalString(input, "description") || "",
          priority: readOptionalString(input, "priority") || "MEDIUM",
          assigneeId: readOptionalString(input, "assigneeId"),
          reminderDate: readOptionalString(input, "reminderDate"),
          draft: input.draft,
          warnings: Array.isArray(input.warnings) ? input.warnings : [],
        };
      }

      return {
        text: readRequiredString(input, "text"),
        projectId,
        assigneeId: readOptionalString(input, "assigneeId"),
        reminderDate: readOptionalString(input, "reminderDate"),
      };
    },
    async availability() {
      // buildProposal 必须走 AI 草稿链路（runProjectAutoDraft），未配置时对
      // 所有角色都不可用 —— 否则 availability 放行后 buildProposal 必然失败。
      return isDraftAIConfigured();
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      if (!("text" in input)) {
        throw new AgentActionForbiddenError("工单草稿输入无效");
      }
      const readable = await canReadProject(input.projectId, actor.userId, actor.role);
      const contributable = await canContributeProject(input.projectId, actor.userId, actor.role);
      if (!readable || !contributable) {
        throw new AgentActionForbiddenError();
      }

      const project = await mapQueryError(() =>
        getProjectResourceForActor(ctx.actor, input.projectId),
      );

      const drafted = await runProjectAutoDraft(actor, "ticket.create", input.text, input.projectId);
      const fields = drafted.draft.fields as Record<string, unknown>;
      const title = typeof fields.title === "string" && fields.title.trim()
        ? fields.title.trim()
        : "AI 工单草稿";
      const description = typeof fields.description === "string" ? fields.description.trim() : "";
      const priority = typeof fields.priority === "string" ? fields.priority : "MEDIUM";

      return {
        title: `创建工单：${title}`,
        summary: `将在项目「${project.name}」下创建工单「${title}」${description ? "，并附带描述草稿" : ""}。优先级为 ${priority}。`,
        target: { type: "project", id: project.id },
        displayProps: { projectName: project.name, ticketTitle: title },
        proposalInput: {
          projectId: input.projectId,
          title,
          description,
          priority,
          assigneeId: input.assigneeId ?? null,
          reminderDate: input.reminderDate ?? null,
          draft: drafted.draft,
          warnings: drafted.warnings || [],
        },
      };
    },
    async execute(ctx, input) {
      if (!("title" in input)) {
        throw new AgentActionForbiddenError("工单确认输入无效");
      }
      const confirmedInput = input as TicketProposalExecutionInput;
      const invocation = buildInvocationContext({
        channel: "agent",
        agentRunId: ctx.invocation.agentRunId ?? null,
        proposalId: ctx.invocation.proposalId ?? null,
        chatSessionId: ctx.invocation.chatSessionId ?? null,
        idempotencyKey: ctx.invocation.proposalId
          ? `agent-proposal:${ctx.invocation.proposalId}`
          : null,
      });
      const { ticket } = await mapQueryError(() =>
        createTicketForActor(ctx.actor, invocation, {
          projectId: confirmedInput.projectId,
          title: confirmedInput.title,
          description: confirmedInput.description,
          priority: confirmedInput.priority,
          assigneeId: confirmedInput.assigneeId,
          reminderDate: confirmedInput.reminderDate,
        }),
      );

      return {
        ticket: {
          id: ticket.id,
          projectId: ticket.projectId,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          assigneeId: ticket.assigneeId,
        },
        draft: confirmedInput.draft || null,
        warnings: Array.isArray(confirmedInput.warnings) ? confirmedInput.warnings : [],
      };
    },
    resolveTarget(_input, output) {
      return { type: "ticket", id: output.ticket.id };
    },
  });

  // ─── tickets.update_status ───────────────────────────────────────────────────
  registerAgentAction({
    key: "tickets.update_status",
    title: "修改工单状态",
    description: "修改工单状态（OPEN / IN_PROGRESS / CLOSED）。仅 ADMIN 和 USER（项目成员）可操作。",
    domain: "tickets",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      ticketId: stringSchema("工单 ID"),
      status: stringSchema("目标状态：OPEN、IN_PROGRESS 或 CLOSED"),
    }, ["ticketId", "status"]),
    outputSchema: objectSchema({
      ticket: objectSchema({
        id: stringSchema(),
        title: stringSchema(),
        status: stringSchema(),
        previousStatus: stringSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const status = readRequiredString(input, "status").toUpperCase();
      if (!TICKET_STATUSES.includes(status as typeof TICKET_STATUSES[number])) {
        throw new AgentActionInputError(`status 必须是 ${TICKET_STATUSES.join("、")} 之一`);
      }
      return {
        ticketId: readRequiredString(input, "ticketId"),
        status,
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async buildProposal(ctx, input) {
      const detail = await mapQueryError(() =>
        getTicketDetailForActor(ctx.actor, input.ticketId),
      );
      if (!detail.permissions.canManage) {
        throw new AgentActionForbiddenError();
      }

      const { ticket } = detail;
      const statusLabels: Record<string, string> = { OPEN: "打开", IN_PROGRESS: "处理中", CLOSED: "已关闭" };
      const fromLabel = statusLabels[ticket.status] ?? ticket.status;
      const toLabel = statusLabels[input.status] ?? input.status;
      return {
        title: `修改工单状态：${ticket.title}`,
        summary: `将工单「${ticket.title}」状态从「${fromLabel}」变更为「${toLabel}」。`,
        target: { type: "ticket", id: ticket.id },
        displayProps: { ticketTitle: ticket.title, fromStatus: fromLabel, toStatus: toLabel },
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
      const { ticket, previousStatus } = await mapQueryError(() =>
        updateTicketStatusForActor(ctx.actor, invocation, {
          ticketId: input.ticketId,
          status: input.status,
        }),
      );

      return {
        ticket: {
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          previousStatus,
        },
      };
    },
    resolveTarget(_input, output) {
      return { type: "ticket", id: output.ticket.id };
    },
  });

  // ─── tickets.reply ─────────────────────────────────────────────────────────
  registerAgentAction({
    key: "tickets.reply",
    title: "回复工单",
    description: "为工单添加回复。ADMIN、USER（项目成员）和 REPRESENTATIVE（关联项目）均可操作。",
    domain: "tickets",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      ticketId: stringSchema("工单 ID"),
      content: stringSchema("回复内容"),
    }, ["ticketId", "content"]),
    outputSchema: objectSchema({
      reply: objectSchema({
        id: stringSchema(),
        ticketId: stringSchema(),
        content: stringSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        ticketId: readRequiredString(input, "ticketId"),
        content: readRequiredString(input, "content"),
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER" || actor.role === "REPRESENTATIVE";
    },
    async buildProposal(ctx, input) {
      const detail = await mapQueryError(() =>
        getTicketDetailForActor(ctx.actor, input.ticketId),
      );
      if (!detail.permissions.canContribute) {
        throw new AgentActionForbiddenError();
      }

      const { ticket } = detail;
      return {
        title: `回复工单：${ticket.title}`,
        summary: `将在工单「${ticket.title}」下添加回复：「${input.content.slice(0, 50)}${input.content.length > 50 ? "…" : ""}」`,
        target: { type: "ticket", id: ticket.id },
        displayProps: { ticketTitle: ticket.title },
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
      const { reply } = await mapQueryError(() =>
        replyToTicketForActor(ctx.actor, invocation, {
          ticketId: input.ticketId,
          content: input.content,
        }),
      );

      return {
        reply: {
          id: reply.id,
          ticketId: reply.ticketId,
          content: reply.content,
        },
      };
    },
    resolveTarget(_input, output) {
      return { type: "ticket_reply", id: output.reply.id };
    },
  });

  // ─── tickets.list ──────────────────────────────────────────────────────────
  registerAgentAction({
    key: "tickets.list",
    title: "查看工单列表",
    description: "列出项目下的工单，支持按状态筛选。",
    domain: "tickets",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({
      projectId: stringSchema("项目 ID"),
      status: stringSchema("按状态筛选：OPEN、IN_PROGRESS 或 CLOSED"),
      limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
    }, ["projectId"]),
    outputSchema: objectSchema({
      items: arraySchema(objectSchema({
        id: stringSchema(),
        title: stringSchema(),
        status: stringSchema(),
        priority: stringSchema(),
        assigneeName: stringSchema(),
        updatedAt: stringSchema(),
      })),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        projectId: readRequiredString(input, "projectId"),
        status: readOptionalString(input, "status")?.toUpperCase(),
        limit: clampLimit(readOptionalInteger(input, "limit", { min: 1, max: 30 }), 10, 30),
      };
    },
    async availability(actor) {
      return canAccessAgent(actor.role);
    },
    async execute(ctx, input) {
      const tickets = await mapQueryError(() =>
        listTicketsForProject(ctx.actor, {
          projectId: input.projectId,
          status: input.status,
          limit: input.limit,
        }),
      );
      return { items: tickets.map(shapeTicketListItemForAgent) };
    },
  });
}
