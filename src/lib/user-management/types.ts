/**
 * Safe response types for user management API.
 * These types never include password, password hash, or token fields.
 */

export interface SafeUserResponse {
  id: string;
  name: string;
  email: string;
  role: string;
  /** 所属部门（FIELD_SALES | ONLINE_OPS），设计 §4.1 */
  department: string;
  passwordInitialized: boolean;
  createdAt: string;
}

/** Final invitation email delivery outcome (not a pre-send optimistic status). */
export type InvitationDeliveryStatus =
  | "SENT_REAL"
  | "TEST_TRANSPORT"
  | "FAILED";

export function resolveInvitationDeliveryStatus(
  transport: "real" | "test" | undefined,
  failed: boolean,
): InvitationDeliveryStatus {
  if (failed || !transport) return "FAILED";
  return transport === "real" ? "SENT_REAL" : "TEST_TRANSPORT";
}

export interface InvitationDeliveryInfo {
  deliveryStatus: InvitationDeliveryStatus;
  expiresAt: string;
}

export interface CreateUserResponse {
  user: SafeUserResponse;
  invitation: InvitationDeliveryInfo;
}

export interface VerifyInvitationResponse {
  email: string;
  purpose: string;
  expiresAt: string;
}
