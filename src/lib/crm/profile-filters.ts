import { GRADUATION_LOOKAHEAD_DAYS } from "./constants";

export function deriveGraduationStatus(personCategory: string | null, graduationDate: Date | null): string {
  if (!personCategory || personCategory !== "STUDENT") return "NOT_APPLICABLE";
  if (!graduationDate) return "UNKNOWN";
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const grad = new Date(graduationDate);
  grad.setHours(0, 0, 0, 0);
  if (grad <= now) return "GRADUATED";
  const lookahead = new Date(now);
  lookahead.setDate(lookahead.getDate() + GRADUATION_LOOKAHEAD_DAYS);
  if (grad <= lookahead) return "GRADUATING_SOON";
  return "ENROLLED";
}

export function buildGraduationStatusWhere(status: string): Record<string, unknown> | null {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const lookahead = new Date(now);
  lookahead.setDate(lookahead.getDate() + GRADUATION_LOOKAHEAD_DAYS);
  switch (status) {
    case "NOT_APPLICABLE":
      return {
        OR: [
          { personCategory: null },
          { personCategory: { not: "STUDENT" } },
        ],
      };
    case "UNKNOWN":
      return { personCategory: "STUDENT", graduationDate: null };
    case "ENROLLED":
      return { personCategory: "STUDENT", graduationDate: { gt: lookahead } };
    case "GRADUATING_SOON":
      return { personCategory: "STUDENT", graduationDate: { gt: now, lte: lookahead } };
    case "GRADUATED":
      return { personCategory: "STUDENT", graduationDate: { lte: now } };
    default:
      return null;
  }
}
