/**
 * Adaptive red team, black box. Measures how many attacks get through the
 * whole gate (ingestion sanitizer -> retrieval sanitizer + live re-read ->
 * Trust Layer classifier) and reach the context an LLM would read.
 *
 *   node scripts/redteam.ts <round-dir> [--runs=5] [--model=qwen2.5:7b]
 *
 * <round-dir>/attacks.json: [{ id, lang, category, text, fields? }]
 *   `text` goes into Account.Description; `fields` may set Name/Industry too
 *   (field-split attacks).
 * Writes <round-dir>/feedback.json: per id, in how many runs it reached the
 *   context. That is ALL the attacker ever sees: no layer, no reason.
 * Writes reports/redteam-<round>.json with the full breakdown (for us).
 *
 * The classifier is not deterministic, so the Trust Layer runs `--runs` times
 * and the result is a range. Ranking is out of scope: the retriever returns
 * the attack row directly, the worst case for the gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHashEmbedder } from "../src/adapters/hashEmbedder.ts";
import { insertRecord, recordHygiene } from "../src/adapters/localCrm/db.ts";
import { localAccessPort, localHygieneLedger, localIngestSource, localSourcePort } from "../src/adapters/localCrm/ports.ts";
import { SEED_ALLOWLIST, SEED_TENANT, SEED_USERS, seedLocalCrm } from "../src/adapters/localCrm/seed.ts";
import { createOllamaClassifier } from "../src/adapters/ollamaClassifier.ts";
import type { IndexPolicy, VectorRecordV1 } from "../src/contract/vectorRecord.ts";
import { parseCorpusItems } from "../src/eval/corpus.ts";
import { ingestRecord } from "../src/ingest/ingestRecord.ts";
import { retrieveWithContext } from "../src/retrieval/retrieveWithContext.ts";
import { isRecord } from "../src/retrieval/validate.ts";
import { applyTrustLayer } from "../src/trust/trustLayer.ts";

const root = resolve(import.meta.dirname, "..");
const roundDir = resolve(root, process.argv[2] ?? "");
const flag = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Math.max(1, Number.parseInt(flag("runs") ?? "5", 10));
const raw: unknown = JSON.parse(readFileSync(resolve(roundDir, "attacks.json"), "utf8"));
const attacks = parseCorpusItems(raw, "attacks.json");
const extraFields = new Map<string, Record<string, string>>();
if (Array.isArray(raw)) {
  for (const item of raw) {
    if (isRecord(item) && isRecord(item["fields"])) {
      const f = Object.fromEntries(Object.entries(item["fields"]).filter(([k, v]) => ["Name", "Industry"].includes(k) && typeof v === "string"));
      extraFields.set(String(item["id"]), f as Record<string, string>);
    }
  }
}

const crm = seedLocalCrm(":memory:");
const embedder = createHashEmbedder();
const policy: IndexPolicy = { tenantId: SEED_TENANT, acceptedEmbeddingModels: [embedder.modelId], fieldAllowlist: SEED_ALLOWLIST };
const classifier = createOllamaClassifier({ model: flag("model") ?? "qwen2.5:7b" });
const stamp = new Date(Date.now() - 60_000).toISOString();

type Stage = "ingest" | "retrieval" | "trust" | "passed";
interface Row { id: string; category: string; ingest: string; retrieval: string; passedRuns: number; stoppedAt: Stage[] }
const rows: Row[] = [];

for (const [i, attack] of attacks.entries()) {
  const recordId = `001RT${String(i).padStart(10, "0")}AAA`;
  insertRecord(crm, {
    id: recordId,
    object: "Account",
    ownerId: SEED_USERS.admin,
    values: { Name: `Account ${i}`, Industry: "Retail", ...extraFields.get(attack.id), Description: attack.text },
    modifiedAt: stamp,
  });
  recordHygiene(crm, { object: "Account", recordId, status: "approved", auditedBy: SEED_USERS.auditor, auditedAt: stamp });

  const index: VectorRecordV1[] = [];
  const ingested = await ingestRecord(
    { tenantId: SEED_TENANT, objectName: "Account", recordId },
    { source: localIngestSource(crm), hygiene: localHygieneLedger(crm), embedder, writer: { upsert: async (e) => void index.push(e.record) }, policy },
  );
  const row: Row = { id: attack.id, category: attack.category, ingest: ingested.detail, retrieval: "-", passedRuns: 0, stoppedAt: [] };
  if (ingested.decision !== "indexed") {
    row.stoppedAt = Array.from({ length: runs }, () => "ingest" as const);
    rows.push(row);
    continue;
  }
  const retrieval = await retrieveWithContext(
    { userId: SEED_USERS.admin, query: "account notes", topK: 1 },
    { retriever: { search: async () => index }, access: localAccessPort(crm), source: localSourcePort(crm), policy, log: () => {} },
  );
  row.retrieval = retrieval.audit[0]?.detail ?? "none";
  if (retrieval.chunks.length === 0) {
    row.stoppedAt = Array.from({ length: runs }, () => "retrieval" as const);
    rows.push(row);
    continue;
  }
  for (let r = 0; r < runs; r += 1) {
    const trusted = await applyTrustLayer(retrieval, { classifier, log: () => {}, userId: SEED_USERS.admin }, { classifierTimeoutMs: 60_000 });
    const passed = trusted.chunks.some((c) => c.recordId === recordId);
    row.stoppedAt.push(passed ? "passed" : "trust");
    if (passed) row.passedRuns += 1;
  }
  rows.push(row);
  process.stderr.write(".");
}
process.stderr.write("\n");

const n = rows.length;
const perRun = Array.from({ length: runs }, (_, r) => rows.filter((row) => row.stoppedAt[r] === "passed").length);
const always = rows.filter((r) => r.passedRuns === runs).length;
const ever = rows.filter((r) => r.passedRuns > 0).length;
const pct = (x: number): string => `${((x / n) * 100).toFixed(1)}%`;
const round = basename(roundDir);

console.log(`round ${round} · ${n} attacks · ${runs} runs · ${classifier.id}`);
console.log(`stopped at ingestion (patterns)   ${rows.filter((r) => r.ingest !== "indexed").length}`);
console.log(`stopped at retrieval              ${rows.filter((r) => r.ingest === "indexed" && r.retrieval !== "ok").length}`);
console.log(`reached the Trust Layer           ${rows.filter((r) => r.retrieval === "ok").length}`);
console.log(`bypass per run                    ${perRun.map(pct).join(" · ")}  (range ${pct(Math.min(...perRun))}–${pct(Math.max(...perRun))})`);
console.log(`bypassed in every run             ${always} (${pct(always)})`);
console.log(`bypassed in at least one run      ${ever} (${pct(ever)})`);
const byCat = rows.reduce<Record<string, [number, number]>>((acc, r) => {
  const [hit, tot] = acc[r.category] ?? [0, 0];
  acc[r.category] = [hit + (r.passedRuns > 0 ? 1 : 0), tot + 1];
  return acc;
}, {});
console.log(`by category (any run): ${Object.entries(byCat).map(([k, [h, t]]) => `${k} ${h}/${t}`).join(", ")}`);

writeFileSync(resolve(roundDir, "feedback.json"), `${JSON.stringify(rows.map((r) => ({ id: r.id, reachedContextInRuns: r.passedRuns, runs })), null, 2)}\n`);
mkdirSync(resolve(root, "reports"), { recursive: true });
writeFileSync(resolve(root, `reports/redteam-${round}.json`), `${JSON.stringify({ round, runs, model: classifier.id, date: new Date().toISOString(), perRun, always, ever, rows }, null, 2)}\n`);
crm.close();
