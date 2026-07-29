import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionForbiddenError, AgentActionInputError, AgentActionNotFoundError } from "@/lib/agent-actions/errors";
import type { AgentViewIntent } from "@/lib/agent-runtime/types";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { isAllowedNavigateRoute, NAV_ROUTE_ALLOWLIST } from "@/lib/agent-resources/allowlist";
import { resolveEntityLocation } from "@/lib/agent-resources/resolve";

// Re-export for the smoke test / existing imports (keeps the public surface stable).
export { NAV_ROUTE_ALLOWLIST };

const PANEL_ALLOWLIST = new Set(["proposal", "memory", "proactive", "history", "timeline"]);
const FILTER_ALLOWLIST = new Set([
  "status",
  "source",
  "projectId",
  "profileId",
  "orderId",
  "stage",
  "importance",
  "ownerUserId",
  "tab",
  "hasRedAdjustment",
]);

function parseIntent(body: unknown): AgentViewIntent {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentActionInputError("intent is required");
  }

  const raw = "intent" in body ? (body as { intent?: unknown }).intent : body;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentActionInputError("intent must be an object");
  }

  const intent = raw as Record<string, unknown>;
  const type = typeof intent.type === "string" ? intent.type : "";
  const label = typeof intent.label === "string" ? intent.label.trim() : "";
  if (!type || !label) {
    throw new AgentActionInputError("intent.type and intent.label are required");
  }

  return {
    type: type as AgentViewIntent["type"],
    route: typeof intent.route === "string" ? intent.route.trim() : undefined,
    entityType: typeof intent.entityType === "string" ? intent.entityType as AgentViewIntent["entityType"] : undefined,
    entityId: typeof intent.entityId === "string" ? intent.entityId.trim() : undefined,
    initialTab: typeof intent.initialTab === "string" && intent.initialTab.trim() ? intent.initialTab.trim() : undefined,
    panel: typeof intent.panel === "string" ? intent.panel.trim() : undefined,
    filters: intent.filters && typeof intent.filters === "object" && !Array.isArray(intent.filters)
      ? intent.filters as Record<string, string | number | boolean | null>
      : undefined,
    label,
    reason: typeof intent.reason === "string" ? intent.reason.trim() : undefined,
  };
}

function assertAllowedNavigateRoute(route: string) {
  if (!isAllowedNavigateRoute(route)) {
    throw new AgentActionForbiddenError("Route is not allowed for view intent");
  }
}

function buildFilterSearchParams(filters: Record<string, string | number | boolean | null>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (!FILTER_ALLOWLIST.has(key)) {
      throw new AgentActionForbiddenError(`Filter ${key} is not allowed`);
    }
    if (value !== null) {
      searchParams.set(key, String(value));
    }
  }
  return searchParams;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const body = await req.json();
    const intent = parseIntent(body);
    const actor = requireBusinessActorFromSession(session);

    if (intent.type === "navigate") {
      const route = intent.route?.trim();
      if (!route) {
        throw new AgentActionInputError("route is required for navigate intent");
      }
      assertAllowedNavigateRoute(route);
      return NextResponse.json({
        ok: true,
        applied: {
          route,
          label: intent.label,
          mode: "navigate",
        },
      });
    }

    if (intent.type === "focus_entity") {
      if (!intent.entityType || !intent.entityId) {
        throw new AgentActionInputError("entityType and entityId are required for focus_entity");
      }
      const location = await resolveEntityLocation(actor.userId, actor.role, intent.entityType, intent.entityId, intent.initialTab);
      return NextResponse.json({
        ok: true,
        applied: {
          route: location.href,
          label: intent.label,
          mode: "navigate",
        },
      });
    }

    if (intent.type === "set_filter") {
      const route = intent.route?.trim();
      if (!route) {
        throw new AgentActionInputError("route is required for set_filter");
      }
      assertAllowedNavigateRoute(route);
      const searchParams = buildFilterSearchParams(intent.filters ?? {});
      return NextResponse.json({
        ok: true,
        applied: {
          route,
          searchParams: Object.fromEntries(searchParams.entries()),
          label: intent.label,
          mode: "navigate",
        },
      });
    }

    if (intent.type === "open_panel") {
      const panel = intent.panel?.trim();
      if (!panel || !PANEL_ALLOWLIST.has(panel)) {
        throw new AgentActionForbiddenError("Panel is not allowed");
      }
      return NextResponse.json({
        ok: true,
        applied: {
          panel,
          label: intent.label,
          mode: "panel",
        },
      });
    }

    throw new AgentActionForbiddenError("Unsupported view intent");
  } catch (error) {
    if (error instanceof AgentActionInputError || error instanceof AgentActionForbiddenError || error instanceof AgentActionNotFoundError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent view intent apply failed:", error);
    return NextResponse.json({ error: "Failed to apply agent view intent" }, { status: 500 });
  }
}
