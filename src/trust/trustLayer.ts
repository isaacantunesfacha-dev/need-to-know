/**
 * Trust Layer bridge (Module 3): the last gate between retrieval and the LLM.
 *
 * Per chunk, in order:
 *   1. injection classifier, with its own deadline. Only a literal
 *      `{ injection: false }` passes; flagged => `classifier_flagged`; error,
 *      unparseable or missing verdict => `classifier_error`
 *      (`safety_unverified`); deadline => `timeout`. Fail closed.
 *   2. PII masking of the surviving text (CPF, CNPJ, email, phone, card).
 *   3. a fresh nonce envelope for the LLM.
 *
 * The pattern detector already ran in retrieval; this layer adds a
 * model-based opinion on top (a chunk must pass both). It never sees field
 * values that retrieval denied, and it logs only its own denials: a chunk
 * that retrieval allowed and this layer denied has both lines in the audit.
 * Never throws.
 */
import { randomUUID } from "node:crypto";
import { decisionFor, reasonFor } from "../retrieval/reasons.ts";
import { renderContext } from "../retrieval/retrieveWithContext.ts";
import type { AuditEntry, AuditLogger, Detail, RetrievalResult, SafeChunk } from "../retrieval/types.ts";
import { loggableId, resolveTimeoutMs } from "../retrieval/validate.ts";
import { type InjectionClassifier, parseVerdict } from "./classifier.ts";
import { maskPii, type PiiKind } from "./pii.ts";

/** Local 7B model on a laptop: sized from measurement, see docs/evaluation.md. */
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 20_000;

export interface TrustedChunk extends SafeChunk {
  /** Kinds of PII masked in this chunk. Never the values. */
  readonly pii: readonly PiiKind[];
}

export interface TrustedContext {
  readonly status: "ok" | "denied";
  readonly chunks: readonly TrustedChunk[];
  readonly context: string;
  /** Retrieval audit followed by this layer's own entries. */
  readonly audit: readonly AuditEntry[];
  readonly classifierId: string;
}

export interface TrustDeps {
  readonly classifier: InjectionClassifier;
  readonly log: AuditLogger;
  /** The user the retrieval ran for; only used in audit lines. */
  readonly userId: unknown;
  readonly now?: () => number;
  readonly nonce?: () => string;
}

export interface TrustOptions {
  readonly classifierTimeoutMs?: number;
}

const TIMED_OUT = Symbol("timed_out");
const FAILED = Symbol("failed");
const NONCE = /^[A-Za-z0-9-]{8,64}$/;

async function classifyWithDeadline(
  classifier: InjectionClassifier,
  text: string,
  timeoutMs: number,
): Promise<"safe" | "flagged" | "unverified" | "timeout"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => classifier.classify(text, controller.signal))
    .catch((): typeof FAILED => FAILED);
  try {
    const outcome = await Promise.race([work, deadline]);
    if (outcome === TIMED_OUT) return "timeout";
    if (outcome === FAILED) return "unverified";
    return parseVerdict(outcome);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function applyTrustLayer(
  retrieval: RetrievalResult,
  deps: TrustDeps,
  options: TrustOptions = {},
): Promise<TrustedContext> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const userId = loggableId(deps.userId);
  const audit: AuditEntry[] = [...retrieval.audit];
  const timeoutMs = resolveTimeoutMs(options.classifierTimeoutMs, DEFAULT_CLASSIFIER_TIMEOUT_MS, 120_000);

  const deny = (detail: Detail, recordId: string): void => {
    const entry: AuditEntry = {
      decision: decisionFor(detail),
      reason: reasonFor(detail),
      detail,
      userId,
      recordId,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
    };
    audit.push(entry);
    try {
      deps.log(entry);
    } catch {
      // A broken sink must not turn a deny into a thrown error.
    }
  };

  if (retrieval.status !== "ok") {
    return { status: "denied", chunks: [], context: "", audit, classifierId: deps.classifier.id };
  }

  const chunks: TrustedChunk[] = [];
  // Sequential on purpose: a local model serves one request at a time anyway,
  // and a deadline per chunk keeps one slow answer from hiding the others.
  for (const chunk of retrieval.chunks) {
    const verdict = await classifyWithDeadline(deps.classifier, chunk.text, timeoutMs);
    if (verdict === "flagged") {
      deny("classifier_flagged", chunk.recordId);
      continue;
    }
    if (verdict === "timeout") {
      deny("timeout", chunk.recordId);
      continue;
    }
    if (verdict === "unverified") {
      deny("classifier_error", chunk.recordId);
      continue;
    }
    const masked = maskPii(chunk.text);
    chunks.push({ ...chunk, text: masked.text, pii: masked.found });
  }

  const supplied = deps.nonce?.();
  const nonce = typeof supplied === "string" && NONCE.test(supplied) ? supplied : randomUUID();
  return {
    status: "ok",
    chunks,
    context: renderContext(chunks, nonce),
    audit,
    classifierId: deps.classifier.id,
  };
}
