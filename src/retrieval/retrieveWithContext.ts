import { randomUUID } from "node:crypto";
import {
  canonicalValue,
  chunkHash,
  type IndexPolicy,
  parseVectorRecord,
  renderFields,
  type VectorRecordV1,
} from "../contract/vectorRecord.ts";
import { decisionFor, reasonFor } from "./reasons.ts";
import { sanitizeChunk, stripInvisible } from "./sanitize.ts";
import type {
  AccessDecision,
  AccessPort,
  AuditEntry,
  AuditLogger,
  Detail,
  RetrievalResult,
  Retriever,
  SafeChunk,
  SourcePort,
} from "./types.ts";
import { isRecord, isSalesforceId, loggableId, resolveTimeoutMs } from "./validate.ts";
import { verifyAccess } from "./verifyAccess.ts";

export const DEFAULT_RETRIEVAL_TIMEOUT_MS = 3_000;
export const DEFAULT_SOURCE_TIMEOUT_MS = 2_000;
export const MAX_CANDIDATES = 20;
export const MAX_QUERY_CHARS = 2_000;
/**
 * Candidates checked per chunk served. Chunks the user may not read would
 * otherwise use up the topK budget (measured with chunk profiles: 2 of 3
 * slots went to denied wide chunks). Cost: up to this many times more access
 * checks and live reads per query, capped at MAX_CANDIDATES.
 */
export const OVERFETCH_FACTOR = 3;

export interface RetrieveDeps {
  readonly retriever: Retriever;
  readonly access: AccessPort;
  /** Live read of the declared fields. The only origin of chunk text. */
  readonly source: SourcePort;
  /** Tenant, accepted embedding models and field allowlist. Config, not index. */
  readonly policy: IndexPolicy;
  readonly log: AuditLogger;
  readonly now?: () => number;
  /** Envelope nonce. Injected for tests; random per call otherwise. */
  readonly nonce?: () => string;
}

export interface RetrieveOptions {
  readonly retrievalTimeoutMs?: number;
  readonly accessTimeoutMs?: number;
  readonly sourceTimeoutMs?: number;
}

const TIMED_OUT = Symbol("timed_out");
const FAILED = Symbol("failed");
const NONCE = /^[A-Za-z0-9-]{8,64}$/;

/** Exactly the declared fields, nothing more, nothing less. */
function parseLiveValues(raw: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== fields.length) return null;
  if (!fields.every((field) => Object.hasOwn(raw, field))) return null;
  return raw;
}

type Fetched =
  | { readonly kind: "ok"; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: "timeout" }
  | { readonly kind: "error" }
  | { readonly kind: "mismatch" };

/** Live re-fetch with its own deadline. Never throws. */
async function fetchLive(source: SourcePort, record: VectorRecordV1, timeoutMs: number): Promise<Fetched> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const read = Promise.resolve()
    .then(() => source.fetchFields(record.objectName, record.recordId, record.fields, controller.signal))
    .catch((): typeof FAILED => FAILED);
  try {
    const outcome = await Promise.race([read, deadline]);
    if (outcome === TIMED_OUT) return { kind: "timeout" };
    if (outcome === FAILED) return { kind: "error" };
    const values = parseLiveValues(outcome, record.fields);
    return values === null ? { kind: "mismatch" } : { kind: "ok", values };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Nonce envelope shared by retrieval and the Trust Layer. */
export function renderContext(chunks: readonly SafeChunk[], nonce: string): string {
  return chunks
    .map(
      (chunk, index) =>
        `<<GINA_UNTRUSTED_DATA ${nonce} chunk=${index + 1} record=${chunk.recordId}>>\n` +
        `${chunk.text}\n<<END ${nonce}>>`,
    )
    .join("\n");
}

/**
 * Retrieves chunks for `userId` and returns only those the user may read and
 * that carry no hidden payload or embedded instruction.
 *
 * Order per chunk:
 *   1. index row must satisfy the vector record contract (tenant, model,
 *      field allowlist, prior hygiene audit);
 *   2. access check (object, field, sharing) for the declared fields;
 *   3. live re-fetch of exactly those fields; the hash must still match;
 *   4. sanitization of the live text.
 * Text stored in the index is never used, so a row that lies about its
 * fields cannot leak an undeclared one. Nothing is cached between calls.
 * Never throws.
 */
export async function retrieveWithContext(
  input: unknown,
  deps: RetrieveDeps,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const audit: AuditEntry[] = [];
  const userId = loggableId(isRecord(input) ? input["userId"] : undefined);

  const record = (detail: Detail, recordId: string): void => {
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
      // verifyAccess already enforces "no audit, no allow" for the access grant.
    }
  };

  const denyAll = (detail: Detail): RetrievalResult => {
    record(detail, "*");
    return {
      status: "denied",
      reason: reasonFor(detail),
      chunks: [],
      context: "",
      audit,
      stats: { candidates: 0, allowed: 0, denied: 0 },
    };
  };

  if (!isRecord(input) || !isSalesforceId(input["userId"])) {
    return denyAll("malformed_request");
  }
  const rawQuery = input["query"];
  const rawTopK = input["topK"] ?? 5;
  if (typeof rawQuery !== "string" || rawQuery.length > MAX_QUERY_CHARS) {
    return denyAll("malformed_request");
  }
  const query = stripInvisible(rawQuery).trim();
  if (query.length === 0) return denyAll("malformed_request");
  if (typeof rawTopK !== "number" || !Number.isInteger(rawTopK) || rawTopK < 1 || rawTopK > MAX_CANDIDATES) {
    return denyAll("malformed_request");
  }

  const fetchK = Math.min(MAX_CANDIDATES, rawTopK * OVERFETCH_FACTOR);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(
      () => resolve(TIMED_OUT),
      resolveTimeoutMs(options.retrievalTimeoutMs, DEFAULT_RETRIEVAL_TIMEOUT_MS),
    );
  });
  const search = Promise.resolve()
    .then(() => deps.retriever.search(query, fetchK, controller.signal))
    .catch((): typeof FAILED => FAILED);

  let found: unknown;
  try {
    found = await Promise.race([search, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (found === TIMED_OUT) return denyAll("timeout");
  if (found === FAILED || !Array.isArray(found)) return denyAll("retriever_error");

  const sourceTimeoutMs = resolveTimeoutMs(options.sourceTimeoutMs, DEFAULT_SOURCE_TIMEOUT_MS);

  // Never trust the retriever to honour the requested count.
  const candidates: readonly unknown[] = found.slice(0, fetchK);

  // Same-instant duplicates share one check. This is not a cache across calls.
  const inFlight = new Map<string, Promise<AccessDecision>>();
  const accessFor = (candidate: VectorRecordV1): Promise<AccessDecision> => {
    const key = [
      candidate.recordId,
      candidate.objectName.toLowerCase(),
      ...candidate.fields.map((field) => field.toLowerCase()).sort(),
    ].join("|");
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = verifyAccess(
        {
          userId: input["userId"],
          objectName: candidate.objectName,
          recordId: candidate.recordId,
          fields: candidate.fields,
        },
        // The per-chunk decision is logged below, once, with the final reason.
        { access: deps.access, log: () => {}, now },
        options.accessTimeoutMs === undefined ? {} : { timeoutMs: options.accessTimeoutMs },
      );
      inFlight.set(key, pending);
    }
    return pending;
  };

  const settled = await Promise.all(
    candidates.map(async (raw): Promise<{ readonly chunk: SafeChunk; readonly fields: ReadonlySet<string> } | null> => {
      const parsed = parseVectorRecord(raw, deps.policy);
      if (!parsed.ok) {
        const rawId = isRecord(raw) ? raw["recordId"] : undefined;
        record(parsed.detail, loggableId(rawId));
        return null;
      }
      const candidate = parsed.record;
      const access = await accessFor(candidate);
      if (access.decision !== "allow") {
        record(access.detail, candidate.recordId);
        return null;
      }
      const live = await fetchLive(deps.source, candidate, sourceTimeoutMs);
      if (live.kind === "timeout") {
        record("timeout", candidate.recordId);
        return null;
      }
      if (live.kind === "error") {
        record("source_error", candidate.recordId);
        return null;
      }
      if (live.kind === "mismatch") {
        record("source_mismatch", candidate.recordId);
        return null;
      }
      // The CRM changed since ingestion: the embedding no longer describes it.
      if (chunkHash(candidate.objectName, candidate.recordId, candidate.fields, live.values) !== candidate.chunkHash) {
        record("stale_chunk", candidate.recordId);
        return null;
      }
      // Detection runs on all fields joined, so an instruction split across two
      // fields is still caught. Output is built from each value cleaned alone.
      const finding = sanitizeChunk(renderFields(candidate.fields, live.values)).findings[0];
      if (finding !== undefined) {
        record(finding, candidate.recordId);
        return null;
      }
      const cleaned = Object.fromEntries(
        candidate.fields.map((field) => [field, sanitizeChunk(canonicalValue(live.values[field])).text]),
      );
      const text = renderFields(candidate.fields, cleaned);
      if (text.length === 0) {
        record("empty_after_sanitize", candidate.recordId);
        return null;
      }
      record("ok", candidate.recordId);
      return {
        chunk: {
          chunkId: candidate.chunkId,
          recordId: candidate.recordId,
          objectName: candidate.objectName,
          text,
          trust: "untrusted_data",
        },
        fields: new Set(candidate.fields.map((field) => field.toLowerCase())),
      };
    }),
  );

  // Chunk profiles: a narrow chunk and a wider one of the same record may
  // both pass. A chunk whose fields are a strict subset of another passing
  // chunk of that record adds nothing and is not served. Chunks with
  // different (non-nested) fields, and identical duplicates, are all kept.
  const passed = settled.filter((hit): hit is NonNullable<typeof hit> => hit !== null);
  const sameRecord = (a: SafeChunk, b: SafeChunk): boolean =>
    a.recordId === b.recordId && a.objectName.toLowerCase() === b.objectName.toLowerCase();
  const strictSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size < b.size && [...a].every((field) => b.has(field));
  const chunks = passed
    .filter((hit) => !passed.some((other) => sameRecord(hit.chunk, other.chunk) && strictSubset(hit.fields, other.fields)))
    .map((hit) => hit.chunk)
    .slice(0, rawTopK);

  const supplied = deps.nonce?.();
  const nonce = typeof supplied === "string" && NONCE.test(supplied) ? supplied : randomUUID();

  return {
    status: "ok",
    reason: "allowed",
    chunks,
    context: renderContext(chunks, nonce),
    audit,
    stats: {
      candidates: candidates.length,
      allowed: chunks.length,
      denied: settled.filter((hit) => hit === null).length,
    },
  };
}
