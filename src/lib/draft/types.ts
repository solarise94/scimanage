/**
 * Multi-modal draft orchestrator types.
 * After the "preprocess first, extract later" refactor,
 * the orchestrator only receives plain text.
 * Image OCR and speech transcription happen in separate API endpoints.
 */

export type DraftInputPayload = string;

export interface DraftArtifact {
  fields: Record<string, unknown>;
  warnings?: string[];
  fieldMeta?: Record<
    string,
    {
      source: "text" | "search" | "project_context";
      confidence: number;
      reviewRequired?: boolean;
      reason?: string;
    }
  >;
  sources?: Array<{
    kind: "search_result";
    title?: string;
    url?: string;
    snippet?: string;
  }>;
}

export interface NormalizedInput {
  texts: string[];
  combinedText: string;
}

export interface AuditTrail {
  inputMode: string;
  searchUsed: boolean;
  searchQueries: string[];
  inferredFields: string[];
  processingTimeMs: number;
}
