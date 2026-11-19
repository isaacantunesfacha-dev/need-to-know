/**
 * Local embedder over Ollama's /api/embed. Loopback only: record text never
 * leaves the machine.
 *
 * The model is pinned by digest. `modelId` carries the first 12 hex chars of
 * the digest Ollama reports, so a silently re-pulled model gets a new id and
 * the contract rejects every row embedded with the old one
 * (`embedding_model_rejected`) until the index is rebuilt on purpose.
 */
import type { Embedder } from "../ingest/ingestRecord.ts";
import { isRecord } from "../retrieval/validate.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;
const DIGEST = /^(?:sha256:)?([a-f0-9]{64})$/;

export interface OllamaEmbedderConfig {
  readonly model: string;
  readonly baseUrl?: string;
  /** If set, startup fails unless Ollama reports exactly this digest. */
  readonly expectedDigest?: string;
  /** Task prefixes some models need (nomic-embed-text: "search_document: " / "search_query: "). */
  readonly documentPrefix?: string;
  readonly queryPrefix?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface OllamaEmbedders {
  /** For ingestion. */
  readonly documents: Embedder;
  /** For the query side of search. Same modelId, so rows and queries stay comparable. */
  readonly queries: Embedder;
  readonly digest: string;
}

export async function createOllamaEmbedders(config: OllamaEmbedderConfig, signal: AbortSignal): Promise<OllamaEmbedders> {
  const base = new URL(config.baseUrl ?? "http://127.0.0.1:11434");
  if (base.protocol !== "http:" || !LOOPBACK.has(base.hostname)) throw new Error("the Ollama embedder only talks to a loopback address");
  if (!MODEL.test(config.model)) throw new Error("invalid model name");
  const doFetch = config.fetchImpl ?? fetch;
  const name = config.model.includes(":") ? config.model : `${config.model}:latest`;

  const tags = await doFetch(new URL("/api/tags", base.origin), { redirect: "error", signal });
  if (!tags.ok) throw new Error(`ollama answered ${tags.status}`);
  const body: unknown = await tags.json();
  const models = isRecord(body) && Array.isArray(body["models"]) ? body["models"] : [];
  const matches = models.filter((m) => isRecord(m) && m["name"] === name);
  const digestRaw = matches.length === 1 && isRecord(matches[0]) ? matches[0]["digest"] : undefined;
  const digest = typeof digestRaw === "string" ? DIGEST.exec(digestRaw)?.[1] : undefined;
  if (digest === undefined) throw new Error("model not installed or digest unreadable");
  if (config.expectedDigest !== undefined && DIGEST.exec(config.expectedDigest)?.[1] !== digest) {
    throw new Error("model digest does not match the pinned digest");
  }
  const modelId = `ollama:${name}:${digest.slice(0, 12)}`;

  async function embedRaw(text: string, s: AbortSignal): Promise<number[]> {
    const response = await doFetch(new URL("/api/embed", base.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: s,
      body: JSON.stringify({ model: name, input: text, truncate: false }),
    });
    if (!response.ok) throw new Error(`ollama answered ${response.status}`);
    const json: unknown = await response.json();
    const vectors = isRecord(json) && Array.isArray(json["embeddings"]) ? json["embeddings"] : undefined;
    const first: unknown = vectors?.length === 1 ? vectors[0] : undefined;
    if (!Array.isArray(first) || !first.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error("unexpected ollama embed response");
    }
    return first as number[];
  }

  const dimensions = (await embedRaw("dimension probe", signal)).length;
  const view = (prefix: string): Embedder => ({
    modelId,
    dimensions,
    embed: (text, s) => embedRaw(`${prefix}${text}`, s),
  });
  return { documents: view(config.documentPrefix ?? ""), queries: view(config.queryPrefix ?? ""), digest };
}
