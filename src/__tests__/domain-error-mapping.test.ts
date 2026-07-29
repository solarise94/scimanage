/**
 * 契约测试：统一领域错误映射
 * 直接导入生产模块 src/lib/agent-actions/errors.ts
 */
import { describe, it, expect } from "vitest";
import {
  AgentActionError,
  AgentActionForbiddenError,
  AgentActionNotFoundError,
  AgentActionConflictError,
  AgentActionInputError,
  mapDomainErrorToAgentError,
} from "@/lib/agent-actions/errors";

describe("mapDomainErrorToAgentError", () => {
  class MockInvoiceStagingError extends Error {
    constructor(message: string, public httpStatus: number) {
      super(message);
    }
  }

  class MockAllocationError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  }

  it("maps httpStatus 403 to ForbiddenError", () => {
    const err = new MockInvoiceStagingError("no access", 403);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(AgentActionForbiddenError);
  });

  it("maps httpStatus 404 to NotFoundError", () => {
    const err = new MockInvoiceStagingError("not found", 404);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(AgentActionNotFoundError);
  });

  it("maps httpStatus 409 to ConflictError", () => {
    const err = new MockInvoiceStagingError("conflict", 409);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(AgentActionConflictError);
  });

  it("maps httpStatus 410 to ConflictError", () => {
    const err = new MockInvoiceStagingError("gone", 410);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(AgentActionConflictError);
  });

  it("maps httpStatus 400 to InputError", () => {
    const err = new MockInvoiceStagingError("bad input", 400);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(AgentActionInputError);
  });

  it("maps status field (not httpStatus) for AllocationError", () => {
    const err = new MockAllocationError("conflict", 409);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockAllocationError] }))
      .toThrow(AgentActionConflictError);
  });

  it("re-throws non-domain errors when domainClasses specified", () => {
    const err = new TypeError("unexpected");
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(TypeError);
  });

  it("re-throws errors without status field", () => {
    const err = new MockInvoiceStagingError("no status", 0);
    expect(() => mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] }))
      .toThrow(MockInvoiceStagingError);
  });

  it("re-throws non-Error values", () => {
    expect(() => mapDomainErrorToAgentError("string error")).toThrow("string error");
  });

  it("preserves error message in mapped result", () => {
    const err = new MockInvoiceStagingError("自定义消息", 403);
    try {
      mapDomainErrorToAgentError(err, { domainClasses: [MockInvoiceStagingError] });
    } catch (e) {
      expect(e).toBeInstanceOf(AgentActionForbiddenError);
      expect((e as Error).message).toBe("自定义消息");
    }
  });
});

describe("CRM typed errors via unified mapper", () => {
  // 模拟 H14 重构后的 CRM 类型化错误
  class CrmAccessNotFoundError extends Error {
    httpStatus = 404;
    constructor() { super("客户资料不存在或已删除"); }
  }
  class CrmAccessForbiddenError extends Error {
    httpStatus = 403;
    constructor() { super("无权访问该客户资料"); }
  }

  it("maps CrmAccessNotFoundError to AgentActionNotFoundError", () => {
    const err = new CrmAccessNotFoundError();
    expect(() => mapDomainErrorToAgentError(err, {
      domainClasses: [CrmAccessNotFoundError, CrmAccessForbiddenError],
      resourceLabel: "客户资料",
    })).toThrow(AgentActionNotFoundError);
  });

  it("maps CrmAccessForbiddenError to AgentActionForbiddenError", () => {
    const err = new CrmAccessForbiddenError();
    expect(() => mapDomainErrorToAgentError(err, {
      domainClasses: [CrmAccessNotFoundError, CrmAccessForbiddenError],
      resourceLabel: "客户资料",
    })).toThrow(AgentActionForbiddenError);
  });
});
