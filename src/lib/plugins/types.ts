export type PluginCapability = "timeline" | "form-draft";

export interface PluginManifest {
  key: string;
  name: string;
  description: string;
  capability: PluginCapability;
  allowedRoles?: string[];
  formKeys?: string[];
}

export interface PluginActor {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface ProjectPluginContext {
  project: {
    id: string;
    name: string;
    description?: string | null;
    status: string;
    progress: number;
    organization?: string | null;
    client?: string | null;
    representative?: string | null;
  };
  customer?: {
    id: string;
    name: string;
    customerCode: string;
    organization?: string | null;
    email?: string | null;
    wechat?: string | null;
  } | null;
  representativeDetail?: {
    id: string;
    name: string;
    email: string;
  } | null;
  tickets: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    updatedAt: string;
  }>;
  timeline: Array<{
    id: string;
    type: string;
    kind: string;
    content: string;
    createdAt: string;
    user?: { id: string; name: string } | null;
    metadata?: Record<string, unknown> | null;
  }>;
}

export interface TimelinePluginResult {
  summary?: string;
  message?: {
    content: string;
    format?: "plain" | "markdown";
    metadata?: Record<string, unknown>;
  };
}

export interface FormDraftResult {
  summary?: string;
  warnings?: string[];
  draft: {
    fields: Record<string, unknown>;
    fieldMeta?: Record<string, {
      source: "text" | "search" | "project_context";
      confidence: number;
      reviewRequired?: boolean;
      reason?: string;
    }>;
    sources?: Array<{
      kind: "search_result";
      title?: string;
      url?: string;
      snippet?: string;
    }>;
  };
}

export interface TimelinePlugin {
  manifest: PluginManifest & { capability: "timeline" };
  execute(ctx: ProjectPluginContext, actor: PluginActor, input?: string): Promise<TimelinePluginResult>;
}

export interface FormDraftPlugin {
  manifest: PluginManifest & { capability: "form-draft" };
  execute(input: string | Record<string, unknown>, actor: PluginActor, formKey: string, projectCtx?: ProjectPluginContext): Promise<FormDraftResult>;
}

export type Plugin = TimelinePlugin | FormDraftPlugin;
