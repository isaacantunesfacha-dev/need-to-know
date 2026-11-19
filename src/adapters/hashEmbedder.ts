/**
 * Simulated embedder: bag of words hashed into buckets. Deterministic and
 * offline, for CI and for running the demo without Ollama. Its modelId says
 * "simulated" so no row it produced can pass for a real embedding.
 */
import { createHash } from "node:crypto";
import type { Embedder } from "../ingest/ingestRecord.ts";

export function createHashEmbedder(dimensions = 256, modelId = `simulated-bow-${dimensions}-v1`): Embedder {
  return {
    modelId,
    dimensions,
    embed: async (text) => {
      const v: number[] = Array.from({ length: dimensions }, () => 0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
        const bucket = createHash("sha256").update(word).digest().readUInt32BE(0) % dimensions;
        v[bucket] = (v[bucket] ?? 0) + 1;
      }
      // A text with no usable word still gets a valid, non-zero vector.
      if (!v.some((x) => x > 0)) v[0] = 1;
      return v;
    },
  };
}
