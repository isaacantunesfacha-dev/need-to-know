import { randomUUID } from "node:crypto";
import { CLASSIFIER_SYSTEM_PROMPT, classifierUserMessage, type InjectionClassifier } from "../trust/classifier.ts";
import { isRecord } from "../retrieval/validate.ts";

export interface OllamaConfig {
  readonly model: string;
  /** Loopback only: the classifier must stay on this machine. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MODEL = /^[A-Za-z0-9._:/-]{1,128}$/;

/**
 * Local model classifier over the Ollama chat API. Deterministic settings
 * (temperature 0, fixed seed) and a JSON schema for the answer. Returns the
 * parsed JSON object, or throws; `parseVerdict` decides what counts as safe.
 */
export function createOllamaClassifier(config: OllamaConfig): InjectionClassifier {
  const base = new URL(config.baseUrl ?? "http://127.0.0.1:11434");
  if (base.protocol !== "http:" || !LOOPBACK.has(base.hostname)) {
    throw new Error("the Ollama classifier only talks to a loopback address");
  }
  if (!MODEL.test(config.model)) throw new Error("invalid model name");
  const doFetch = config.fetchImpl ?? fetch;

  return {
    id: `ollama:${config.model}`,
    async classify(text, signal) {
      const response = await doFetch(new URL("/api/chat", base.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "error",
        signal,
        body: JSON.stringify({
          model: config.model,
          stream: false,
          format: {
            type: "object",
            properties: { injection: { type: "boolean" } },
            required: ["injection"],
          },
          options: { temperature: 0, seed: 7, num_predict: 16 },
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
            { role: "user", content: classifierUserMessage(text, randomUUID()) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`ollama answered ${response.status}`);
      const body: unknown = await response.json();
      const content = isRecord(body) && isRecord(body["message"]) ? body["message"]["content"] : undefined;
      if (typeof content !== "string") throw new Error("unexpected ollama response shape");
      return JSON.parse(content) as unknown;
    },
  };
}
