/**
 * Reindex from the CRM outbox (`crm_changes`). For every changed record:
 * drop its chunks first, then re-ingest. The order is the security choice:
 * between the change and a successful re-ingest the record is absent from
 * the index, never served with old text (retrieval would deny the stale
 * hash anyway; this keeps it out of ranking too).
 *
 * A definite outcome (indexed, or rejected by the contract/sanitizer/hygiene)
 * consumes the change. A transient one (timeout, source, embedding or write
 * error) leaves it pending for the next run.
 */
import type { IndexPolicy } from "../../contract/vectorRecord.ts";
import { type Embedder, type IngestDetail, ingestRecord } from "../../ingest/ingestRecord.ts";
import type { VectorStore } from "../sqliteVectorStore.ts";
import type { LocalCrm } from "./db.ts";
import { localHygieneLedger, localIngestSource } from "./ports.ts";

const TRANSIENT: ReadonlySet<IngestDetail> = new Set(["timeout", "source_error", "hygiene_error", "embedding_error", "write_error"]);

export interface ReindexLine {
  readonly recordId: string;
  readonly objectName: string;
  readonly detail: IngestDetail;
  readonly consumed: boolean;
}

/** Queues every record for a full rebuild (first run, or a new embedding model). */
export function queueFullReindex(crm: LocalCrm): number {
  const now = new Date().toISOString();
  const result = crm.db.prepare("INSERT INTO crm_changes (record_id, object, changed_at) SELECT id, object, ? FROM records").run(now);
  return Number(result.changes);
}

export async function reindexChanges(
  crm: LocalCrm,
  store: VectorStore,
  embedder: Embedder,
  policy: IndexPolicy,
): Promise<ReindexLine[]> {
  const pending = crm.db
    .prepare("SELECT record_id, object, MAX(seq) AS last FROM crm_changes WHERE consumed = 0 GROUP BY record_id, object ORDER BY last")
    .all();
  const lines: ReindexLine[] = [];
  for (const change of pending) {
    const recordId = String(change["record_id"]);
    const objectName = String(change["object"]);
    store.removeRecord(recordId);
    const outcome = await ingestRecord(
      { tenantId: crm.tenantId, objectName, recordId },
      { source: localIngestSource(crm), hygiene: localHygieneLedger(crm), embedder, writer: store, policy },
    );
    const consumed = !TRANSIENT.has(outcome.detail);
    if (consumed) {
      crm.db.prepare("UPDATE crm_changes SET consumed = 1 WHERE record_id = ? AND seq <= ?").run(recordId, Number(change["last"]));
    }
    lines.push({ recordId, objectName, detail: outcome.detail, consumed });
  }
  return lines;
}
