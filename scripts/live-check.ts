/**
 * Read-only parity check against the real org (minha-org-agentforce).
 *
 * Part 1 (Module 2): verifyAccess through the Salesforce adapter, one case
 *   per denial path that the org can really produce.
 * Part 2 (Module 1): the real ingestor reads a record WITH USER_MODE, builds
 *   the vector row, and retrieveWithContext serves it back through the real
 *   access checks and the real live read. Only two pieces are simulated, and
 *   the output says so: the embedder (deterministic hash, no provider chosen
 *   yet) and the vector index (the retriever returns the ingested row).
 * Part 3 (optional): latency percentiles from repeated samples.
 *
 * Prints decisions, details and latencies only. Never the token, never data.
 *
 * Usage:
 *   node scripts/live-check.ts <adminUserId> <accountId> [otherObjectRecordId]
 *     [--rest] [--restricted=<userId>] [--opportunity=<id>]
 *     [--own-note=<id>] [--hidden-note=<id>] [--samples=<n>]
 */
import { createHash } from "node:crypto";
import { createAccessPortFromQuery, createRestSoqlRunner, type SoqlRunner } from "../src/adapters/salesforceAccessPort.ts";
import { createEditAccessPort } from "../src/adapters/salesforceApproval.ts";
import { createIngestSourceFromQuery } from "../src/adapters/salesforceIngestSource.ts";
import { createSourcePortFromQuery } from "../src/adapters/salesforceSourcePort.ts";
import { createSfCliRunner, SF_CLI_TIMEOUT_MS } from "../src/adapters/sfCliQuery.ts";
import { chunkHash, type IndexPolicy, type VectorRecordV1 } from "../src/contract/vectorRecord.ts";
import { type IndexEntry, ingestRecord } from "../src/ingest/ingestRecord.ts";
import { retrieveWithContext } from "../src/retrieval/retrieveWithContext.ts";
import type { AuditEntry } from "../src/retrieval/types.ts";
import { verifyAccess } from "../src/retrieval/verifyAccess.ts";

const useRest = process.argv.includes("--rest");
const [userId, accountId, foreignId] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!userId || !accountId) {
  console.error("usage: node scripts/live-check.ts <adminUserId> <accountId> [otherObjectRecordId] [--rest] [--samples=<n>] ...");
  process.exit(2);
}
const flag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

// Diagnostics only: HTTP status and Salesforce error code per query. No token, no data.
const httpTrace: string[] = [];
const tracingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    const from = / FROM (\w+)/.exec(new URL(String(input)).searchParams.get("q") ?? "")?.[1] ?? "?";
    const body: unknown = await response.clone().json().catch(() => null);
    const first: unknown = Array.isArray(body) ? body[0] : null;
    const code =
      typeof first === "object" && first !== null && "errorCode" in first ? String(first.errorCode) : "?";
    httpTrace.push(`${from}: HTTP ${response.status} ${code}`);
  }
  return response;
};

function buildSoql(): SoqlRunner {
  if (!useRest) {
    // Default transport: the local `sf` CLI, which owns the credentials.
    return createSfCliRunner(process.env["SALESFORCE_ORG_ALIAS"] ?? "minha-org-agentforce");
  }
  process.loadEnvFile(new URL("../.env.local", import.meta.url));
  const instanceUrl = process.env["SALESFORCE_INSTANCE_URL"];
  const accessToken = process.env["SALESFORCE_ACCESS_TOKEN"];
  if (!instanceUrl || !accessToken) {
    console.error("--rest needs SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN in .env.local");
    process.exit(2);
  }
  return createRestSoqlRunner({ instanceUrl, accessToken, fetchImpl: tracingFetch });
}

let soqlCalls = 0;
const rawSoql = buildSoql();
const soql: SoqlRunner = (query, signal) => {
  soqlCalls += 1;
  return rawSoql(query, signal);
};
const access = createAccessPortFromQuery(soql);
const timeoutMs = useRest ? 10_000 : SF_CLI_TIMEOUT_MS;
console.log(`transport: ${useRest ? "REST (.env.local token)" : "sf CLI"} · deadline ${timeoutMs} ms per step\n`);

let checks = 0;
let failures = 0;
function report(name: string, expect: string, got: string, latencyMs: number): void {
  checks += 1;
  const pass = got === expect;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      expected ${expect}\n      got      ${got}  (${latencyMs} ms)`);
}

// ------------------------------------------------------------------ Part 1

interface Case {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly expect: string;
}

const base = { userId, objectName: "Account", recordId: accountId, fields: ["Name", "AnnualRevenue"] };
const cases: Case[] = [
  { name: "admin reads Account.Name + AnnualRevenue", input: base, expect: "allow/allowed/ok" },
  {
    name: "field that does not exist",
    input: { ...base, fields: ["Name", "GinaNoSuchField__c"] },
    // FieldDefinition has no row for it: no usable answer, so "unreadable", not "denied".
    expect: "deny/fls_unreadable/field_unreadable",
  },
  {
    name: "unknown user id",
    input: { ...base, userId: "005000000000000AAA" },
    // Measured: the org answers INVALID_CROSS_REFERENCE_KEY.
    expect: "deny/fls_unreadable/access_check_error",
  },
  { name: "1 ms deadline", input: base, timeoutMs: 1, expect: "deny/timeout/timeout" },
];
if (foreignId) {
  cases.push({
    name: "record id from another object",
    input: { ...base, recordId: foreignId },
    expect: "deny/fls_denied/object_mismatch",
  });
}

// Restricted user: profile "Minimum Access - Salesforce" + permission set
// Gina_RAG_Restricted_Test (Account read, Industry only).
const restrictedId = flag("restricted");
const opportunityId = flag("opportunity");
if (restrictedId) {
  const restricted = { ...base, userId: restrictedId };
  cases.push(
    {
      name: "restricted user reads Account.Name + Industry",
      input: { ...restricted, fields: ["Name", "Industry"] },
      expect: "allow/allowed/ok",
    },
    {
      name: "restricted user asks for AnnualRevenue (hidden by FLS)",
      input: { ...restricted, fields: ["Name", "AnnualRevenue"] },
      // Measured 2026-11-14: UserFieldAccess answers IsAccessible = false.
      expect: "deny/fls_denied/field_denied",
    },
  );
  if (opportunityId) {
    cases.push({
      name: "restricted user asks for an Opportunity (no object read)",
      input: { userId: restrictedId, objectName: "Opportunity", recordId: opportunityId, fields: ["Name"] },
      expect: "deny/fls_denied/entity_denied",
    });
  }
}

// Sharing: Gina_Private_Note__c has Private org-wide sharing and the
// restricted user has object read on it, so only record ownership differs.
const hiddenNoteId = flag("hidden-note");
const ownNoteId = flag("own-note");
if (restrictedId && hiddenNoteId && ownNoteId) {
  const note = { userId: restrictedId, objectName: "Gina_Private_Note__c", fields: ["Name"] };
  cases.push(
    { name: "restricted user reads a note they own", input: { ...note, recordId: ownNoteId }, expect: "allow/allowed/ok" },
    {
      name: "restricted user asks for a note owned by someone else (hidden by sharing)",
      input: { ...note, recordId: hiddenNoteId },
      // Measured 2026-11-14: UserRecordAccess answers HasReadAccess = false.
      expect: "deny/fls_denied/record_denied",
    },
    {
      name: "admin reads the same hidden note",
      input: { ...note, userId, recordId: hiddenNoteId },
      expect: "allow/allowed/ok",
    },
  );
}

console.log("== Part 1 · Module 2 · verifyAccess\n");
for (const item of cases) {
  const result = await verifyAccess(item.input, { access, log: () => {} }, { timeoutMs: item.timeoutMs ?? timeoutMs });
  report(item.name, item.expect, `${result.decision}/${result.reason}/${result.detail}`, result.latencyMs);
}

// ------------------------------------------------------------------ Part 2

const orgRows = await soql("SELECT Id FROM Organization", AbortSignal.timeout(timeoutMs));
const tenantId = String(orgRows[0]?.["Id"] ?? "");
const SIMULATED_MODEL = "simulated-sha256-v0";
const policy: IndexPolicy = {
  tenantId,
  acceptedEmbeddingModels: [SIMULATED_MODEL],
  fieldAllowlist: { Account: ["Name", "Industry"] },
};
const index: IndexEntry[] = [];

console.log("\n== Part 2 · Module 1 · ingest -> retrieve against the org");
console.log("   simulated: embedder (sha256 -> 8 floats) and vector index (retriever returns the ingested row)\n");

const ingested = await ingestRecord(
  { tenantId, objectName: "Account", recordId: accountId },
  {
    source: createIngestSourceFromQuery(soql),
    // The approval is written by hand here: the hygiene ledger is not built yet.
    hygiene: { approvalFor: async () => ({ status: "approved", auditedBy: userId, auditedAt: new Date().toISOString() }) },
    embedder: {
      modelId: SIMULATED_MODEL,
      dimensions: 8,
      embed: async (text) => [...createHash("sha256").update(text).digest().subarray(0, 8)].map((b) => b / 255),
    },
    writer: { upsert: async (entry) => void index.push(entry) },
    policy,
  },
  { stepTimeoutMs: timeoutMs },
);
report("ingest Account (Name, Industry) WITH USER_MODE", "indexed", ingested.detail, ingested.latencyMs);

const row = index[0]?.record;
async function serve(asUser: string, rows: readonly unknown[]): Promise<{ got: string; latencyMs: number }> {
  const audit: AuditEntry[] = [];
  const startedAt = performance.now();
  await retrieveWithContext(
    { userId: asUser, query: "status da conta", topK: 5 },
    { retriever: { search: async () => rows }, access, source: createSourcePortFromQuery(soql), policy, log: (e) => audit.push(e) },
    { accessTimeoutMs: timeoutMs, sourceTimeoutMs: timeoutMs, retrievalTimeoutMs: timeoutMs },
  );
  const first = audit[0];
  return {
    got: first === undefined ? "no audit" : `${first.decision}/${first.reason}/${first.detail}`,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

if (row !== undefined) {
  const served = await serve(userId, [row]);
  report("admin retrieves the ingested row (live read + hash match)", "allow/allowed/ok", served.got, served.latencyMs);

  const tampered: VectorRecordV1 = { ...row, chunkHash: chunkHash("Account", accountId, row.fields, { Name: "x", Industry: "y" }) };
  const stale = await serve(userId, [tampered]);
  report("row whose hash no longer matches the CRM", "deny/fls_denied/stale_chunk", stale.got, stale.latencyMs);

  const before = soqlCalls;
  const lying = await serve(userId, [{ ...row, fields: ["Name", "AnnualRevenue"] }]);
  report("row declaring a field outside the allowlist", "deny/fls_denied/undeclared_field", lying.got, lying.latencyMs);
  report("  ...and the org was never queried for it", "0 queries", `${soqlCalls - before} queries`, 0);

  if (restrictedId) {
    const restrictedServe = await serve(restrictedId, [row]);
    report("restricted user retrieves the same row (Name + Industry readable)", "allow/allowed/ok", restrictedServe.got, restrictedServe.latencyMs);
  }
}

const startedAt = performance.now();
const missing = await createSourcePortFromQuery(soql)
  .fetchFields("Account", accountId, ["GinaNoSuchField__c"], AbortSignal.timeout(timeoutMs))
  .then(() => "returned", () => "threw");
report("live read of a field the org does not define", "threw", missing, Math.round(performance.now() - startedAt));

// ------------------------------------------------------------- Part 2b (M5)

// Module 5 re-checks the approver's edit access right before the only write.
// This part is read-only: it never creates a Task.
console.log("\n== Part 2b · Module 5 · approver edit access (read-only, no task is created)\n");
const edit = createEditAccessPort(soql);
const editTarget: string = accountId;
async function editCase(name: string, who: string, expect: string): Promise<void> {
  const startedAt = performance.now();
  const got = await edit
    .recordEditable(who, editTarget, AbortSignal.timeout(timeoutMs))
    .then((answer) => `HasEditAccess=${String(answer)}`, () => "threw");
  report(name, expect, got, Math.round(performance.now() - startedAt));
}
await editCase("admin can edit the Account (may approve a task on it)", userId, "HasEditAccess=true");
if (restrictedId) {
  // Prediction before the first run: the permission set grants Account read only.
  await editCase("restricted user cannot edit the Account (approval would be denied)", restrictedId, "HasEditAccess=false");
}

// ------------------------------------------------------------------ Part 3

const samples = Number.parseInt(flag("samples") ?? "0", 10);
if (Number.isInteger(samples) && samples > 0) {
  console.log(`\n== Part 3 · latency, ${samples} samples per path\n`);
  const nearestRank = (sorted: readonly number[], p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
  const measure = async (label: string, run: () => Promise<number>): Promise<void> => {
    const values: number[] = [];
    for (let i = 0; i < samples; i += 1) values.push(await run());
    values.sort((a, b) => a - b);
    console.log(
      `${label}\n      n=${values.length} min=${values[0]} P50=${nearestRank(values, 50)} P95=${nearestRank(values, 95)} max=${values.at(-1)} ms`,
    );
  };
  await measure("verifyAccess (admin, allowed)", async () =>
    (await verifyAccess(base, { access, log: () => {} }, { timeoutMs })).latencyMs,
  );
  if (row !== undefined) {
    await measure("retrieveWithContext, 1 chunk (access + live read)", async () => (await serve(userId, [row])).latencyMs);
  }
  if (samples < 20) console.log("\n(fewer than 20 samples: P95 is the max, not a statistic)");
}

if (httpTrace.length > 0) {
  console.log("\nhttp errors:");
  for (const line of new Set(httpTrace)) console.log(line);
}
console.log(`\n${checks - failures}/${checks} live checks matched`);
process.exit(failures === 0 ? 0 : 1);
