import type { Decision, Detail, Reason } from "./types.ts";

/**
 * The only place where a `detail` becomes a `reason`. Callers pass the detail;
 * the reason and the decision are derived, so the audit log cannot disagree
 * with the `Reason` enum in types.ts.
 *
 * `fls_unreadable` means the permission could not be confirmed (error,
 * missing or ambiguous answer). `fls_denied` means a definite "no", from the
 * org or from the index policy. Both deny; they differ only in what an
 * operator should do next: fix the plumbing, or accept the denial.
 *
 * `safety_unverified` is the content-side twin of `fls_unreadable`: the
 * Trust Layer could not confirm a chunk is safe (classifier error or
 * unparseable verdict), so it is denied. `toxicity` stays reserved for a
 * toxicity classifier; nothing emits it yet.
 */
export const REASON_FOR = {
  ok: "allowed",

  malformed_request: "malformed_request",

  // Org answered "no".
  entity_denied: "fls_denied",
  field_denied: "fls_denied",
  record_denied: "fls_denied",
  object_mismatch: "fls_denied",
  // Org answer missing, ambiguous or failed.
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

  // Index policy said "no" (vector record contract v1).
  schema_mismatch: "fls_denied",
  tenant_mismatch: "fls_denied",
  embedding_model_rejected: "fls_denied",
  undeclared_field: "fls_denied",
  hygiene_unapproved: "fls_denied",
  stale_chunk: "fls_denied",
  // Live read failed or answered something other than what was asked.
  source_error: "fls_unreadable",
  source_mismatch: "fls_unreadable",

  // Trust Layer: the classifier said "injection", or gave no usable verdict.
  classifier_flagged: "injection_detected",
  classifier_error: "safety_unverified",
} as const satisfies Record<Detail, Reason>;

export function reasonFor(detail: Detail): Reason {
  return REASON_FOR[detail];
}

export function decisionFor(detail: Detail): Decision {
  return detail === "ok" ? "allow" : "deny";
}
