/** Provider interfaces — vendor-agnostic abstractions. */

export interface ChatProvider {
  chat(params: {
    systemPrompt: string;
    userMessage: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

export interface VisionProvider {
  extractText(params: {
    imageUrl: string;
    prompt: string;
  }): Promise<{ text: string }>;
}

export interface SearchProvider {
  search(params: {
    query: string;
    maxResults?: number;
  }): Promise<{
    results: Array<{
      title: string;
      url: string;
      snippet: string;
    }>;
  }>;
}

export interface SpeechProvider {
  transcribe(params: {
    data: Buffer;
    mimeType: string;
    language?: string;
    /** Optional abort signal to cancel the transcription. */
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    durationMs?: number;
    words?: Array<{ startMs: number; endMs: number; word: string }>;
  }>;
}
