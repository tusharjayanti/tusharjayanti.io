// Assertion engine shared types.
//
// Assertion modules are pure functions over a ResponseContext: the
// chat response text, the cited sources, the rag_used flag, and trace
// metadata. The context is produced by the eval runner (the
// chat-endpoint call that produces it is wired in later — see the
// runner's dispatch note); the engine here only evaluates a context
// it is handed.

export interface CitedSource {
  source: string;
  source_id?: string;
}

export interface ResponseContext {
  /** Full chat response text. */
  text: string;
  /** Sources cited by the response (from tool_result attribution). */
  sources: CitedSource[];
  /** Whether RAG (any search_* tool) was invoked for this turn. */
  rag_used: boolean;
  /** Trace metadata (Langfuse trace id etc.); opaque to assertions. */
  trace: Record<string, unknown>;
}

export interface AssertionResult {
  type: string;
  passed: boolean;
  detail: string;
}

// ---- Assertion shapes (discriminated by `type`) ----

export interface ContainsAnyAssertion {
  type: 'contains_any';
  values?: string[];
  values_ref?: string;
  case_sensitive?: boolean;
}

export interface NotContainsAssertion {
  type: 'not_contains';
  values?: string[];
  values_ref?: string;
  case_sensitive?: boolean;
}

export interface RegexAssertion {
  type: 'regex';
  pattern: string;
  flags?: string;
}

export interface RagUsedAssertion {
  type: 'rag_used';
  expected: boolean;
}

export interface SourceIncludesAssertion {
  type: 'source_includes';
  sources: string[];
  mode: 'all' | 'any';
}

export interface SourceExcludesAssertion {
  type: 'source_excludes';
  sources: string[];
}

export interface LanguageAssertion {
  type: 'language';
  expected: string;
}

export interface RefusalDetectedAssertion {
  type: 'refusal_detected';
  expected: boolean;
}

export interface LlmJudgeAssertion {
  type: 'llm_judge';
  criterion: string;
  model?: string;
}

export type Assertion =
  | ContainsAnyAssertion
  | NotContainsAssertion
  | RegexAssertion
  | RagUsedAssertion
  | SourceIncludesAssertion
  | SourceExcludesAssertion
  | LanguageAssertion
  | RefusalDetectedAssertion
  | LlmJudgeAssertion;
