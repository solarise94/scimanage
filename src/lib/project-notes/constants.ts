export const PROJECT_NOTE_CATEGORIES = [
  "GENERAL",
  "REQUIREMENT",
  "RISK",
  "DECISION",
  "FOLLOW_UP",
] as const;

export type ProjectNoteCategory = (typeof PROJECT_NOTE_CATEGORIES)[number];

export const PROJECT_NOTE_CATEGORY_LABELS: Record<ProjectNoteCategory, string> = {
  GENERAL: "通用",
  REQUIREMENT: "需求",
  RISK: "风险",
  DECISION: "决策",
  FOLLOW_UP: "待跟进",
};

export const PROJECT_NOTE_MAX_LENGTH = 5_000;

export const PROJECT_NOTE_VISIBILITIES = ["INTERNAL", "SALES_VISIBLE"] as const;

export type ProjectNoteVisibility = (typeof PROJECT_NOTE_VISIBILITIES)[number];

export function isProjectNoteCategory(value: string): value is ProjectNoteCategory {
  return PROJECT_NOTE_CATEGORIES.some((category) => category === value);
}
