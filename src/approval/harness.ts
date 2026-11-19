/**
 * Approval Harness (Module 5): the only path from model output to a CRM write.
 *
 * Parity with Gina Intell: the one permitted write is a Salesforce `Task`
 * for a human ("Gina:" prefix, idempotent). The model can only PROPOSE it.
 *
 *   propose  → strict parse; kind allowlisted; target must be a record that
 *              was served to this user in this answer (provenance); task text
 *              scanned for injection and PII-masked; stored as `pending` with
 *              a hash of the exact payload and an expiry.
 *   decide   → a human approves or rejects the exact payload they saw (the
 *              hash must match), before expiry, once. The service user can
 *              never approve.
 *   execute  → only `approved` (or a `failed` retry of the same request),
 *              before expiry, one executor at a time (compare-and-set); the
 *              approver's edit access to the target is re-checked live; an
 *              existing open task for the same request is reused, never
 *              duplicated.
 *
 * Every step fails closed and never throws. Events carry ids and details,
 * never task text.
 */
import { createHash, randomUUID } from "node:crypto";
import { sanitizeChunk } from "../retrieval/sanitize.ts";
import { isRecord, isSalesforceId, loggableId, resolveTimeoutMs } from "../retrieval/validate.ts";
import { maskPii } from "../trust/pii.ts";

export const GINA_TASK_PREFIX = "Gina:";
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
export const MAX_SUBJECT_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 2_000;

/** The only action kind. Field updates, emails and deletes do not exist here. */
export interface OwnerTaskAction {
  readonly kind: "create_owner_task";
  /** The record the task is about (Account, Contact, Opportunity...). */
  readonly whatId: string;
  readonly subject: string;
  readonly description: string;
  /** Chunks the model cites; each must have been served in this answer. */
  readonly sourceChunkIds: readonly string[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executing" | "executed" | "failed";

export interface ApprovalRequest {
  readonly id: string;
  readonly action: OwnerTaskAction;
  readonly payloadHash: string;
  readonly requesterId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: ApprovalStatus;
  readonly approverId?: string;
  readonly taskId?: string;
}

export type ApprovalDetail =
  | "ok"
  | "malformed_action"
  | "action_not_allowed"
  | "target_not_served"
  | "unknown_source_chunk"
  | "injection_in_action"
  | "empty_action"
  | "not_found"
  | "hash_mismatch"
  | "expired"
  | "already_decided"
  | "service_user_cannot_approve"
  | "malformed_decision"
  | "not_approved"
  | "edit_access_denied"
  | "edit_access_unverified"
  | "already_exists"
  | "write_error"
  | "timeout"
  | "store_error";

export interface ApprovalEvent {
  readonly event: "proposed" | "approved" | "rejected" | "executed" | "denied";
  readonly detail: ApprovalDetail;
  readonly requestId: string;
  readonly actorId: string;
  readonly recordId: string;
  readonly latencyMs: number;
}

/** Atomic store. `transition` must change status only if it still equals `from`. */
export interface ApprovalStore {
  insert(request: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  transition(id: string, from: ApprovalStatus, to: ApprovalStatus, patch?: Partial<ApprovalRequest>): Promise<boolean>;
}

/** Live check: may this user edit this record? Only the literal `true` counts. */
export interface EditAccessPort {
  recordEditable(userId: string, recordId: string, signal: AbortSignal): Promise<unknown>;
}

export interface TaskDraft {
  readonly WhatId: string;
  readonly OwnerId: string;
  readonly Subject: string;
  readonly Description: string;
  readonly Status: "Not Started";
  readonly Priority: "Normal";
}

export interface TaskWriterPort {
  /** Id of an open task already created for this request, if any. */
  findOpenTask(whatId: string, requestTag: string, signal: AbortSignal): Promise<unknown>;
  createTask(draft: TaskDraft, signal: AbortSignal): Promise<unknown>;
}

export interface ServedChunkRef {
  readonly chunkId: string;
  readonly recordId: string;
}

export interface HarnessDeps {
  readonly store: ApprovalStore;
  readonly log: (event: ApprovalEvent) => void;
  /** The integration/service user. It can read and write, but never approve. */
  readonly serviceUserId: string;
  readonly clock?: () => number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: ApprovalDetail };

const TIMED_OUT = Symbol("timed_out");
const FAILED = Symbol("failed");
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** sha256 over the canonical action. What the human sees is what gets hashed. */
export function actionHash(action: OwnerTaskAction): string {
  const canonical = JSON.stringify([
    action.kind,
    action.whatId,
    action.subject,
    action.description,
    [...action.sourceChunkIds].sort(),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Short, SOQL-safe tag put in the task subject so a retry finds the same task. */
export function requestTag(requestId: string): string {
  return `#${requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT | typeof FAILED> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
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

function cleanText(raw: unknown, max: number): { text: string; poisoned: boolean } | null {
  if (typeof raw !== "string") return null;
  const scan = sanitizeChunk(raw);
  if (scan.findings.length > 0) return { text: "", poisoned: true };
  const text = maskPii(scan.text).text.slice(0, max).trim();
  return { text, poisoned: false };
}

export function createApprovalHarness(deps: HarnessDeps) {
  const clock = deps.clock ?? (() => Date.now());
  const now = deps.now ?? (() => performance.now());
  const newId = deps.newId ?? (() => randomUUID());

  const emit = (event: ApprovalEvent["event"], detail: ApprovalDetail, requestId: string, actorId: unknown, recordId: unknown, startedAt: number): void => {
    try {
      deps.log({
        event,
        detail,
        requestId,
        actorId: loggableId(actorId),
        recordId: loggableId(recordId),
        latencyMs: Math.max(0, Math.round(now() - startedAt)),
      });
    } catch {
      // A broken sink must not turn a denial into a thrown error.
    }
  };

  async function safely<T>(run: () => Promise<T>): Promise<T | typeof FAILED> {
    try {
      return await run();
    } catch {
      return FAILED;
    }
  }

  /**
   * `served` is what retrieval and the Trust Layer actually handed to the LLM
   * for this user in this answer. The model cannot target anything else.
   */
  async function propose(raw: unknown, requesterId: unknown, served: readonly ServedChunkRef[], options: { ttlMs?: number } = {}): Promise<Outcome<ApprovalRequest>> {
    const startedAt = now();
    const deny = (detail: ApprovalDetail, recordId?: unknown): Outcome<ApprovalRequest> => {
      emit("denied", detail, "-", requesterId, recordId, startedAt);
      return { ok: false, detail };
    };
    if (!isSalesforceId(requesterId) || !isRecord(raw)) return deny("malformed_action");
    if (raw["kind"] !== "create_owner_task") return deny("action_not_allowed", raw["whatId"]);
    const { whatId, sourceChunkIds } = raw;
    if (!isSalesforceId(whatId) || !Array.isArray(sourceChunkIds) || sourceChunkIds.length === 0 || sourceChunkIds.length > 20) {
      return deny("malformed_action", whatId);
    }
    if (!sourceChunkIds.every((id): id is string => typeof id === "string")) return deny("malformed_action", whatId);
    const servedById = new Map(served.map((chunk) => [chunk.chunkId, chunk.recordId]));
    if (!sourceChunkIds.every((id) => servedById.has(id))) return deny("unknown_source_chunk", whatId);
    if (!served.some((chunk) => chunk.recordId === whatId)) return deny("target_not_served", whatId);

    const subject = cleanText(raw["subject"], MAX_SUBJECT_CHARS);
    const description = cleanText(raw["description"], MAX_DESCRIPTION_CHARS);
    if (subject === null || description === null) return deny("malformed_action", whatId);
    if (subject.poisoned || description.poisoned) return deny("injection_in_action", whatId);
    if (subject.text.length === 0) return deny("empty_action", whatId);

    const action: OwnerTaskAction = {
      kind: "create_owner_task",
      whatId,
      subject: subject.text,
      description: description.text,
      sourceChunkIds: [...new Set(sourceChunkIds)].sort(),
    };
    const created = clock();
    const ttl = resolveTimeoutMs(options.ttlMs, DEFAULT_APPROVAL_TTL_MS, 24 * 60 * 60_000);
    const request: ApprovalRequest = {
      id: newId(),
      action,
      payloadHash: actionHash(action),
      requesterId,
      createdAt: created,
      expiresAt: created + ttl,
      status: "pending",
    };
    if ((await safely(() => deps.store.insert(request))) === FAILED) return deny("store_error", whatId);
    emit("proposed", "ok", request.id, requesterId, whatId, startedAt);
    return { ok: true, value: request };
  }

  /** A human decision on the exact payload they were shown. */
  async function decide(requestId: unknown, decision: unknown): Promise<Outcome<ApprovalRequest>> {
    const startedAt = now();
    const id = typeof requestId === "string" && requestId.length <= 64 ? requestId : "-";
    const approverId = isRecord(decision) ? decision["approverId"] : undefined;
    const deny = (detail: ApprovalDetail, recordId?: unknown): Outcome<ApprovalRequest> => {
      emit("denied", detail, id, approverId, recordId, startedAt);
      return { ok: false, detail };
    };
    if (id === "-" || !isRecord(decision) || !isSalesforceId(approverId)) return deny("malformed_decision");
    const verdict = decision["verdict"];
    const shownHash = decision["payloadHash"];
    if ((verdict !== "approve" && verdict !== "reject") || typeof shownHash !== "string" || !SHA256_HEX.test(shownHash)) {
      return deny("malformed_decision");
    }
    if (approverId === deps.serviceUserId) return deny("service_user_cannot_approve");

    const found = await safely(() => deps.store.get(id));
    if (found === FAILED) return deny("store_error");
    if (found === undefined) return deny("not_found");
    const target = found.action.whatId;
    if (found.status !== "pending") return deny("already_decided", target);
    if (clock() >= found.expiresAt) return deny("expired", target);
    // Recompute instead of trusting the stored hash: a tampered store cannot pass.
    if (shownHash !== found.payloadHash || shownHash !== actionHash(found.action)) return deny("hash_mismatch", target);

    const to: ApprovalStatus = verdict === "approve" ? "approved" : "rejected";
    const moved = await safely(() => deps.store.transition(id, "pending", to, { approverId }));
    if (moved === FAILED) return deny("store_error", target);
    if (!moved) return deny("already_decided", target);
    emit(to, "ok", id, approverId, target, startedAt);
    return { ok: true, value: { ...found, status: to, approverId } };
  }

  /** Executes an approved request exactly once. */
  async function execute(
    requestId: unknown,
    ports: { readonly edit: EditAccessPort; readonly writer: TaskWriterPort },
    options: { writeTimeoutMs?: number } = {},
  ): Promise<Outcome<{ readonly taskId: string; readonly reused: boolean }>> {
    const startedAt = now();
    const id = typeof requestId === "string" && requestId.length <= 64 ? requestId : "-";
    const timeoutMs = resolveTimeoutMs(options.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS);
    let actor: unknown;
    let target: unknown;
    const deny = (detail: ApprovalDetail): Outcome<{ readonly taskId: string; readonly reused: boolean }> => {
      emit("denied", detail, id, actor, target, startedAt);
      return { ok: false, detail };
    };
    if (id === "-") return deny("not_found");
    const found = await safely(() => deps.store.get(id));
    if (found === FAILED) return deny("store_error");
    if (found === undefined) return deny("not_found");
    actor = found.approverId;
    target = found.action.whatId;
    // `failed` is retryable with the same id and tag, so an ambiguous timeout
    // is resolved by findOpenTask instead of a second proposal duplicating it.
    if ((found.status !== "approved" && found.status !== "failed") || !isSalesforceId(found.approverId)) {
      return deny("not_approved");
    }
    if (clock() >= found.expiresAt) return deny("expired");
    if (actionHash(found.action) !== found.payloadHash) return deny("hash_mismatch");

    // Claim the request before any side effect: a second executor loses here.
    const claimed = await safely(() => deps.store.transition(id, found.status, "executing"));
    if (claimed === FAILED) return deny("store_error");
    if (!claimed) return deny("not_approved");
    const fail = async (detail: ApprovalDetail) => {
      await safely(() => deps.store.transition(id, "executing", "failed"));
      return deny(detail);
    };

    const approverId = found.approverId;
    const { whatId } = found.action;
    const editable = await withDeadline((signal) => ports.edit.recordEditable(approverId, whatId, signal), timeoutMs);
    if (editable === TIMED_OUT) return fail("timeout");
    if (editable === FAILED || (editable !== true && editable !== false)) return fail("edit_access_unverified");
    if (editable !== true) return fail("edit_access_denied");

    const tag = requestTag(id);
    const existing = await withDeadline((signal) => ports.writer.findOpenTask(whatId, tag, signal), timeoutMs);
    if (existing === TIMED_OUT) return fail("timeout");
    if (existing === FAILED) return fail("write_error");
    if (isSalesforceId(existing)) {
      await safely(() => deps.store.transition(id, "executing", "executed", { taskId: existing }));
      emit("executed", "already_exists", id, approverId, whatId, startedAt);
      return { ok: true, value: { taskId: existing, reused: true } };
    }

    const draft: TaskDraft = {
      WhatId: whatId,
      OwnerId: approverId,
      Subject: `${GINA_TASK_PREFIX} ${found.action.subject} ${tag}`.slice(0, 255),
      Description: found.action.description,
      Status: "Not Started",
      Priority: "Normal",
    };
    const created = await withDeadline((signal) => ports.writer.createTask(draft, signal), timeoutMs);
    // A timeout here is ambiguous (the task may exist). Fail closed: mark failed;
    // a retry of the same request runs findOpenTask first, so it cannot duplicate.
    if (created === TIMED_OUT) return fail("timeout");
    if (created === FAILED || !isSalesforceId(created)) return fail("write_error");
    await safely(() => deps.store.transition(id, "executing", "executed", { taskId: created }));
    emit("executed", "ok", id, approverId, whatId, startedAt);
    return { ok: true, value: { taskId: created, reused: false } };
  }

  return { propose, decide, execute };
}

/** In-memory store with real compare-and-set semantics. For tests and demos. */
export function createMemoryApprovalStore(): ApprovalStore & { readonly size: () => number } {
  const rows = new Map<string, ApprovalRequest>();
  return {
    size: () => rows.size,
    async insert(request) {
      if (rows.has(request.id)) throw new Error("duplicate request id");
      rows.set(request.id, request);
    },
    async get(id) {
      return rows.get(id);
    },
    async transition(id, from, to, patch = {}) {
      const row = rows.get(id);
      if (row === undefined || row.status !== from) return false;
      rows.set(id, { ...row, ...patch, id: row.id, action: row.action, payloadHash: row.payloadHash, status: to });
      return true;
    },
  };
}
