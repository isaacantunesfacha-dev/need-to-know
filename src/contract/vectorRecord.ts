/**
 * Vector record contract, schema v1 (Module 1 <-> Module 2 boundary).
 *
 * The index is NOT a source of truth. It only says "this record, these
 * fields, at this hash". Text is never read from the index: retrieval
 * re-fetches the declared fields live from Salesforce, re-hashes them and
 * denies on any mismatch. Pure functions, no I/O.
 */
import { createHash } from "node:crypto";
import type { Detail } from "../retrieval/types.ts";
import { isApiName, isChunkId, isFieldList, isRecord, isSalesforceId } from "../retrieval/validate.ts";

export const VECTOR_SCHEMA_VERSION = 1;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Prior audit by a human. Without it a record never enters the index. */
export interface HygieneApproval {
  readonly status: "approved";
  /** Salesforce user id of the auditor. */
  readonly auditedBy: string;
  readonly auditedAt: string;
}

export interface VectorRecordV1 {
  readonly schemaVersion: 1;
  /** 18-char Salesforce org id the record was read from. */
  readonly tenantId: string;
  readonly chunkId: string;
  readonly recordId: string;
  readonly objectName: string;
  /** Fields fixed at ingestion. The only fields retrieval will ever fetch. */
  readonly fields: readonly string[];
  /** sha256 of the canonical field values at ingestion time. */
  readonly chunkHash: string;
  readonly embeddingModelId: string;
  /** Salesforce SystemModstamp of the source record (ISO, UTC). */
  readonly sourceModifiedAt: string;
  readonly ingestedAt: string;
  readonly hygiene: HygieneApproval;
}

/**
 * Index policy, owned by configuration, never by the index.
 * `fieldAllowlist` keys are object API names; a field not listed for its
 * object is undeclared, whatever the record says.
 */
export interface IndexPolicy {
  readonly tenantId: string;
  /** More than one id while a blue/green re-embedding is in progress. */
  readonly acceptedEmbeddingModels: readonly string[];
  readonly fieldAllowlist: Readonly<Record<string, readonly string[]>>;
  /**
   * Optional chunk profiles per object: each is a subset of the allowlist and
   * becomes its own chunk, so a user who cannot read one field still gets the
   * fields they can read (from a chunk that never contained the hidden one).
   * Without profiles an object has one chunk with the whole allowlist.
   */
  readonly chunkProfiles?: Readonly<Record<string, readonly (readonly string[])[]>>;
}

export type ContractDetail = Extract<
  Detail,
  | "malformed_candidate"
  | "schema_mismatch"
  | "tenant_mismatch"
  | "embedding_model_rejected"
  | "undeclared_field"
  | "hygiene_unapproved"
>;

export type ContractResult =
  | { readonly ok: true; readonly record: VectorRecordV1 }
  | { readonly ok: false; readonly detail: ContractDetail };

const fail = (detail: ContractDetail): ContractResult => ({ ok: false, detail });

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function allowedFieldsFor(policy: IndexPolicy, objectName: string): ReadonlySet<string> | undefined {
  for (const [name, fields] of Object.entries(policy.fieldAllowlist)) {
    if (name.toLowerCase() === objectName.toLowerCase()) {
      return new Set(fields.map((field) => field.toLowerCase()));
    }
  }
  return undefined;
}

/** A valid prior audit, or null. Shared by ingestion and retrieval. */
export function parseHygiene(value: unknown): HygieneApproval | null {
  if (!isRecord(value)) return null;
  const { status, auditedBy, auditedAt } = value;
  if (status !== "approved" || !isSalesforceId(auditedBy) || !isIsoUtc(auditedAt)) return null;
  return { status, auditedBy, auditedAt };
}

/**
 * Validates an index row against schema v1 and the policy.
 * Checks run cheapest-and-most-structural first; the first failure wins.
 */
export function parseVectorRecord(input: unknown, policy: IndexPolicy): ContractResult {
  if (!isRecord(input)) return fail("malformed_candidate");
  if (input["schemaVersion"] !== VECTOR_SCHEMA_VERSION) return fail("schema_mismatch");

  const { tenantId, chunkId, recordId, objectName, fields, chunkHash, embeddingModelId } = input;
  const { sourceModifiedAt, ingestedAt } = input;
  if (
    !isSalesforceId(tenantId) ||
    !isChunkId(chunkId) ||
    !isSalesforceId(recordId) ||
    !isApiName(objectName) ||
    !isFieldList(fields) ||
    typeof chunkHash !== "string" ||
    !SHA256_HEX.test(chunkHash) ||
    typeof embeddingModelId !== "string" ||
    !MODEL_ID.test(embeddingModelId) ||
    !isIsoUtc(sourceModifiedAt) ||
    !isIsoUtc(ingestedAt) ||
    Date.parse(sourceModifiedAt) > Date.parse(ingestedAt)
  ) {
    return fail("malformed_candidate");
  }

  if (tenantId !== policy.tenantId) return fail("tenant_mismatch");
  if (!policy.acceptedEmbeddingModels.includes(embeddingModelId)) return fail("embedding_model_rejected");

  const allowed = allowedFieldsFor(policy, objectName);
  if (allowed === undefined || !fields.every((field) => allowed.has(field.toLowerCase()))) {
    return fail("undeclared_field");
  }

  const hygiene = parseHygiene(input["hygiene"]);
  if (hygiene === null) return fail("hygiene_unapproved");

  return {
    ok: true,
    record: {
      schemaVersion: VECTOR_SCHEMA_VERSION,
      tenantId,
      chunkId,
      recordId,
      objectName,
      fields: [...fields],
      chunkHash,
      embeddingModelId,
      sourceModifiedAt,
      ingestedAt,
      hygiene,
    },
  };
}

// ------------------------------------------------------------ canonical form

/** Scalar form of a CRM value. Compound values (address, geolocation) as JSON. */
export function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/** Field order does not matter; field-name case does not matter. */
function canonicalEntries(
  fields: readonly string[],
  values: Readonly<Record<string, unknown>>,
): readonly (readonly [string, string])[] {
  return [...fields]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((field) => [field, canonicalValue(values[field])] as const);
}

/**
 * sha256 over (object, record, sorted field/value pairs). The record id is
 * part of the input, so a hash cannot be replayed onto another record.
 */
export function chunkHash(
  objectName: string,
  recordId: string,
  fields: readonly string[],
  values: Readonly<Record<string, unknown>>,
): string {
  const payload = JSON.stringify([
    objectName.toLowerCase(),
    recordId,
    canonicalEntries(fields, values).map(([field, value]) => [field.toLowerCase(), value]),
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Text handed to the sanitizer: one "Field: value" line per declared field. */
export function renderFields(
  fields: readonly string[],
  values: Readonly<Record<string, unknown>>,
): string {
  return canonicalEntries(fields, values)
    .filter(([, value]) => value.length > 0)
    .map(([field, value]) => `${field}: ${value}`)
    .join("\n");
}

// ------------------------------------------------------------ ingestion side

export interface IngestInput {
  readonly tenantId: string;
  readonly chunkId: string;
  readonly recordId: string;
  readonly objectName: string;
  /** Exactly the fields to index, with the values read from the CRM. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly embeddingModelId: string;
  readonly sourceModifiedAt: string;
  /** Missing or not "approved" => the record is not indexed. */
  readonly hygiene: unknown;
}

/**
 * Builds the index row. Runs the same validation retrieval runs, so the
 * ingestor cannot write a row retrieval would reject. `ingestedAt` is
 * injected to keep the function pure.
 */
export function buildVectorRecord(input: IngestInput, policy: IndexPolicy, ingestedAt: string): ContractResult {
  if (!isRecord(input) || !isRecord(input.values)) return fail("malformed_candidate");
  const fields = Object.keys(input.values);
  if (!isApiName(input.objectName) || !isSalesforceId(input.recordId) || !isFieldList(fields)) {
    return fail("malformed_candidate");
  }
  return parseVectorRecord(
    {
      schemaVersion: VECTOR_SCHEMA_VERSION,
      tenantId: input.tenantId,
      chunkId: input.chunkId,
      recordId: input.recordId,
      objectName: input.objectName,
      fields,
      chunkHash: chunkHash(input.objectName, input.recordId, fields, input.values),
      embeddingModelId: input.embeddingModelId,
      sourceModifiedAt: input.sourceModifiedAt,
      ingestedAt,
      hygiene: input.hygiene,
    },
    policy,
  );
}

// ------------------------------------------------------------ chunk profiles

const MAX_PROFILES = 8;

/**
 * The field sets to index for an object, in the allowlist's own spelling.
 * The whole allowlist is always one of them. Any profile that is empty, has
 * an invalid name or a field outside the allowlist makes the whole policy for
 * the object unusable (undefined): a configuration error is not guessed at.
 */
export function chunkProfilesFor(policy: IndexPolicy, objectName: string): readonly (readonly string[])[] | undefined {
  const entry = Object.entries(policy.fieldAllowlist).find(([name]) => name.toLowerCase() === objectName.toLowerCase());
  const allowlist = entry?.[1];
  if (allowlist === undefined || !isFieldList(allowlist)) return undefined;
  const spelling = new Map(allowlist.map((field) => [field.toLowerCase(), field]));
  const raw = Object.entries(policy.chunkProfiles ?? {}).find(([name]) => name.toLowerCase() === objectName.toLowerCase())?.[1] ?? [];
  if (raw.length > MAX_PROFILES) return undefined;
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const profile of [allowlist, ...raw]) {
    if (!isFieldList(profile)) return undefined;
    const mapped = profile.map((field) => spelling.get(field.toLowerCase()));
    if (mapped.some((field) => field === undefined)) return undefined;
    const fields = mapped as string[];
    const key = fields.map((f) => f.toLowerCase()).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fields);
  }
  return out;
}

/**
 * Chunk id for a profile. The full allowlist keeps the v1 id
 * ("Object.recordId"); a narrower profile gets a stable suffix from its
 * sorted field names, so reordering the configuration does not rename it.
 */
export function profileChunkId(objectName: string, recordId: string, fields: readonly string[], isFull: boolean): string {
  if (isFull) return `${objectName}.${recordId}`;
  const key = fields.map((f) => f.toLowerCase()).sort().join("|");
  return `${objectName}.${recordId}.p${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}
