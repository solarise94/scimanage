/**
 * Agent runtime persistence service: AgentRun + run-scoped ownership checks.
 *
 * Owns the only Prisma access for AgentRun CRUD, run→actor resolution, run
 * ownership assertions and chat-session ownership checks. Agent adapters
 * (`src/lib/agent-actions/run-context.ts`) re-export from here and must not
 * touch Prisma themselves.
 *
 * These are Agent-own models (§1.4): AgentRun / AgentChatSession. The service
 * only accepts IDs and always re-checks owner user, ACTIVE status and
 * ownership before returning — receiving an ID never implies authorization.
 *
 * `getExecutionContextFromAgentRun` resolves the live actor via
 * `resolveCurrentBusinessActor`, i.e. User.role is refreshed and the AgentRun
 * snapshot role is never trusted (T0.1 behaviour preserved).
 */
import type { Session } from "next-auth";
import type { AgentExecutionContext } from "@/lib/application/actor";
import {
  resolveCurrentBusinessActor,
  buildInvocationContext,
} from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import {
  AgentActionForbiddenError,
  AgentActionInputError,
} from "@/lib/agent-actions/errors";
import type { AgentRunRecord } from "@/lib/agent-actions/types";

function mapAgentRunRecord(run: {
  id: string;
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  status: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date;
}): AgentRunRecord {
  return {
    id: run.id,
    userId: run.userId,
    role: run.role,
    name: run.name,
    email: run.email,
    status: run.status,
    source: run.source,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    lastUsedAt: run.lastUsedAt.toISOString(),
  };
}

function sessionToActor(session: Session) {
  if (!session.user?.id || !session.user.role) {
    throw new AgentActionForbiddenError("Unauthorized");
  }

  return {
    userId: session.user.id,
    role: session.user.role,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };
}

export async function createAgentRunFromSession(session: Session, source = "CHAT") {
  const actor = sessionToActor(session);
  const run = await prisma.agentRun.create({
    data: {
      userId: actor.userId,
      role: actor.role,
      name: actor.name,
      email: actor.email,
      source,
      status: "ACTIVE",
      lastUsedAt: new Date(),
    },
  });

  return mapAgentRunRecord(run);
}

export async function getOrCreateAgentRunFromSession(
  session: Session,
  agentRunId?: string | null,
  source = "CHAT",
) {
  if (agentRunId) {
    await ensureAgentRunBelongsToSession(agentRunId, session);
    const touchedAt = new Date();
    const run = await prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (run) {
      const updated = await prisma.agentRun.update({
        where: { id: agentRunId },
        data: { lastUsedAt: touchedAt },
      });
      return mapAgentRunRecord(updated);
    }
  }
  return createAgentRunFromSession(session, source);
}

/**
 * Resolve actor for an AgentRun using the live User.role (not the run snapshot).
 * Maps application errors to AgentAction* for existing API adapters.
 * T9.1c：返回 AgentExecutionContext（actor + invocation），取代扁平 legacy bag。
 */
export async function getExecutionContextFromAgentRun(agentRunId: string): Promise<AgentExecutionContext> {
  const run = await prisma.agentRun.findUnique({
    where: { id: agentRunId },
    select: { id: true, userId: true, status: true },
  });
  if (!run) {
    throw new AgentActionInputError("Agent run not found");
  }
  if (run.status !== "ACTIVE") {
    throw new AgentActionForbiddenError("Agent run is not active");
  }

  try {
    const actor = await resolveCurrentBusinessActor({
      userId: run.userId,
      channel: "agent",
      agentRunId: run.id,
      touchAgentRun: true,
    });
    return {
      actor,
      invocation: buildInvocationContext({
        channel: "agent",
        agentRunId: run.id,
      }),
    };
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new AgentActionInputError(err.message);
    }
    if (err instanceof ForbiddenError || err instanceof UnauthenticatedError) {
      throw new AgentActionForbiddenError(err.message);
    }
    throw err;
  }
}

export async function listAgentRunsForUser(userId: string) {
  const runs = await prisma.agentRun.findMany({
    where: { userId },
    orderBy: { lastUsedAt: "desc" },
    take: 20,
  });

  return runs.map(mapAgentRunRecord);
}

/**
 * Phase 6 (design §8.4 Layer 2): read the trusted AgentRun.source from the DB.
 *
 * Used by the public executor's read-only policy gate so it can refuse write
 * tools (propose/preview/workflow/confirm) for OPENAI_COMPAT runs even if the
 * model hand-crafts a publicToolKey. The source is ALWAYS read from the DB —
 * never from the request body — so a forged `source` field has no effect.
 *
 * Returns "CHAT" when the run is missing or the source column is empty
 * (fail-safe: unknown runs are treated as native CHAT, which is never gated
 * by the read-only policy; the canonical service scope gate remains the final
 * boundary).
 */
export async function getTrustedAgentRunSource(agentRunId: string | null | undefined): Promise<string> {
  if (!agentRunId) return "CHAT";
  const run = await prisma.agentRun.findUnique({
    where: { id: agentRunId },
    select: { source: true },
  });
  return run?.source?.trim() || "CHAT";
}

export async function ensureAgentRunBelongsToSession(agentRunId: string, session: Session) {
  const actor = sessionToActor(session);
  const run = await prisma.agentRun.findUnique({
    where: { id: agentRunId },
    select: { id: true, userId: true, status: true },
  });
  if (!run || run.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Agent run not found");
  }
  if (run.status !== "ACTIVE") {
    throw new AgentActionForbiddenError("Agent run is not active");
  }
  return run;
}

/**
 * P1#2 层 B（加固）：校验请求体携带的 chatSessionId 确实属于当前用户，且其 agentRunId
 * 与当前 run 一致（若 session 已绑定 run）。防止直连 tools/execute 伪造 sessionId 绕过
 * 附件 session/run 隔离。返回校验通过的 sessionId（通过）；不匹配即抛 403。
 *
 * 注意：session 的 agentRunId 可为空（旧 session 或单 run 多 session 场景）；仅当非空且
 * 与当前 run 不一致时才拒绝。
 */
export async function verifyChatSessionForActor(opts: {
  chatSessionId: string;
  userId: string;
  agentRunId?: string | null;
}): Promise<string> {
  const chatSession = await prisma.agentChatSession.findUnique({
    where: { id: opts.chatSessionId },
    select: { id: true, userId: true, agentRunId: true },
  });
  if (!chatSession || chatSession.userId !== opts.userId) {
    throw new AgentActionForbiddenError("Chat session not found or not owned by actor");
  }
  if (opts.agentRunId && chatSession.agentRunId && chatSession.agentRunId !== opts.agentRunId) {
    throw new AgentActionForbiddenError("Chat session does not belong to the current agent run");
  }
  return opts.chatSessionId;
}
