import type { DraftInputPayload, NormalizedInput } from "./types";

export function normalizeInput(payload: DraftInputPayload): NormalizedInput {
  const text = payload.trim();
  return {
    texts: text ? [text] : [],
    combinedText: text,
  };
}
