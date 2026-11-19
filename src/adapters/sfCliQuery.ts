import { execFile } from "node:child_process";
import { isRecord } from "../retrieval/validate.ts";
import type { SoqlRunner } from "./salesforceAccessPort.ts";

const ORG_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/;

/**
 * Deadline to use with this transport. Each `sf` call starts a Node process:
 * one verifyAccess took 2.4-4.5 s measured on 2026-11-14, so the 2 s
 * default (sized for REST, ~0.85 s measured) would deny everything by
 * timeout. Still fail-closed, just useless; hence a transport-specific value.
 */
export const SF_CLI_TIMEOUT_MS = 30_000;

/**
 * SOQL transport over the local `sf` CLI. The CLI owns the credentials, so no
 * token passes through this process. Meant for the developer machine; the REST
 * transport is the one for a server. `execFile` is used (no shell), and the
 * query is a single argv entry.
 */
export function createSfCliRunner(orgAlias: string, binary = "sf"): SoqlRunner {
  if (!ORG_ALIAS.test(orgAlias)) throw new Error("invalid org alias");
  return (query, signal) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        ["data", "query", "--target-org", orgAlias, "--query", query, "--json"],
        { signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, SF_SKIP_NEW_VERSION_CHECK: "true" } },
        (error, stdout) => {
          if (error) {
            reject(new Error("sf data query failed"));
            return;
          }
          try {
            const parsed: unknown = JSON.parse(stdout);
            const result = isRecord(parsed) && parsed["status"] === 0 ? parsed["result"] : undefined;
            if (!isRecord(result) || result["done"] !== true || !Array.isArray(result["records"])) {
              throw new Error("unexpected sf output shape");
            }
            const rows: unknown[] = result["records"];
            if (!rows.every(isRecord)) throw new Error("unexpected sf record shape");
            resolve(rows);
          } catch (cause) {
            reject(cause instanceof Error ? cause : new Error("unparseable sf output"));
          }
        },
      );
    });
}
