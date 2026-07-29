import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

export type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | JsonSchemaObject
  | JsonSchemaValue[];

export interface JsonSchemaObject {
  [key: string]: JsonSchemaValue;
}

export type AgentActionDomain = "projects" | "orders" | "crm" | "finance" | "tickets" | "agent" | "contracts";
export type AgentActionRiskLevel = "safe" | "confirm" | "restricted";

// T9.1c：actor 身份统一为 `BusinessActor`，调用上下文统一为 `InvocationContext` /
// `AgentExecutionContext`（src/lib/application/actor）。action 定义面：
// availability 收 BusinessActor；execute / buildProposal 收 AgentExecutionContext
// （chatSessionId 经 invocation 在 confirm 路径注入，proposalId 用于幂等写审计）。
export type { AgentExecutionContext, BusinessActor, InvocationContext } from "@/lib/application/actor";

export interface AgentActionTarget {
  type?: string | null;
  id?: string | null;
}

export interface AgentProposalDescriptor {
  title: string;
  summary: string;
  target?: AgentActionTarget;
  proposalInput?: Record<string, unknown>;
  /**
   * 服务端生成的结构化展示快照。
   * 卡片组件优先读取此字段，而非从 summary 正则刮取。
   * 由 buildProposal() 在解析和验证后写入。
   */
  displayProps?: Record<string, string | null>;
}

export interface AgentActionPresentation {
  /** Whether the result is rendered by a deterministic business card. */
  type: "card" | "none";
  /** How much of the result the model should narrate after the card renders. */
  narration: "minimal" | "normal";
}

export interface AgentActionDefinition<Input, Output> {
  key: string;
  title: string;
  description: string;
  domain: AgentActionDomain;
  riskLevel: AgentActionRiskLevel;
  readOnly: boolean;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  presentation?: AgentActionPresentation;
  parseInput: (raw: unknown) => Input;
  availability: (actor: BusinessActor) => Promise<boolean>;
  execute: (ctx: AgentExecutionContext, input: Input) => Promise<Output>;
  buildProposal?: (ctx: AgentExecutionContext, input: Input) => Promise<AgentProposalDescriptor>;
  resolveTarget?: (input: Input, output: Output) => Promise<AgentActionTarget | null> | AgentActionTarget | null;
  /**
   * 领域生命周期意图声明（§4.3.2 / T1.1）。
   * action 只声明一个 key；proposal service 通过服务端 registry
   * （`@/lib/application/proposal-lifecycle`）查找对应领域 handler，并在自身事务内
   * 调用其 persist（proposal 创建时推进领域状态）/ revert（reject/回收/confirm 失败时回滚）。
   * transaction client 不再进入 action 文件或本类型；不声明 key 的 action 行为保持不变。
   */
  proposalLifecycleKey?: string;
  /**
   * 串行化约束：同一用户同一时间最多一个 PENDING/PROCESSING proposal。
   * 用于逐张确认编排（如 finance.submit_invoice_request），防止模型重试或并发请求
   * 产生多张待确认 proposal 违反"一次一张"规则。
   * 实现：创建时写入唯一键 AgentProposal.serialActiveKey=`${userId}::${actionKey}`，
   * claim 时写入 processingLeaseToken；终态清 null。
   * 超时回收清 token 后，旧 worker 的条件终态更新（status=PROCESSING + token）会失败。
   * 并发 create 靠 P2002 互斥；执行中每分钟 heartbeat 刷新 updatedAt。
   */
  serialByUser?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
  presentation?: AgentActionPresentation;
}

export interface AgentActionExecutionResult<Output> {
  action: AgentActionDefinition<unknown, Output>;
  result: Output;
}

export interface AgentActionProposalRecord {
  id: string;
  userId: string;
  agentRunId?: string | null;
  actionKey: string;
  title: string;
  summary: string;
  riskLevel: AgentActionRiskLevel;
  status: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  displayProps?: Record<string, string | null>;
  /** 经 public facade 创建时的 publicToolKey；直调 internal / 旧数据为 null。 */
  publicToolKey?: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | null;
}

export interface AgentRunRecord {
  id: string;
  userId: string;
  role: string;
  name?: string | null;
  email?: string | null;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}
