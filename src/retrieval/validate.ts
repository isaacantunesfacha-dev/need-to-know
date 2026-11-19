/** 18-char Salesforce id only. 15-char ids are rejected, not normalized. */
const SF_ID = /^[a-zA-Z0-9]{18}$/;
/** API name of an object or field, including namespace and __c / __r suffixes. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const CHUNK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const MAX_FIELDS = 50;

export function isSalesforceId(value: unknown): value is string {
  return typeof value === "string" && SF_ID.test(value);
}

export function isApiName(value: unknown): value is string {
  return typeof value === "string" && API_NAME.test(value);
}

export function isChunkId(value: unknown): value is string {
  return typeof value === "string" && CHUNK_ID.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Valid field list: 1..MAX_FIELDS API names, unique ignoring case. */
export function isFieldList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIELDS) return false;
  const seen = new Set<string>();
  for (const field of value) {
    if (!isApiName(field)) return false;
    const key = field.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Id safe to write in a log line. Hostile input never reaches the log. */
export function loggableId(value: unknown): string {
  return isSalesforceId(value) ? value : "invalid";
}

/** Bounded timeout. Anything not a sane positive number falls back to the default. */
export function resolveTimeoutMs(value: unknown, fallback: number, max = 30_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.ceil(value), max);
}
