/**
 * recharts Tooltip shared styles (ui-layer canonical location, §3.5).
 *
 * recharts' default Tooltip is white-on-black and unreadable in dark mode; this
 * unifies every chart's Tooltip to theme tokens so light/dark both work.
 */
export const CHART_TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 12,
  border: "none",
  boxShadow: "var(--app-shadow-lg)",
  backgroundColor: "var(--popover)",
  color: "var(--foreground)",
} as const;

export const CHART_TOOLTIP_LABEL_STYLE = { color: "var(--muted-foreground)" } as const;

export const CHART_TOOLTIP_ITEM_STYLE = { color: "var(--foreground)" } as const;

/** Shared recharts axis/grid defaults (§3.5): border grid, muted-foreground text, size 12. */
export const CHART_AXIS_TICK_STYLE = { fontSize: 12, fill: "var(--muted-foreground)" } as const;
