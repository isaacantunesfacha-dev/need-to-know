/**
 * Local backend CLI. Runs the whole pipeline with no Salesforce org.
 *
 *   pnpm local seed [--reset]                 create .gina/local/crm.db from the reference seed
 *   pnpm local reindex [--full]               ingest what changed in the CRM outbox (--full: everything)
 *   pnpm local ask --as admin|restricted "<question>"
 *                                             retrieval only: audit lines + the context an LLM would get
 *   pnpm local edit <recordId> Field=Value…   change a record (writes the outbox; run reindex after)
 *   pnpm local tasks                          tasks created through the approval harness
 *
 * Flags: --embedder ollama|hash (default ollama, nomic-embed-text, loopback only)
 *        --dir <path>           (default .gina/local)
 * Prints decisions, details and sanitized chunks; never AnnualRevenue or
 * any field outside the index allowlist, because retrieval never reads them.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { crmPath, type EmbedderKind, openLocalBackend } from "../src/adapters/localBackend.ts";
import { openLocalCrm, updateRecord } from "../src/adapters/localCrm/db.ts";
import { queueFullReindex, reindexChanges } from "../src/adapters/localCrm/reindex.ts";
import { SEED_USERS, seedLocalCrm } from "../src/adapters/localCrm/seed.ts";
import { retrieveWithContext } from "../src/retrieval/retrieveWithContext.ts";
import type { AuditEntry } from "../src/retrieval/types.ts";
import { isApiName, isSalesforceId } from "../src/retrieval/validate.ts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const dir = resolve(root, flag("dir") ?? ".gina/local");
const embedderKind: EmbedderKind = flag("embedder") === "hash" ? "hash" : "ollama";
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [command] = positional;

switch (command) {
  case "seed": {
    if (existsSync(crmPath(dir))) {
      if (!args.includes("--reset")) fail(`${crmPath(dir)} exists; pass --reset to rebuild it (and its index)`);
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    const crm = seedLocalCrm(crmPath(dir));
    const count = (table: string) => Number(crm.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]);
    console.log(`seeded ${crmPath(dir)}: tenant ${crm.tenantId}, ${count("users")} users, ${count("records")} records`);
    console.log(`users: admin ${SEED_USERS.admin} · restricted ${SEED_USERS.restricted}`);
    crm.close();
    break;
  }

  case "reindex": {
    const backend = await openLocalBackend({ dir, embedder: embedderKind });
    if (args.includes("--full")) console.log(`queued ${queueFullReindex(backend.crm)} records`);
    const lines = await reindexChanges(backend.crm, backend.store, backend.documents, backend.policy);
    for (const l of lines) console.log(`${l.detail.padEnd(22)} ${l.objectName.padEnd(22)} ${l.recordId}${l.consumed ? "" : "  (pending, will retry)"}`);
    console.log(`\n${lines.length} changes · index now ${backend.store.count()} chunks · model ${backend.documents.modelId}`);
    console.log(`simulated: ${backend.simulated.join(", ")}`);
    backend.close();
    break;
  }

  case "ask": {
    const who = flag("as") ?? "admin";
    const userId = who in SEED_USERS ? SEED_USERS[who as keyof typeof SEED_USERS] : who;
    const question = positional[1];
    if (question === undefined) fail('usage: pnpm local ask --as admin|restricted "<question>"');
    const backend = await openLocalBackend({ dir, embedder: embedderKind });
    const audit: AuditEntry[] = [];
    const startedAt = performance.now();
    const result = await retrieveWithContext(
      { userId, query: question, topK: 3 },
      { retriever: backend.store, access: backend.access, source: backend.source, policy: backend.policy, log: (e) => audit.push(e) },
      { retrievalTimeoutMs: 15_000 },
    );
    console.log(`user ${userId} (${who}) · ${Math.round(performance.now() - startedAt)} ms\n\naudit:`);
    for (const e of audit) console.log(`  ${e.decision.padEnd(5)} ${e.reason.padEnd(18)} ${e.detail.padEnd(18)} ${e.recordId}  ${e.latencyMs} ms`);
    console.log("\nresult:");
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nsimulated: ${backend.simulated.join(", ")}`);
    backend.close();
    break;
  }

  case "edit": {
    const recordId = positional[1];
    if (!isSalesforceId(recordId)) fail("usage: pnpm local edit <recordId> Field=Value …");
    const values: Record<string, unknown> = {};
    for (const pair of positional.slice(2)) {
      const eq = pair.indexOf("=");
      const field = pair.slice(0, eq);
      if (eq < 1 || !isApiName(field)) fail(`bad assignment: ${pair}`);
      values[field] = pair.slice(eq + 1);
    }
    const crm = openLocalCrm(crmPath(dir));
    updateRecord(crm, recordId, values);
    console.log(`updated ${recordId} (${Object.keys(values).join(", ")}); run "pnpm local reindex"`);
    crm.close();
    break;
  }

  case "tasks": {
    const crm = openLocalCrm(crmPath(dir));
    for (const t of crm.db.prepare("SELECT id, what_id, owner_id, subject, created_at FROM tasks ORDER BY created_at").all()) {
      console.log(`${t["id"]}  ${t["what_id"]}  owner ${t["owner_id"]}  ${t["subject"]}  ${t["created_at"]}`);
    }
    crm.close();
    break;
  }

  default:
    fail("usage: pnpm local seed|reindex|ask|edit|tasks  (see scripts/local.ts)");
}
