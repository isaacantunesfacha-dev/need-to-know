import assert from "node:assert/strict";
import { test } from "node:test";
import { updateRecord } from "../src/adapters/localCrm/db.ts";
import {
  localAccessPort,
  localEditAccess,
  localHygieneLedger,
  localIngestSource,
  localSourcePort,
  localTaskWriter,
} from "../src/adapters/localCrm/ports.ts";
import { SEED_ALLOWLIST, SEED_RECORDS, SEED_TENANT, SEED_USERS, seedLocalCrm } from "../src/adapters/localCrm/seed.ts";
import { chunkHash, type IndexPolicy, type VectorRecordV1 } from "../src/contract/vectorRecord.ts";
import { type IndexEntry, ingestRecord } from "../src/ingest/ingestRecord.ts";
import { retrieveWithContext } from "../src/retrieval/retrieveWithContext.ts";
import type { AuditEntry } from "../src/retrieval/types.ts";
import { verifyAccess } from "../src/retrieval/verifyAccess.ts";

// Boundary: local reference CRM. Every expectation below is the one
// scripts/live-check.ts measured on the real org; the local backend must
// reach the same decision/reason/detail. Zero network.

const crm = seedLocalCrm(":memory:");
const access = localAccessPort(crm);
const deps = { access, log: () => {} };
const { admin, restricted } = SEED_USERS;
const account = SEED_RECORDS.edge;
const base = { userId: admin, objectName: "Account", recordId: account, fields: ["Name", "AnnualRevenue"] };

async function verdict(input: Record<string, unknown>, timeoutMs = 1_000): Promise<string> {
  const r = await verifyAccess(input, deps, { timeoutMs });
  return `${r.decision}/${r.reason}/${r.detail}`;
}

// ------------------------------------------------- Part 1 parity (verifyAccess)

const part1: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["admin reads Account.Name + AnnualRevenue", base, "allow/allowed/ok"],
  ["field that does not exist", { ...base, fields: ["Name", "GinaNoSuchField__c"] }, "deny/fls_unreadable/field_unreadable"],
  ["unknown user id", { ...base, userId: "005000000000000AAA" }, "deny/fls_unreadable/access_check_error"],
  ["record id from another object", { ...base, recordId: SEED_RECORDS.opportunity }, "deny/fls_denied/object_mismatch"],
  ["restricted user reads Account.Name + Industry", { ...base, userId: restricted, fields: ["Name", "Industry"] }, "allow/allowed/ok"],
  ["restricted user asks for AnnualRevenue (hidden by FLS)", { ...base, userId: restricted }, "deny/fls_denied/field_denied"],
  [
    "restricted user asks for an Opportunity (no object read)",
    { userId: restricted, objectName: "Opportunity", recordId: SEED_RECORDS.opportunity, fields: ["Name"] },
    "deny/fls_denied/entity_denied",
  ],
  [
    "restricted user reads a note they own",
    { userId: restricted, objectName: "Gina_Private_Note__c", recordId: SEED_RECORDS.noteRestricted, fields: ["Name"] },
    "allow/allowed/ok",
  ],
  [
    "restricted user asks for a note owned by someone else (hidden by sharing)",
    { userId: restricted, objectName: "Gina_Private_Note__c", recordId: SEED_RECORDS.noteAdmin, fields: ["Name"] },
    "deny/fls_denied/record_denied",
  ],
  [
    "admin reads the same hidden note",
    { userId: admin, objectName: "Gina_Private_Note__c", recordId: SEED_RECORDS.noteAdmin, fields: ["Name"] },
    "allow/allowed/ok",
  ],
  [
    "object the CRM does not define",
    { ...base, objectName: "NoSuchObject__c", recordId: "a01LOCAL0000001AAA", fields: ["Name"] },
    "deny/fls_unreadable/entity_unreadable",
  ],
  ["record that does not exist", { ...base, recordId: "001LOCAL0000999AAA", fields: ["Name"] }, "deny/fls_unreadable/record_unreadable"],
];

/** Cases live-check never ran on the org: the local backend's own fail-closed answers. */
const LOCAL_ONLY = new Set(["object the CRM does not define", "record that does not exist"]);
for (const [name, input, expected] of part1) {
  test(`${LOCAL_ONLY.has(name) ? "local-only" : "parity"} · ${name}`, async () => assert.equal(await verdict(input), expected));
}

test("parity · aborted deadline is a timeout, never a grant", async () => {
  const slow = {
    ...access,
    entityReadable: (...args: Parameters<typeof access.entityReadable>) =>
      new Promise<unknown>((resolve) => setTimeout(() => resolve(access.entityReadable(...args)), 50)),
  };
  const r = await verifyAccess(base, { access: slow, log: () => {} }, { timeoutMs: 1 });
  assert.equal(`${r.decision}/${r.reason}/${r.detail}`, "deny/timeout/timeout");
});

// ------------------------------------------ Part 2 parity (ingest -> retrieve)

const MODEL = "local-test-embedder-v1";
const policy: IndexPolicy = { tenantId: SEED_TENANT, acceptedEmbeddingModels: [MODEL], fieldAllowlist: SEED_ALLOWLIST };
const embedder = { modelId: MODEL, dimensions: 2, embed: async () => [1, 0] };

async function ingest(objectName: string, recordId: string, index: IndexEntry[]) {
  return ingestRecord(
    { tenantId: SEED_TENANT, objectName, recordId },
    {
      source: localIngestSource(crm),
      hygiene: localHygieneLedger(crm),
      embedder,
      writer: { upsert: async (entry) => void index.push(entry) },
      policy,
    },
  );
}

async function serve(userId: string, rows: readonly unknown[]): Promise<{ audit: AuditEntry[]; context: string }> {
  const audit: AuditEntry[] = [];
  const result = await retrieveWithContext(
    { userId, query: "status da conta", topK: 5 },
    { retriever: { search: async () => rows }, access, source: localSourcePort(crm), policy, log: (e) => audit.push(e) },
  );
  return { audit, context: JSON.stringify(result) };
}
const first = (audit: readonly AuditEntry[]): string => {
  const e = audit[0];
  return e === undefined ? "no audit" : `${e.decision}/${e.reason}/${e.detail}`;
};

test("parity · ingest Account (Name, Industry, Description) from the local CRM", async () => {
  const index: IndexEntry[] = [];
  const outcome = await ingest("Account", account, index);
  assert.equal(outcome.detail, "indexed");
  assert.equal(index.length, 1);
});

test("parity · admin retrieves the ingested row; stale and undeclared rows are denied, AnnualRevenue never leaks", async () => {
  const index: IndexEntry[] = [];
  await ingest("Account", SEED_RECORDS.burlington, index);
  const row = index[0]?.record as VectorRecordV1;

  assert.equal(first((await serve(admin, [row])).audit), "allow/allowed/ok");

  const tampered = { ...row, chunkHash: chunkHash("Account", row.recordId, row.fields, { Name: "x", Industry: "y", Description: "z" }) };
  assert.equal(first((await serve(admin, [tampered])).audit), "deny/fls_denied/stale_chunk");

  const lying = await serve(admin, [{ ...row, fields: ["Name", "AnnualRevenue"] }]);
  assert.equal(first(lying.audit), "deny/fls_denied/undeclared_field");
  assert.ok(!lying.context.includes("350000000"));
});

test("local-only · restricted user is denied Description (FLS) even though the row is in the index", async () => {
  const index: IndexEntry[] = [];
  await ingest("Account", SEED_RECORDS.pyramid, index);
  const served = await serve(restricted, [index[0]?.record]);
  assert.equal(first(served.audit), "deny/fls_denied/field_denied");
  assert.ok(!served.context.includes("spreadsheets"));
});

test("parity · live read of a field the CRM does not define throws", async () => {
  await assert.rejects(localSourcePort(crm).fetchFields("Account", account, ["GinaNoSuchField__c"], AbortSignal.timeout(500)));
});

test("local-only · poisoned Description is quarantined at ingestion, never indexed", async () => {
  const index: IndexEntry[] = [];
  const outcome = await ingest("Account", SEED_RECORDS.poisoned, index);
  assert.equal(outcome.decision, "rejected");
  assert.equal(outcome.detail, "embedded_instruction");
  assert.equal(index.length, 0);
});

test("local-only · record without a hygiene audit is never read", async () => {
  const index: IndexEntry[] = [];
  const outcome = await ingest("Gina_Private_Note__c", SEED_RECORDS.noteAdmin, index);
  assert.equal(outcome.detail, "hygiene_unapproved");
});

test("local-only · CRM edit after ingestion makes the old row stale and writes the outbox", async () => {
  const index: IndexEntry[] = [];
  await ingest("Account", SEED_RECORDS.grandHotels, index);
  updateRecord(crm, SEED_RECORDS.grandHotels, { Industry: "Leisure" });
  assert.equal(first((await serve(admin, [index[0]?.record])).audit), "deny/fls_denied/stale_chunk");
  const pending = crm.db.prepare("SELECT record_id FROM crm_changes WHERE consumed = 0").all();
  assert.deepEqual(pending.map((r) => r["record_id"]), [SEED_RECORDS.grandHotels]);
});

// --------------------------------------- Part 2b parity (approver edit access)

test("parity · admin can edit the Account", async () => {
  assert.equal(await localEditAccess(crm).recordEditable(admin, account, AbortSignal.timeout(500)), true);
});

test("parity · restricted user cannot edit the Account", async () => {
  assert.equal(await localEditAccess(crm).recordEditable(restricted, account, AbortSignal.timeout(500)), false);
});

test("local-only · edit check for an unknown user throws (fails closed)", async () => {
  await assert.rejects(localEditAccess(crm).recordEditable("005000000000000AAA", account, AbortSignal.timeout(500)));
});

test("local-only · task writer is idempotent by request tag and refuses ambiguity", async () => {
  const writer = localTaskWriter(crm);
  const signal = AbortSignal.timeout(500);
  assert.equal(await writer.findOpenTask(account, "#abc123", signal), undefined);
  const draft = { WhatId: account, OwnerId: admin, Subject: "[Gina] follow up #abc123", Description: "", Status: "Not Started", Priority: "Normal" } as const;
  const id = await writer.createTask(draft, signal);
  assert.equal(await writer.findOpenTask(account, "#abc123", signal), id);
  await writer.createTask(draft, signal);
  await assert.rejects(writer.findOpenTask(account, "#abc123", signal));
});

test("local-only · hostile ids never reach SQL", async () => {
  const hostile = "001' OR '1'='1--xxx";
  assert.equal(await verdict({ ...base, recordId: hostile }), "deny/malformed_request/malformed_request");
  await assert.rejects(localSourcePort(crm).fetchFields("Account", hostile, ["Name"], AbortSignal.timeout(500)));
});
