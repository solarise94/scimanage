export class AgentActionError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 500, code = "AGENT_ACTION_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AgentActionInputError extends AgentActionError {
  constructor(message: string) {
    super(message, 400, "INVALID_ACTION_INPUT");
  }
}

export class AgentActionForbiddenError extends AgentActionError {
  constructor(message = "Forbidden") {
    super(message, 403, "ACTION_FORBIDDEN");
  }
}

export class AgentActionNotFoundError extends AgentActionError {
  /**
   * @param target action key or resource id
   * @param message optional human-readable message (defaults to unknown-action wording)
   */
  constructor(target: string, message?: string) {
    super(message || `Unknown action: ${target}`, 404, "ACTION_NOT_FOUND");
  }
}

export class AgentActionConfirmationRequiredError extends AgentActionError {
  constructor(message = "Action requires confirmation") {
    super(message, 409, "ACTION_CONFIRMATION_REQUIRED");
  }
}

export class AgentActionConflictError extends AgentActionError {
  constructor(message = "Conflict") {
    super(message, 409, "ACTION_CONFLICT");
  }
}

/**
 * P1-3 allowProposal：模型驱动的 proposal 创建未携带可信前端确认事件。
 *
 * channel="agent" 路径必须先消费一个由浏览器 UI 经 NextAuth 颁发的
 * AgentUserConfirmationEvent（见 src/lib/application/agent-confirmation-events.ts）。
 * 缺失 / 已消费 / 跨 run / targetIntent 不匹配 → 抛本错误，模型据此回复用户去界面确认。
 * web channel（GenUI 点击即可信用户动作）不消费事件，不会抛本错误。
 */
export class AgentActionNeedsConfirmationError extends AgentActionError {
  /**
   * P1-3 UI 接线：模型驱动的 proposal 创建被门限拦截时，要透出对应的
   * confirm actionKey（targetIntent），让前端 GenUI 能 mint 匹配的
   * AgentUserConfirmationEvent 并引导用户重试。
   *
   * 该字段由 createAgentProposal 在抛错时填 action.key；executor / route /
   * runtime / timeline 一路透传到 needs-user-confirmation 卡片。
   * 缺省为 undefined（保持与既有无 targetIntent 抛错点的字节级行为）。
   */
  targetIntent?: string;

  constructor(message = "该操作需要用户在界面显式确认后才能生成提案", targetIntent?: string) {
    super(message, 409, "NEEDS_USER_CONFIRMATION");
    if (targetIntent) this.targetIntent = targetIntent;
  }
}

/**
 * 统一领域错误映射：将带有 httpStatus/status 字段的领域错误转换为 AgentActionError。
 *
 * 替代 mapFinanceAccessError / mapAnalyzeInvoiceAgentError /
 * mapRegisterIssuedInvoiceAgentError / mapAllocationReceiptError 四个几乎相同的函数。
 *
 * @param err 捕获到的错误
 * @param opts.domainClasses 限定只处理这些类的实例（其余 re-throw）
 * @param opts.resourceLabel 用于 NotFoundError 的资源标签
 */
export function mapDomainErrorToAgentError(
  err: unknown,
  opts?: {
    domainClasses?: Array<abstract new (...args: never[]) => Error>;
    resourceLabel?: string;
  },
): never {
  const resource = opts?.resourceLabel ?? "资源";

  if (opts?.domainClasses && opts.domainClasses.length > 0) {
    const isDomainError = opts.domainClasses.some((cls) => err instanceof cls);
    if (!isDomainError) throw err;
  }

  if (err && typeof err === "object" && err instanceof Error) {
    const domainErr = err as Error & { httpStatus?: number; status?: number };
    const status = domainErr.httpStatus ?? domainErr.status;

    if (status === 403) throw new AgentActionForbiddenError(err.message);
    if (status === 404) throw new AgentActionNotFoundError(resource, err.message);
    if (status === 409 || status === 410) throw new AgentActionConflictError(err.message);
    if (status != null && status >= 400 && status < 500) throw new AgentActionInputError(err.message);
  }

  throw err;
}
