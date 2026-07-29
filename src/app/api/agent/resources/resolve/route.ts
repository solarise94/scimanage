import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import {
  AgentActionError,
  AgentActionForbiddenError,
  AgentActionInputError,
} from "@/lib/agent-actions/errors";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { isAllowedNavigateRoute } from "@/lib/agent-resources/allowlist";
import {
  isAgentResourceEntityType,
  locationToResolution,
  parseEntityHref,
  resolveEntityLocation,
} from "@/lib/agent-resources/resolve";
import type {
  AgentResourceRequest,
  AgentResourceResolveResponse,
} from "@/lib/agent-resources/types";

function parseRequest(body: unknown): AgentResourceRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentActionInputError("request body is required");
  }
  const raw = body as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : "";
  if (type === "entity") {
    const entityTypeRaw = typeof raw.entityType === "string" ? raw.entityType.trim() : "";
    const entityId = typeof raw.entityId === "string" ? raw.entityId.trim() : "";
    if (!entityTypeRaw || !entityId) {
      throw new AgentActionInputError("entityType and entityId are required for entity request");
    }
    if (!isAgentResourceEntityType(entityTypeRaw)) {
      throw new AgentActionInputError(
        "entityType must be one of: customer, order, project, ticket, invoice",
      );
    }
    const initialTab = typeof raw.initialTab === "string" && raw.initialTab.trim() ? raw.initialTab.trim() : undefined;
    return { type: "entity", entityType: entityTypeRaw, entityId, ...(initialTab ? { initialTab } : {}) };
  }
  if (type === "href") {
    const href = typeof raw.href === "string" ? raw.href.trim() : "";
    if (!href) {
      throw new AgentActionInputError("href is required for href request");
    }
    return { type: "href", href };
  }
  throw new AgentActionInputError("request.type must be 'entity' or 'href'");
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
    const request = parseRequest(body);
    const actor = requireBusinessActorFromSession(session);

    if (request.type === "href") {
      // Detail-page links (e.g. the model writing /tickets/{id} in Markdown)
      // are upgraded to entity requests: same object-level permission check
      // and canonical resolution as a GenUI click.
      const entityRef = parseEntityHref(request.href);
      if (entityRef) {
        const location = await resolveEntityLocation(actor.userId, actor.role, entityRef.entityType, entityRef.entityId);
        return NextResponse.json<AgentResourceResolveResponse>({
          ok: true,
          resolution: locationToResolution(location),
        });
      }
      // List-root hrefs: validate against the navigate allowlist only — no
      // entity resolution.  If it matches, the client opens it as a full page;
      // if not, reject (fail closed).
      const { href } = request;
      const path = href.startsWith("/") ? href.split("?")[0] : href;
      if (!isAllowedNavigateRoute(path)) {
        throw new AgentActionForbiddenError("Route is not allowed for resource resolve");
      }
      return NextResponse.json<AgentResourceResolveResponse>({
        ok: true,
        resolution: { mode: "navigate", href, label: typeof body === "object" && body && "label" in body ? String((body as Record<string, unknown>).label) || "打开页面" : "打开页面" },
      });
    }

    // Entity request: resolve canonical location with permission checks.
    const location = await resolveEntityLocation(
      actor.userId,
      actor.role,
      request.entityType,
      request.entityId,
      request.initialTab,
    );
    return NextResponse.json<AgentResourceResolveResponse>({
      ok: true,
      resolution: locationToResolution(location),
    });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent resource resolve failed:", error);
    return NextResponse.json({ error: "Failed to resolve agent resource" }, { status: 500 });
  }
}
