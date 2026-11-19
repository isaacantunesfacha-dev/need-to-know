/**
 * Wires the local backend: reference CRM + vector store + embedder, behind
 * the same ports the Salesforce backend fills. Used by the CLI, the MCP
 * server and the approval channel.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { IndexPolicy } from "../contract/vectorRecord.ts";
import type { Embedder } from "../ingest/ingestRecord.ts";
import { createHashEmbedder } from "./hashEmbedder.ts";
import { type LocalCrm, openLocalCrm } from "./localCrm/db.ts";
import { localAccessPort, localEditAccess, localSourcePort, localTaskWriter } from "./localCrm/ports.ts";
import { SEED_ALLOWLIST, SEED_CHUNK_PROFILES } from "./localCrm/seed.ts";
import { createOllamaEmbedders } from "./ollamaEmbedder.ts";
import { openVectorStore, type VectorStore } from "./sqliteVectorStore.ts";

export type EmbedderKind = "ollama" | "hash";

export interface LocalBackendOptions {
  readonly dir: string;
  readonly embedder: EmbedderKind;
  readonly ollamaModel?: string;
  /** Pin: refuse to start if Ollama reports another digest. */
  readonly ollamaDigest?: string;
}

export interface LocalBackend {
  readonly crm: LocalCrm;
  readonly store: VectorStore;
  /** Ingestion side. The store holds the query side. */
  readonly documents: Embedder;
  readonly policy: IndexPolicy;
  readonly access: ReturnType<typeof localAccessPort>;
  readonly source: ReturnType<typeof localSourcePort>;
  readonly edit: ReturnType<typeof localEditAccess>;
  readonly writer: ReturnType<typeof localTaskWriter>;
  /** What is simulated in this run, so every output can say it. */
  readonly simulated: readonly string[];
  close(): void;
}

export const crmPath = (dir: string): string => resolve(dir, "crm.db");

export async function openLocalBackend(options: LocalBackendOptions): Promise<LocalBackend> {
  const path = crmPath(options.dir);
  if (!existsSync(path)) throw new Error(`no local CRM at ${path}: run "pnpm local seed" first`);
  mkdirSync(options.dir, { recursive: true });
  const crm = openLocalCrm(path);

  let documents: Embedder;
  let queries: Embedder;
  if (options.embedder === "ollama") {
    const model = options.ollamaModel ?? "nomic-embed-text";
    const pair = await createOllamaEmbedders(
      {
        model,
        ...(options.ollamaDigest === undefined ? {} : { expectedDigest: options.ollamaDigest }),
        ...(model.startsWith("nomic-embed-text") ? { documentPrefix: "search_document: ", queryPrefix: "search_query: " } : {}),
      },
      AbortSignal.timeout(30_000),
    );
    documents = pair.documents;
    queries = pair.queries;
  } else {
    documents = createHashEmbedder();
    queries = documents;
  }

  const store = openVectorStore(resolve(options.dir, "vectors.db"), queries);
  const policy: IndexPolicy = { tenantId: crm.tenantId, acceptedEmbeddingModels: [documents.modelId], fieldAllowlist: SEED_ALLOWLIST, chunkProfiles: SEED_CHUNK_PROFILES };
  return {
    crm,
    store,
    documents,
    policy,
    access: localAccessPort(crm),
    source: localSourcePort(crm),
    edit: localEditAccess(crm),
    writer: localTaskWriter(crm),
    simulated: ["CRM (local reference model)", ...(options.embedder === "hash" ? ["embedder (hashed bag of words)"] : [])],
    close() {
      store.close();
      crm.close();
    },
  };
}
