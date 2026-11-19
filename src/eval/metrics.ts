/** Module 4 metrics. Pure: scenarios and corpora arrive as data, I/O lives in scripts/eval.ts. */
import type { IndexPolicy } from "../contract/vectorRecord.ts";
import { retrieveWithContext } from "../retrieval/retrieveWithContext.ts";
import { sanitizeChunk } from "../retrieval/sanitize.ts";
import type { AccessPort, Detail, SourcePort } from "../retrieval/types.ts";
import type { CorpusItem } from "./corpus.ts";
import { FIXTURE_POLICY, FIXTURE_WORLD } from "./fixtureWorld.ts";
import { canRead } from "./oracle.ts";
import { materializeScenario, type Scenario } from "./scenarios.ts";
import { accessPortFromWorld, type Faults, sourcePortFromWorld, type World } from "./world.ts";

export const EVAL_TIMEOUT_MS = 50;
export const EVAL_NONCE = "eval-nonce-0001";

export interface CorpusPair {
  /** null = file not present. */
  readonly hostile: readonly CorpusItem[] | null;
  readonly benign: readonly CorpusItem[] | null;
}

export interface EvalInput {
  readonly scenarios: readonly Scenario[];
  readonly world?: World;
  readonly policy?: IndexPolicy;
  readonly seen: CorpusPair;
  readonly heldout: CorpusPair;
  readonly access?: (world: World) => AccessPort;
  readonly source?: (world: World, faults: Faults) => SourcePort;
  /** true = flagged as injection. Default: sanitizeChunk found something. */
  readonly detect?: (text: string) => boolean;
  readonly timeoutMs?: number;
}

export interface LeakItem {
  readonly scenarioId: string;
  readonly userId: string;
  readonly recordId: string;
}
export interface DetailMismatch {
  readonly scenarioId: string;
  readonly recordId: string;
  readonly expected: Detail | null;
  readonly actual: Detail | null;
}
export interface DetectorMiss {
  readonly id: string;
  readonly category: string;
}
export interface DetectorResult {
  /** null = hostile file missing: "not available". */
  readonly tpr: number | null;
  /** null = benign file missing: "not available". */
  readonly fpr: number | null;
  readonly hostileTotal: number;
  readonly benignTotal: number;
  readonly misses: readonly DetectorMiss[];
  readonly falsePositives: readonly DetectorMiss[];
}
export interface EvalReport {
  readonly scenarioCount: number;
  readonly leakage: { readonly count: number; readonly items: readonly LeakItem[] };
  readonly detailAccuracy: {
    readonly matched: number;
    readonly total: number;
    readonly value: number | null;
    readonly mismatches: readonly DetailMismatch[];
  };
  readonly availability: { readonly served: number; readonly eligible: number; readonly value: number | null };
  /** chars/4 estimate, not a tokenizer count. */
  readonly contextTokensEstimate: { readonly method: "ceil(chars/4)"; readonly mean: number; readonly max: number };
  readonly detector: { readonly seen: DetectorResult; readonly heldout: DetectorResult };
}

export const defaultDetect = (text: string): boolean => sanitizeChunk(text).findings.length > 0;

function scoreCorpus(pair: CorpusPair, detect: (text: string) => boolean): DetectorResult {
  const misses = (pair.hostile ?? []).filter((item) => !detect(item.text)).map((i) => ({ id: i.id, category: i.category }));
  const falsePositives = (pair.benign ?? []).filter((item) => detect(item.text)).map((i) => ({ id: i.id, category: i.category }));
  const h = pair.hostile?.length ?? 0;
  const b = pair.benign?.length ?? 0;
  return {
    tpr: pair.hostile === null || h === 0 ? null : (h - misses.length) / h,
    fpr: pair.benign === null || b === 0 ? null : falsePositives.length / b,
    hostileTotal: h,
    benignTotal: b,
    misses,
    falsePositives,
  };
}

export async function runEvaluation(input: EvalInput): Promise<EvalReport> {
  const world = input.world ?? FIXTURE_WORLD;
  const policy = input.policy ?? FIXTURE_POLICY;
  const timeout = input.timeoutMs ?? EVAL_TIMEOUT_MS;
  const detect = input.detect ?? defaultDetect;
  const makeAccess = input.access ?? accessPortFromWorld;
  const makeSource = input.source ?? sourcePortFromWorld;

  const leaks: LeakItem[] = [];
  const mismatches: DetailMismatch[] = [];
  let matched = 0;
  let total = 0;
  let served = 0;
  let eligible = 0;
  const tokens: number[] = [];

  for (const scenario of input.scenarios) {
    const m = materializeScenario(scenario, world, policy);
    const result = await retrieveWithContext(
      { userId: scenario.userId, query: "eval", topK: Math.min(20, Math.max(1, m.rows.length)) },
      {
        retriever: { search: async () => m.rows },
        access: makeAccess(world),
        source: makeSource(m.sourceWorld, m.faults),
        policy,
        log: () => {},
        nonce: () => EVAL_NONCE,
      },
      { retrievalTimeoutMs: 4 * timeout, accessTimeoutMs: timeout, sourceTimeoutMs: timeout },
    );

    // Leakage: every served chunk is checked by the oracle against the row's declared fields.
    const servedChunks = new Set<string>();
    for (const chunk of result.chunks) {
      servedChunks.add(chunk.chunkId);
      const fields = m.fieldsByChunk.get(chunk.chunkId);
      if (fields === undefined || !canRead(world, scenario.userId, chunk.recordId, fields)) {
        leaks.push({ scenarioId: scenario.id, userId: scenario.userId, recordId: chunk.recordId });
      }
    }

    // Availability: valid rows the oracle allows must be served.
    scenario.rows.forEach((row, index) => {
      const chunkId = `r${index}`;
      if (row.variant === "valid" && canRead(world, scenario.userId, row.recordId, m.fieldsByChunk.get(chunkId) ?? [])) {
        eligible += 1;
        if (servedChunks.has(chunkId)) served += 1;
      }
    });

    // Detail accuracy: multiset match of (record, detail) pairs.
    const actual = result.audit.map((entry) => ({ recordId: entry.recordId, detail: entry.detail }));
    for (const expected of scenario.expect) {
      total += 1;
      const at = actual.findIndex((a) => a.recordId === expected.recordId && a.detail === expected.detail);
      if (at >= 0) {
        matched += 1;
        actual.splice(at, 1);
      } else {
        const sameRecord = actual.findIndex((a) => a.recordId === expected.recordId);
        mismatches.push({
          scenarioId: scenario.id,
          recordId: expected.recordId,
          expected: expected.detail,
          actual: sameRecord >= 0 ? (actual[sameRecord]?.detail ?? null) : null,
        });
        if (sameRecord >= 0) actual.splice(sameRecord, 1);
      }
    }
    for (const extra of actual) {
      mismatches.push({ scenarioId: scenario.id, recordId: extra.recordId, expected: null, actual: extra.detail });
    }

    tokens.push(Math.ceil(result.context.length / 4));
  }

  const unexpected = mismatches.filter((x) => x.expected === null).length;
  return {
    scenarioCount: input.scenarios.length,
    leakage: { count: leaks.length, items: leaks },
    detailAccuracy: {
      matched,
      total,
      value: total === 0 ? null : matched / (total + unexpected),
      mismatches,
    },
    availability: { served, eligible, value: eligible === 0 ? null : served / eligible },
    contextTokensEstimate: {
      method: "ceil(chars/4)",
      mean: tokens.length === 0 ? 0 : tokens.reduce((a, b) => a + b, 0) / tokens.length,
      max: tokens.length === 0 ? 0 : Math.max(...tokens),
    },
    detector: { seen: scoreCorpus(input.seen, detect), heldout: scoreCorpus(input.heldout, detect) },
  };
}
