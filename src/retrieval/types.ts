/**
 * Closed set of audit reasons (CLAUDE.md, "Log reasons"). Never set by hand:
 * derived from `Detail` by `reasonFor` in reasons.ts.
 */
export type Reason =
  | "fls_unreadable"
  | "fls_denied"
  | "retriever_error"
  | "malformed_request"
  | "timeout"
  | "toxicity"
  | "injection_detected"
  | "safety_unverified"
  | "allowed";

export type Decision = "allow" | "deny";

/**
 * Finer-grained cause, kept outside `reason` so the reason enum stays closed.
 * `*_denied` = the org answered "no"; `*_unreadable` = no usable answer.
 */
export type Detail =
  | "ok"
  | "malformed_request"
  | "entity_denied"
  | "field_denied"
  | "record_denied"
  | "object_mismatch"
  | "entity_unreadable"
  | "field_unreadable"
  | "record_unreadable"
  | "object_unverified"
  | "access_check_error"
  | "audit_failure"
  | "timeout"
  | "retriever_error"
  | "malformed_candidate"
  | "oversize_chunk"
  | "empty_after_sanitize"
  | "hidden_payload"
  | "embedded_instruction"
  // Vector record contract (src/contract/vectorRecord.ts)
  | "schema_mismatch"
  | "tenant_mismatch"
  | "embedding_model_rejected"
  | "undeclared_field"
  | "hygiene_unapproved"
  // Live re-fetch from the source of truth
  | "source_error"
  | "source_mismatch"
  | "stale_chunk"
  // Trust Layer (Module 3)
  | "classifier_flagged"
  | "classifier_error";

/** Structured log line. Never carries chunk text. */
export interface AuditEntry {
  readonly decision: Decision;
  readonly reason: Reason;
  readonly userId: string;
  readonly recordId: string;
  readonly latencyMs: number;
  readonly detail: Detail;
}

export type AuditLogger = (entry: AuditEntry) => void;

export interface AccessRequest {
  readonly userId: string;
  readonly objectName: string;
  readonly recordId: string;
  readonly fields: readonly string[];
}

/**
 * Edge adapter contract. Results are `unknown` on purpose: `verifyAccess`
 * accepts only the literal boolean `true`, so a sloppy or hostile adapter
 * cannot grant access by returning something truthy.
 */
export interface AccessPort {
  /** Object-level read permission for the user. */
  entityReadable(userId: string, objectName: string, signal: AbortSignal): Promise<unknown>;
  /** Field-level security. Must return a map field -> boolean. */
  fieldsAccessible(
    userId: string,
    objectName: string,
    fields: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown>;
  /** Record-level access (sharing rules, OWD, role hierarchy). */
  recordReadable(userId: string, recordId: string, signal: AbortSignal): Promise<unknown>;
  /** The record id really belongs to the claimed object. */
  recordBelongsTo(objectName: string, recordId: string, signal: AbortSignal): Promise<unknown>;
}

export interface AccessDecision extends AuditEntry {}

/**
 * Live read of the declared fields from the source of truth (Salesforce).
 * Must return a map field -> value for exactly the requested fields; any
 * extra or missing key denies. Text never comes from the index.
 */
export interface SourcePort {
  fetchFields(
    objectName: string,
    recordId: string,
    fields: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Returns index rows (vector record contract v1). Any `text` it carries is ignored. */
export interface Retriever {
  search(query: string, topK: number, signal: AbortSignal): Promise<unknown>;
}

export interface SafeChunk {
  readonly chunkId: string;
  readonly recordId: string;
  readonly objectName: string;
  /** Sanitized text. Still data, never instructions. */
  readonly text: string;
  readonly trust: "untrusted_data";
}

export interface RetrievalResult {
  readonly status: "ok" | "denied";
  readonly reason: Reason;
  readonly chunks: readonly SafeChunk[];
  /** Chunks wrapped in a per-call nonce envelope for the next layer. */
  readonly context: string;
  readonly audit: readonly AuditEntry[];
  readonly stats: {
    readonly candidates: number;
    readonly allowed: number;
    readonly denied: number;
  };
}
