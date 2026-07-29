export interface RuntimeHistoryMessage {
  role: string;
  content: string;
  createdAt?: string;
}

export interface RuntimeMemory {
  id: string;
  kind: string;
  content: string;
  confidence?: number;
  status?: string;
}

/**
 * 热客户条目（docs §5.4）：作为 prompt 上下文注入的活跃客户候选。
 * 字段镜像 src/lib/crm/hot-customers.ts 的 HotCustomerEntry（全 camelCase，
 * 日期为 ISO string|null）。不含手机号/邮箱/地址等敏感字段。
 */
export interface RuntimeHotCustomer {
  profileId: string;
  name: string;
  namePinyin: string;
  organization: string | null;
  principal: string | null;
  stage: string;
  importance: string;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
}

/**
 * 热项目条目（梦境记忆 D1/D3）：作为 prompt 上下文注入的活跃项目候选。
 * 字段镜像 src/lib/agent-runtime/hot-projects.ts 的 HotProjectEntry（全 camelCase，
 * 日期为 ISO string|null）。
 */
export interface RuntimeHotProject {
  projectId: string;
  name: string;
  projectNo: string | null;
  status: string;
  representative: string | null;
  customerName: string | null;
  organization: string | null;
  lastActivityAt: string | null;
}

/**
 * 实体记忆条目（梦境记忆 D3）：夜间整理产出的实体级热记忆，注入 prompt 上下文。
 * 字段镜像 AgentEntityMemory（entityType/entityId/name/summary/lastActiveAt）。
 */
export interface RuntimeEntityMemory {
  entityType: string;
  entityId: string;
  name: string;
  summary: string;
  lastActiveAt: string | null;
}

export interface RuntimeToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  presentation?: RuntimeToolPresentation;
}

export interface RuntimeToolPresentation {
  type: "card" | "none";
  narration: "minimal" | "normal";
}

/**
 * Canonical Agent stream event (plan §4.4 / design §5.8): `streamChat` emits
 * ONLY canonical events (`AgentStreamEvent`, the single union from
 * `stream-protocol.ts`). server.ts frames them as SSE (Phase 5: SSE is the
 * only wire transport — plan §7).
 *
 * `streamChat(emit)` 的 emit 回调签名就是 `(event: AgentStreamEvent) => void`。
 */

/**
 * Canonical Agent stream event — re-exported so pi-runtime/server 内部只用一份契约。
 */
export type { AgentStreamEvent } from "./stream-protocol.js";

export interface RuntimeBridgeConfig {
  appBaseUrl: string;
  internalToolToken: string;
}

export interface RuntimeChatStreamRequest {
  requestId: string;
  agentRunId: string;
  sessionId: string;
  user: {
    id: string;
    role: string;
    name?: string | null;
    email?: string | null;
  };
  message: string;
  messageContext?: {
    verifiedCustomerProfileId?: string;
    verifiedInvoiceStaging?: {
      stagingFileId: string;
      sha256: string;
      version: number;
      fileName: string;
    };
    verifiedInvoiceStagingFiles?: Array<{
      stagingFileId: string;
      sha256: string;
      version: number;
      fileName: string;
    }>;
    verifiedImportStagingFiles?: Array<{
      stagingFileId: string;
      sha256: string;
      version: number;
      fileName: string;
      importKind?: string;
    }>;
    /**
     * 已验证的通用附件（docs/agent-attachment-routing-design-2026-07-24.md §6.2）。
     * imageDataBase64 仅对 image/jpeg|png|webp 提供；runtime 以原生多模态 ImageContent
     * 传入模型（base64 data，绝不传 storageKey/本地路径/私有 URL）。PDF/Office/文本
     * 只提供元数据，本期不做原生文件输入。
     */
    verifiedAgentAttachments?: Array<{
      stagingFileId: string;
      sha256: string;
      version: number;
      fileName: string;
      mimeType: string;
      fileSize: number;
      imageDataBase64?: string;
    }>;
  };
  inputMode?: "voice" | "text" | null;
  /**
   * P1 (defect 2): explicit tool dispatch protocol.
   *  - `undefined` / `"internal"` (default): legacy native CHAT behaviour.
   *    The global `AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED` flag alone decides whether
   *    the runtime treats request.availableTools names as internal actionKeys
   *    (flag OFF, default → /api/agent/tools/execute) or whether a public bundle
   *    is fetched from select-bundle and executed via execute-public (flag ON).
   *  - `"public_read_only"`: the caller (OpenAI facade read-only run) has already
   *    injected public tool keys as request.availableTools. The runtime MUST:
   *    (a) route every tool execution through `/api/agent/tools/execute-public`
   *        (public executor, which carries the Layer-2 read-only 403 gate),
   *        regardless of the global dynamic-bundle flag;
   *    (b) NOT call the bundle selector to replace the tool list — the
   *        Runner-injected read-only specs are used as-is;
   *    (c) NOT expose any write tool name to the model;
   *    (d) use the public-tool prompt wording (customerId / find_customers …).
   */
  toolDispatch?: "internal" | "public_read_only";
  history: RuntimeHistoryMessage[];
  compactSummary?: string | null;
  memories: RuntimeMemory[];
  hotCustomers?: RuntimeHotCustomer[];
  hotProjects?: RuntimeHotProject[];
  entityMemories?: RuntimeEntityMemory[];
  availableTools: RuntimeToolSpec[];
  bridge: RuntimeBridgeConfig;
  context: {
    currentView?: Record<string, unknown> | null;
    viewControlEnabled: boolean;
    webSearchEnabled: boolean;
    proactiveEnabled: boolean;
    // dynamic tool bundles flag. ON: prompt uses public tool keys + customerId.
    // OFF: internal action keys + profileId (legacy chat-stream byte-identical).
    dynamicToolBundlesEnabled: boolean;
  };
}

export interface RuntimeCompactRequest {
  sessionId: string;
  history: RuntimeHistoryMessage[];
  compactSummary?: string | null;
}
