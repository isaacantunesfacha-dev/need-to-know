import { decisionFor, reasonFor } from "./reasons.ts";
import type { AccessDecision, AccessPort, AccessRequest, AuditLogger, Detail } from "./types.ts";
import {
  isApiName,
  isFieldList,
  isRecord,
  isSalesforceId,
  loggableId,
  resolveTimeoutMs,
} from "./validate.ts";

/** Sized for the REST transport. The sf CLI transport needs SF_CLI_TIMEOUT_MS. */
export const DEFAULT_ACCESS_TIMEOUT_MS = 2_000;

export interface VerifyDeps {
  readonly access: AccessPort;
  readonly log: AuditLogger;
  /** Monotonic clock in ms. Injected for tests. */
  readonly now?: () => number;
}

export interface VerifyOptions {
  readonly timeoutMs?: number;
}

const TIMED_OUT = Symbol("timed_out");
const FAILED = Symbol("failed");

function parseRequest(input: unknown): AccessRequest | null {
  if (!isRecord(input)) return null;
  const { userId, objectName, recordId, fields } = input;
  if (!isSalesforceId(userId) || !isSalesforceId(recordId)) return null;
  if (!isApiName(objectName) || !isFieldList(fields)) return null;
  return { userId, objectName, recordId, fields: [...fields] };
}

/**
 * First failing check, or "ok". Only the literal `true` counts as a grant.
 * A literal `false` is a definite denial; anything else is "no usable answer".
 */
function evaluate(
  request: AccessRequest,
  results: readonly [unknown, unknown, unknown, unknown],
): Detail {
  const [entity, belongs, fields, record] = results;
  if (entity !== true) return entity === false ? "entity_denied" : "entity_unreadable";
  if (belongs !== true) return belongs === false ? "object_mismatch" : "object_unverified";
  // A field missing from the answer is NOT allowed: it may be hidden, not absent.
  if (!isRecord(fields)) return "field_unreadable";
  for (const field of request.fields) {
    const granted = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (granted !== true) return granted === false ? "field_denied" : "field_unreadable";
  }
  if (record !== true) return record === false ? "record_denied" : "record_unreadable";
  return "ok";
}

/**
 * Decides whether `userId` may read `fields` of `recordId`.
 * Fail closed: malformed input, any error, any non-`true` answer and any
 * timeout deny. An allow that cannot be written to the audit log is a deny.
 * Never throws.
 */
export async function verifyAccess(
  input: unknown,
  deps: VerifyDeps,
  options: VerifyOptions = {},
): Promise<AccessDecision> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const userId = loggableId(isRecord(input) ? input["userId"] : undefined);
  const recordId = loggableId(isRecord(input) ? input["recordId"] : undefined);

  const finish = (detail: Detail): AccessDecision => {
    const entry: AccessDecision = {
      decision: decisionFor(detail),
      reason: reasonFor(detail),
      detail,
      userId,
      recordId,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
    };
    if (entry.decision === "allow") {
      try {
        deps.log(entry);
        return entry;
      } catch {
        return finish("audit_failure");
      }
    }
    try {
      deps.log(entry);
    } catch {
      // A broken logger must not turn a deny into a thrown error.
    }
    return entry;
  };

  const request = parseRequest(input);
  if (request === null) return finish("malformed_request");

  const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_ACCESS_TIMEOUT_MS);
  const controller = new AbortController();
  const { signal } = controller;
  const { access } = deps;

  // Promise.resolve().then(...) turns a synchronous throw into a rejection.
  const checks = Promise.all([
    Promise.resolve().then(() => access.entityReadable(request.userId, request.objectName, signal)),
    Promise.resolve().then(() => access.recordBelongsTo(request.objectName, request.recordId, signal)),
    Promise.resolve().then(() =>
      access.fieldsAccessible(request.userId, request.objectName, request.fields, signal),
    ),
    Promise.resolve().then(() => access.recordReadable(request.userId, request.recordId, signal)),
  ]).catch((): typeof FAILED => FAILED);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  try {
    const outcome = await Promise.race([checks, deadline]);
    if (outcome === TIMED_OUT) return finish("timeout");
    if (outcome === FAILED) return finish("access_check_error");
    return finish(evaluate(request, outcome));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
