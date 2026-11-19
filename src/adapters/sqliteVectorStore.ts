/**
 * Vector store on node:sqlite (Module 1, contract v1).
 *
 * Stores the contract row and the vector. Never text: the row is projected
 * onto the contract's own keys before it is written, so a `text` (or any
 * other) key an upstream bug adds is dropped, not persisted.
 *
 * Search is exact cosine over every row of the query model (brute force).
 * Cost: O(n·d) per query; fine for tens of thousands of chunks, the point
 * where an ANN index (sqlite-vec, pgvector) becomes worth its dependency.
 * Rows embedded with another model are never compared with the query.
 */
import { DatabaseSync } from "node:sqlite";
import type { VectorRecordV1 } from "../contract/vectorRecord.ts";
import type { Embedder, IndexEntry, IndexWriter } from "../ingest/ingestRecord.ts";
import { MAX_CANDIDATES, MAX_QUERY_CHARS } from "../retrieval/retrieveWithContext.ts";
import type { Retriever } from "../retrieval/types.ts";
import { isChunkId, isRecord } from "../retrieval/validate.ts";

const CONTRACT_KEYS = [
  "schemaVersion",
  "tenantId",
  "chunkId",
  "recordId",
  "objectName",
  "fields",
  "chunkHash",
  "embeddingModelId",
  "sourceModifiedAt",
  "ingestedAt",
  "hygiene",
] as const satisfies readonly (keyof VectorRecordV1)[];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
  chunk_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dims INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_model ON vectors (model_id);
CREATE INDEX IF NOT EXISTS vectors_record ON vectors (record_id);
`;

export interface VectorStore extends IndexWriter, Retriever {
  count(): number;
  /** Removes every chunk of a record (used before re-ingesting it). */
  removeRecord(recordId: string): void;
  close(): void;
}

function project(record: VectorRecordV1): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTRACT_KEYS) out[key] = record[key];
  return out;
}

function toBlob(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

function fromBlob(blob: unknown, dims: number): Float32Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== dims * 4) return null;
  // Copy: the blob's buffer may not be 4-byte aligned.
  return new Float32Array(blob.slice().buffer);
}

function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += (v[i] ?? 0) * (v[i] ?? 0);
  return Math.sqrt(s);
}

export function openVectorStore(path: string, embedder: Embedder): VectorStore {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const upsertStmt = db.prepare(
    "INSERT OR REPLACE INTO vectors (chunk_id, record_id, model_id, dims, record_json, vector) VALUES (?, ?, ?, ?, ?, ?)",
  );

  return {
    async upsert(entry: IndexEntry, signal) {
      if (signal.aborted) throw new Error("aborted");
      const { record, vector } = entry;
      if (!isChunkId(record.chunkId)) throw new Error("invalid chunk id");
      if (record.embeddingModelId !== embedder.modelId) throw new Error("row embedded with another model");
      if (vector.length !== embedder.dimensions || !vector.every(Number.isFinite)) throw new Error("invalid vector");
      if (norm(vector) === 0) throw new Error("zero vector");
      upsertStmt.run(record.chunkId, record.recordId, record.embeddingModelId, vector.length, JSON.stringify(project(record)), toBlob(vector));
      return true;
    },

    async search(query, topK, signal) {
      if (typeof query !== "string" || query.length === 0 || query.length > MAX_QUERY_CHARS) throw new Error("invalid query");
      const k = Math.min(Math.max(1, Math.trunc(topK)), MAX_CANDIDATES);
      const raw = await embedder.embed(query, signal);
      if (!Array.isArray(raw) || raw.length !== embedder.dimensions || !raw.every((x) => typeof x === "number" && Number.isFinite(x))) {
        throw new Error("query embedding failed");
      }
      const q = raw as number[];
      const qn = norm(q);
      if (qn === 0) throw new Error("zero query vector");
      if (signal.aborted) throw new Error("aborted");

      const scored: { score: number; row: unknown }[] = [];
      for (const row of db.prepare("SELECT dims, record_json, vector FROM vectors WHERE model_id = ?").iterate(embedder.modelId)) {
        const dims = Number(row["dims"]);
        const v = dims === embedder.dimensions ? fromBlob(row["vector"], dims) : null;
        // A corrupt row is skipped, never guessed at.
        if (v === null) continue;
        let dot = 0;
        for (let i = 0; i < dims; i += 1) dot += (q[i] ?? 0) * (v[i] ?? 0);
        const parsed: unknown = JSON.parse(String(row["record_json"]));
        if (isRecord(parsed)) scored.push({ score: dot / (qn * norm(v)), row: parsed });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k).map((s) => s.row);
    },

    count() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM vectors").get();
      return Number(row?.["n"] ?? 0);
    },

    removeRecord(recordId) {
      db.prepare("DELETE FROM vectors WHERE record_id = ?").run(recordId);
    },

    close() {
      db.close();
    },
  };
}
