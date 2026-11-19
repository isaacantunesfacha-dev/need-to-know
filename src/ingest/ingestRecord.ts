/**
 * Clean Ingestor (Module 1), offline quantum. One CRM record in, one index
 * row per chunk profile out (one row without profiles), or a typed
 * rejection. Never throws.
 *
 * Order: hygiene audit first (an unaudited record is never even read),
 * snapshot of exactly the allowlisted fields, injection scan, embedding,
 * write. The row is built by `buildVectorRecord`, so the ingestor cannot
 * write anything retrieval would reject.
 */
import {
  buildVectorRecord,
  chunkProfilesFor,
  profileChunkId,
  type IndexPolicy,
  parseHygiene,
  renderFields,
  type VectorRecordV1,
} from "../contract/vectorRecord.ts";
import { sanitizeChunk } from "../retrieval/sanitize.ts";
import { isApiName, isRecord, isSalesforceId, loggableId, resolveTimeoutMs } from "../retrieval/validate.ts";

export const DEFAULT_INGEST_STEP_TIMEOUT_MS = 10_000;
export const MAX_EMBEDDING_DIMENSIONS = 8_192;

/** Snapshot of one record: exactly the requested fields plus SystemModstamp. */
export interface IngestSourcePort {
  readSnapshot(objectName: string, recordId: string, fields: readonly string[], signal: AbortSignal): Promise<unknown>;
}

/** Where the DBA audit lives. Answers the approval object, or anything else for "not approved". */
export interface HygieneLedger {
  approvalFor(tenantId: string, objectName: string, recordId: string, signal: AbortSignal): Promise<unknown>;
}

export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embed(text: string, signal: AbortSignal): Promise<unknown>;
}

export interface IndexEntry {
  readonly record: VectorRecordV1;
  readonly vector: readonly number[];
}

export interface IndexWriter {
  upsert(entry: IndexEntry, signal: AbortSignal): Promise<unknown>;
}

export type IngestDetail =
  | "indexed"
  | "malformed_request"
  | "undeclared_field"
  | "hygiene_unapproved"
  | "hygiene_error"
  | "source_error"
  | "source_mismatch"
  | "embedded_instruction"
  | "hidden_payload"
  | "oversize_chunk"
  | "empty_record"
  | "embedding_model_rejected"
  | "embedding_error"
  | "write_error"
  | "contract_rejected"
  | "timeout";

/** Structured ingestion log line. Never carries field values. */
export interface IngestOutcome {
  readonly decision: "indexed" | "rejected";
  readonly detail: IngestDetail;
  readonly objectName: string;
  readonly recordId: string;
  readonly latencyMs: number;
  /** The whole-allowlist chunk (or the first profile that had content). */
  readonly record?: VectorRecordV1;
  /** Every chunk written, one per non-empty profile. */
  readonly records?: readonly VectorRecordV1[];
}

export interface IngestRequest {
  readonly tenantId: string;
  readonly objectName: string;
  readonly recordId: string;
}

export interface IngestDeps {
  readonly source: IngestSourcePort;
  readonly hygiene: HygieneLedger;
  readonly embedder: Embedder;
  readonly writer: IndexWriter;
  readonly policy: IndexPolicy;
  /** ISO clock for `ingestedAt`. Injected for tests. */
  readonly clock?: () => string;
  readonly now?: () => number;
}

export interface IngestOptions {
  readonly stepTimeoutMs?: number;
}

const TIMED_OUT = Symbol("timed_out");
const FAILED = Symbol("failed");

async function step<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT | typeof FAILED> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => run(controller.signal))
    .catch((): typeof FAILED => FAILED);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function allowlistFor(policy: IndexPolicy, objectName: string): readonly string[] | undefined {
  const entry = Object.entries(policy.fieldAllowlist).find(
    ([name]) => name.toLowerCase() === objectName.toLowerCase(),
  );
  return entry?.[1];
}

/** Salesforce answers "2026-11-13T09:00:00.000+0000"; the contract wants ISO UTC with "Z". */
function toIsoUtc(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function parseSnapshot(
  raw: unknown,
  fields: readonly string[],
): { readonly values: Record<string, unknown>; readonly modifiedAt: string } | null {
  if (!isRecord(raw) || !isRecord(raw["values"])) return null;
  const values = raw["values"];
  const modifiedAt = toIsoUtc(raw["systemModstamp"]);
  if (modifiedAt === undefined) return null;
  if (Object.keys(values).length !== fields.length) return null;
  if (!fields.every((field) => Object.hasOwn(values, field))) return null;
  return { values: { ...values }, modifiedAt };
}

function parseVector(raw: unknown, dimensions: number): readonly number[] | null {
  if (!Array.isArray(raw) || raw.length !== dimensions) return null;
  return raw.every((x) => typeof x === "number" && Number.isFinite(x)) ? (raw as number[]) : null;
}

export async function ingestRecord(
  input: unknown,
  deps: IngestDeps,
  options: IngestOptions = {},
): Promise<IngestOutcome> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const timeoutMs = resolveTimeoutMs(options.stepTimeoutMs, DEFAULT_INGEST_STEP_TIMEOUT_MS, 60_000);
  const objectName = isRecord(input) && isApiName(input["objectName"]) ? input["objectName"] : "invalid";
  const recordId = loggableId(isRecord(input) ? input["recordId"] : undefined);

  const done = (detail: IngestDetail, records?: readonly VectorRecordV1[]): IngestOutcome => ({
    decision: detail === "indexed" ? "indexed" : "rejected",
    detail,
    objectName,
    recordId,
    latencyMs: Math.max(0, Math.round(now() - startedAt)),
    ...(records?.[0] === undefined ? {} : { record: records[0], records }),
  });

  if (!isRecord(input) || !isSalesforceId(input["tenantId"]) || objectName === "invalid" || recordId === "invalid") {
    return done("malformed_request");
  }
  const tenantId = input["tenantId"];
  if (tenantId !== deps.policy.tenantId) return done("malformed_request");
  const { embedder } = deps;
  if (!deps.policy.acceptedEmbeddingModels.includes(embedder.modelId)) return done("embedding_model_rejected");
  if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1 || embedder.dimensions > MAX_EMBEDDING_DIMENSIONS) {
    return done("embedding_error");
  }
  const fields = allowlistFor(deps.policy, objectName);
  if (fields === undefined || fields.length === 0) return done("undeclared_field");

  // 1. Prior audit. Without it the record is not read at all.
  const approval = await step((signal) => deps.hygiene.approvalFor(tenantId, objectName, recordId, signal), timeoutMs);
  if (approval === TIMED_OUT) return done("timeout");
  if (approval === FAILED) return done("hygiene_error");
  const hygiene = parseHygiene(approval);
  if (hygiene === null) return done("hygiene_unapproved");

  // 2. Snapshot of exactly the allowlisted fields.
  const raw = await step((signal) => deps.source.readSnapshot(objectName, recordId, fields, signal), timeoutMs);
  if (raw === TIMED_OUT) return done("timeout");
  if (raw === FAILED) return done("source_error");
  const snapshot = parseSnapshot(raw, fields);
  if (snapshot === null) return done("source_mismatch");

  // 3. A poisoned record is quarantined whole, before any chunk is built: a
  //    clean narrow profile of a poisoned record is still a poisoned record.
  const text = renderFields(fields, snapshot.values);
  if (text.length === 0) return done("empty_record");
  const finding = sanitizeChunk(text).findings[0];
  if (finding !== undefined) return done(finding);

  // 4. One chunk per profile (the whole allowlist is always the first).
  const profiles = chunkProfilesFor(deps.policy, objectName);
  if (profiles === undefined) return done("undeclared_field");
  const ingestedAt = (deps.clock ?? (() => new Date().toISOString()))();
  const built: { record: VectorRecordV1; text: string }[] = [];
  for (const [index, profile] of profiles.entries()) {
    const values = Object.fromEntries(profile.map((field) => [field, snapshot.values[field]]));
    const profileText = renderFields(profile, values);
    // A profile whose fields are all empty says nothing; it is not indexed.
    if (profileText.length === 0) continue;
    const row = buildVectorRecord(
      {
        tenantId,
        chunkId: profileChunkId(objectName, recordId, profile, index === 0),
        recordId,
        objectName,
        values,
        embeddingModelId: embedder.modelId,
        sourceModifiedAt: snapshot.modifiedAt,
        hygiene,
      },
      deps.policy,
      ingestedAt,
    );
    if (!row.ok) return done("contract_rejected");
    built.push({ record: row.record, text: profileText });
  }
  if (built.length === 0) return done("empty_record");

  // 5. Embed and write each chunk. A failure stops the run; chunks already
  //    written are contract-valid and re-verified live at retrieval.
  for (const chunk of built) {
    const vectorRaw = await step((signal) => embedder.embed(chunk.text, signal), timeoutMs);
    if (vectorRaw === TIMED_OUT) return done("timeout");
    const vector = vectorRaw === FAILED ? null : parseVector(vectorRaw, embedder.dimensions);
    if (vector === null) return done("embedding_error");
    const written = await step((signal) => deps.writer.upsert({ record: chunk.record, vector }, signal), timeoutMs);
    if (written === TIMED_OUT) return done("timeout");
    if (written === FAILED) return done("write_error");
  }
  return done("indexed", built.map((chunk) => chunk.record));
}
