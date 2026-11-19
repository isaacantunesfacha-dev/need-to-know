/**
 * File-backed approval store shared by the MCP server (which proposes) and the
 * human approval CLI (which decides and executes): two processes, one file.
 *
 * Compare-and-set across processes: every read-modify-write holds an
 * exclusive lock file (created with O_EXCL), and the new state is written to
 * a temp file and renamed over the old one, so a crash never leaves a half
 * file. A stale lock (holder died) is broken after `staleLockMs`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from "./harness.ts";

export interface FileStoreOptions {
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createFileApprovalStore(path: string, options: FileStoreOptions = {}): ApprovalStore {
  const lockPath = `${path}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  const staleLockMs = options.staleLockMs ?? 10_000;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  async function withLock<T>(run: () => T): Promise<T> {
    const started = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > staleLockMs) unlinkSync(lockPath);
        } catch {
          // The holder released it between the two calls.
        }
        if (Date.now() - started > lockTimeoutMs) throw new Error("approval store is locked");
        await sleep(10);
      }
    }
    try {
      return run();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    }
  }

  function readAll(): Record<string, ApprovalRequest> {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("corrupt approval store");
    return parsed as Record<string, ApprovalRequest>;
  }

  function writeAll(rows: Record<string, ApprovalRequest>): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    insert: (request) =>
      withLock(() => {
        const rows = readAll();
        if (Object.hasOwn(rows, request.id)) throw new Error("duplicate request id");
        rows[request.id] = request;
        writeAll(rows);
      }),
    get: (id) =>
      withLock(() => {
        const rows = readAll();
        return Object.hasOwn(rows, id) ? rows[id] : undefined;
      }),
    transition: (id: string, from: ApprovalStatus, to: ApprovalStatus, patch: Partial<ApprovalRequest> = {}) =>
      withLock(() => {
        const rows = readAll();
        const row = Object.hasOwn(rows, id) ? rows[id] : undefined;
        if (row === undefined || row.status !== from) return false;
        rows[id] = { ...row, ...patch, id: row.id, action: row.action, payloadHash: row.payloadHash, status: to };
        writeAll(rows);
        return true;
      }),
  };
}

/** Lists requests for the human CLI. Read-only, no lock needed for a snapshot. */
export function listApprovals(path: string): readonly ApprovalRequest[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof parsed === "object" && parsed !== null ? (Object.values(parsed) as ApprovalRequest[]) : [];
}
