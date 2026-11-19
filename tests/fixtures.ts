import { chunkHash, type IndexPolicy, VECTOR_SCHEMA_VERSION } from "../src/contract/vectorRecord.ts";

export const TENANT = "00D000000000001AAA";
export const AUDITOR = "005000000000009AAA";
export const MODEL = "text-embedding-test-v1";

export const POLICY: IndexPolicy = {
  tenantId: TENANT,
  acceptedEmbeddingModels: [MODEL],
  fieldAllowlist: {
    Account: ["Name", "Industry"],
    Gina_Private_Note__c: ["Name"],
  },
};

export const APPROVED = { status: "approved", auditedBy: AUDITOR, auditedAt: "2026-11-13T10:00:00Z" };

/** A contract-valid index row for Account 001...1AAA / Name = "Edge". Override any key. */
export function indexRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const recordId = typeof over["recordId"] === "string" ? over["recordId"] : "001000000000001AAA";
  return {
    schemaVersion: VECTOR_SCHEMA_VERSION,
    tenantId: TENANT,
    chunkId: "c1",
    recordId,
    objectName: "Account",
    fields: ["Name"],
    chunkHash: chunkHash("Account", recordId, ["Name"], { Name: "Edge" }),
    embeddingModelId: MODEL,
    sourceModifiedAt: "2026-11-13T09:00:00Z",
    ingestedAt: "2026-11-13T11:00:00Z",
    hygiene: APPROVED,
    ...over,
  };
}

/**
 * Specification of detail -> reason, written by hand on purpose: the suite
 * checks src/retrieval/reasons.ts against it instead of trusting it.
 */
export const EXPECTED_REASON: Readonly<Record<string, string>> = {
  ok: "allowed",
  malformed_request: "malformed_request",
  entity_denied: "fls_denied",
  field_denied: "fls_denied",
  record_denied: "fls_denied",
  object_mismatch: "fls_denied",
  entity_unreadable: "fls_unreadable",
  field_unreadable: "fls_unreadable",
  record_unreadable: "fls_unreadable",
  object_unverified: "fls_unreadable",
  access_check_error: "fls_unreadable",
  audit_failure: "fls_unreadable",
  timeout: "timeout",
  retriever_error: "retriever_error",
  malformed_candidate: "retriever_error",
  hidden_payload: "injection_detected",
  embedded_instruction: "injection_detected",
  oversize_chunk: "injection_detected",
  empty_after_sanitize: "injection_detected",
  schema_mismatch: "fls_denied",
  tenant_mismatch: "fls_denied",
  embedding_model_rejected: "fls_denied",
  undeclared_field: "fls_denied",
  hygiene_unapproved: "fls_denied",
  stale_chunk: "fls_denied",
  source_error: "fls_unreadable",
  source_mismatch: "fls_unreadable",
  classifier_flagged: "injection_detected",
  classifier_error: "safety_unverified",
};

export const expectedReason = (detail: string): string => {
  const reason = EXPECTED_REASON[detail];
  if (reason === undefined) throw new Error(`no expected reason for detail ${detail}`);
  return reason;
};
