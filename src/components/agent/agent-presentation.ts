/**
 * Agent UI presentation policy.
 *
 * GenUI cards (search results, drafts, confirmations) and confirm proposals are
 * conversation artifacts: they stay inline in the message feed on both desktop
 * and mobile so they keep chronological context with the model's narrative.
 *
 * The desktop right-hand area is no longer a timeline-driven mirror of tool
 * results.  It is a user-driven Resource View (see `agent-resource-panel.tsx`)
 * that only opens when the user clicks an in-app resource link.  Therefore this
 * module no longer routes anything to an "info panel"; `genuiEnabled` remains
 * only as a global kill-switch.
 */

export type AgentSurface = "mobile" | "desktop";

/**
 * Whether successful structured tool results should render inline GenUI cards.
 *
 * Both surfaces render inline GenUI when the feature is enabled.  There is no
 * longer a desktop-only "info panel" target.
 */
export function shouldRenderInlineSuccessTool(
  _surface: AgentSurface,
  genuiEnabled: boolean,
): boolean {
  return genuiEnabled;
}

/**
 * Whether confirm proposals render inline in the message feed.
 *
 * Both surfaces keep proposals inline so the user confirms them in the same
 * message context.  There is no longer a desktop-only panel rendering.
 */
export function shouldRenderInlineProposals(
  _surface: AgentSurface,
  genuiEnabled: boolean,
): boolean {
  return genuiEnabled;
}
