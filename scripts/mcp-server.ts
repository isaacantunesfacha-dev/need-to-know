/**
 * Gina RAG MCP server (stdio). stdout carries JSON-RPC only; every log line
 * goes to stderr.
 *
 * Environment:
 *   GINA_BACKEND           local (default) | salesforce.
 *   GINA_LOCAL_DIR         local backend data dir, default .gina/local (create it with `pnpm local seed`).
 *   GINA_EMBEDDER          local backend: ollama (default, nomic-embed-text) | hash (simulated, offline).
 *   GINA_USER_ID           required. The human this server acts for (18-char user id).
 *   GINA_SERVICE_USER_ID   optional. The integration user; it can never approve.
 *   GINA_INDEX_RECORDS     comma list of Object:Id to ingest at startup, e.g. "Account:001XXXXXXXXXXXXXXX".
 *   GINA_HYGIENE_FILE      default .gina/hygiene.json: { "<recordId>": { status, auditedBy, auditedAt } }, written by people.
 *   GINA_APPROVALS_FILE    default .gina/local/approvals.json (local) or .gina/approvals.json (salesforce); shared with `pnpm approvals`.
 *   SALESFORCE_ORG_ALIAS   default minha-org-agentforce (sf CLI transport).
 *   GINA_CLASSIFIER_MODEL  default qwen2.5:7b (Ollama, loopback only).
 *
 * Salesforce backend: the embedder and the vector index are simulated (the
 * retriever returns the ingested rows). Local backend: the CRM is a local
 * reference model; store and embedder are real. The startup line says which.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAccessPortFromQuery } from "../src/adapters/salesforceAccessPort.ts";
import { createIngestSourceFromQuery } from "../src/adapters/salesforceIngestSource.ts";
import { createSourcePortFromQuery } from "../src/adapters/salesforceSourcePort.ts";
import { createSfCliRunner, SF_CLI_TIMEOUT_MS } from "../src/adapters/sfCliQuery.ts";
import { openLocalBackend } from "../src/adapters/localBackend.ts";
import { createOllamaClassifier } from "../src/adapters/ollamaClassifier.ts";
import { createApprovalHarness } from "../src/approval/harness.ts";
import { createFileApprovalStore } from "../src/approval/fileStore.ts";
import type { IndexPolicy, VectorRecordV1 } from "../src/contract/vectorRecord.ts";
import { ingestRecord } from "../src/ingest/ingestRecord.ts";
import { createGateway } from "../src/mcp/gateway.ts";
import { serveStdio } from "../src/mcp/stdio.ts";
import { isApiName, isRecord, isSalesforceId } from "../src/retrieval/validate.ts";

const log = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
};
const fatal = (message: string): never => {
  log({ level: "fatal", message });
  process.exit(2);
};

const userId = process.env["GINA_USER_ID"] ?? "";
if (!isSalesforceId(userId)) fatal("GINA_USER_ID must be an 18-char user id");
const serviceUserId = process.env["GINA_SERVICE_USER_ID"] ?? "000000000000000AAA";
const root = resolve(import.meta.dirname, "..");
const hygienePath = resolve(root, process.env["GINA_HYGIENE_FILE"] ?? ".gina/hygiene.json");
const backendKind = process.env["GINA_BACKEND"] === "salesforce" ? "salesforce" : "local";
// Each backend keeps its own approvals: a local request must never be executable against the org.
const approvalsPath = resolve(
  root,
  process.env["GINA_APPROVALS_FILE"] ?? (backendKind === "local" ? ".gina/local/approvals.json" : ".gina/approvals.json"),
);
const { retriever, access, source, policy, simulated, stepMs } =
  backendKind === "local" ? await localSetup() : await salesforceSetup();

/** Local reference CRM + SQLite vector store + Ollama embedder. No org needed. */
async function localSetup() {
  const backend = await openLocalBackend({
    dir: resolve(root, process.env["GINA_LOCAL_DIR"] ?? ".gina/local"),
    embedder: process.env["GINA_EMBEDDER"] === "hash" ? "hash" : "ollama",
  });
  return {
    retriever: backend.store,
    access: backend.access,
    source: backend.source,
    policy: backend.policy,
    simulated: backend.simulated,
    stepMs: 5_000,
  };
}

async function salesforceSetup() {
  const soql = createSfCliRunner(process.env["SALESFORCE_ORG_ALIAS"] ?? "minha-org-agentforce");
  const access = createAccessPortFromQuery(soql);
  const source = createSourcePortFromQuery(soql);
  const orgRows = await soql("SELECT Id FROM Organization", AbortSignal.timeout(SF_CLI_TIMEOUT_MS));
  const tenantId = String(orgRows[0]?.["Id"] ?? "");
  const MODEL = "simulated-sha256-v0";
  const policy: IndexPolicy = {
    tenantId,
    acceptedEmbeddingModels: [MODEL],
    fieldAllowlist: { Account: ["Name", "Industry"], Gina_Private_Note__c: ["Name"] },
  };

  const hygiene: Record<string, unknown> = existsSync(hygienePath) ? (JSON.parse(readFileSync(hygienePath, "utf8")) as Record<string, unknown>) : {};
  const index: VectorRecordV1[] = [];
  for (const spec of (process.env["GINA_INDEX_RECORDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [objectName, recordId] = spec.split(":");
    if (!isApiName(objectName) || !isSalesforceId(recordId)) {
      log({ level: "warn", message: "skipping malformed GINA_INDEX_RECORDS entry" });
      continue;
    }
    const outcome = await ingestRecord(
      { tenantId, objectName, recordId },
      {
        source: createIngestSourceFromQuery(soql),
        hygiene: { approvalFor: async (_t, _o, id) => (isRecord(hygiene) ? hygiene[id] : undefined) },
        embedder: {
          modelId: MODEL,
          dimensions: 8,
          embed: async (text) => [...createHash("sha256").update(text).digest().subarray(0, 8)].map((b) => b / 255),
        },
        writer: { upsert: async (entry) => void index.push(entry.record) },
        policy,
      },
      { stepTimeoutMs: SF_CLI_TIMEOUT_MS },
    );
    log({ level: "info", event: "ingest", objectName, recordId, decision: outcome.decision, detail: outcome.detail });
  }
  return {
    retriever: { search: async () => index }, // simulated vector index
    access,
    source,
    policy,
    simulated: ["embedder", "vector index"],
    stepMs: SF_CLI_TIMEOUT_MS,
  };
}

const store = createFileApprovalStore(approvalsPath);
const gateway = createGateway({
  userId,
  retriever,
  access,
  source,
  policy,
  classifier: createOllamaClassifier({ model: process.env["GINA_CLASSIFIER_MODEL"] ?? "qwen2.5:7b" }),
  harness: createApprovalHarness({ store, log: (e) => log({ level: "info", approval: e }), serviceUserId }),
  getApproval: (id) => store.get(id),
  audit: (entry) => log({ level: "info", audit: entry }),
  timeouts: { accessMs: stepMs, sourceMs: stepMs, retrievalMs: stepMs, classifierMs: 20_000 },
});

log({ level: "info", message: "gina-rag MCP server ready", backend: backendKind, userId, simulated });
serveStdio(gateway, { name: "gina-rag", version: "0.1.0" }, process.stdin, process.stdout);
