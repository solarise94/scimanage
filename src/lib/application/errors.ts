/**
 * Named domain errors for canonical application services.
 * Adapters map these to HTTP / AgentActionError; services must not throw route-shaped `{ status, body }`.
 */

export class ApplicationError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export class UnauthenticatedError extends ApplicationError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHENTICATED");
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

/** 门户准入拒绝：非 ADMIN 访问与 User.department 不匹配的 Portal。 */
export class PortalAccessDeniedError extends ApplicationError {
  constructor(message: string) {
    super(message, 403, "PORTAL_ACCESS_DENIED");
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message = "Not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

export class ConflictError extends ApplicationError {
  constructor(message = "Conflict") {
    super(message, 409, "CONFLICT");
  }
}

export class StaleStateError extends ApplicationError {
  constructor(message = "Stale state") {
    super(message, 409, "STALE_STATE");
  }
}
