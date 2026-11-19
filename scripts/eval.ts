/**
 * Module 4 runner. The only place with file I/O.
 *   node scripts/eval.ts                  run, print scorecard, write reports/eval.json, exit 1 on a failed gate
 *   node scripts/eval.ts --write-baseline write eval/baseline.json from this run (refused if a hard gate fails)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CorpusItem, parseCorpusItems } from "../src/eval/corpus.ts";
import { anyGateFailed, type Baseline, evaluateGates, type GateResult, hardGatesPass, metricsOf, parseBaseline } from "../src/eval/gates.ts";
import { type CorpusPair, type EvalReport, runEvaluation } from "../src/eval/metrics.ts";
import { parseScenarios } from "../src/eval/scenarios.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (...p: string[]): string => resolve(root, ...p);

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
function loadItems(path: string): CorpusItem[] | null {
  return existsSync(path) ? parseCorpusItems(readJson(path), path) : null;
}
/** Concatenates every directory that exists; null only when none has the file. */
function loadPair(dirs: readonly string[]): CorpusPair {
  const join = (file: string): CorpusItem[] | null => {
    const parts = dirs.map((dir) => loadItems(at("eval/corpus", dir, file))).filter((x): x is CorpusItem[] => x !== null);
    return parts.length === 0 ? null : parts.flat();
  };
  return { hostile: join("hostile.json"), benign: join("benign.json") };
}

/**
 * Corpus layout. "seen" is everything the detector was ever tuned against:
 * the cases from the tests plus every held-out corpus already used for tuning.
 * "heldout" is the one corpus nobody has tuned against yet. When it is used
 * for tuning, move it under seen/ and commission a new blind one.
 */
const SEEN_DIRS = ["seen", "seen/heldout-v1"] as const;
const HELDOUT_DIRS = ["heldout-v2"] as const;

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const pct = (v: number | null): string => (v === null ? "not available" : `${(v * 100).toFixed(1)}%`);
const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

function printScorecard(r: EvalReport, gates: readonly GateResult[]): void {
  const row = (k: string, v: string): void => console.log(`  ${k.padEnd(34)}${v}`);
  console.log(`Gina RAG eval: ${r.scenarioCount} scenarios`);
  row("leakage (served, oracle says no)", String(r.leakage.count));
  row("detail accuracy", `${r.detailAccuracy.matched}/${r.detailAccuracy.total} (${pct(r.detailAccuracy.value)})`);
  row("availability", `${r.availability.served}/${r.availability.eligible} (${pct(r.availability.value)})`);
  row("context tokens (estimate chars/4)", `mean ${r.contextTokensEstimate.mean.toFixed(1)}, max ${r.contextTokensEstimate.max}`);
  for (const name of ["seen", "heldout"] as const) {
    const d = r.detector[name];
    row(`${name} TPR (${d.hostileTotal} hostile)`, pct(d.tpr));
    row(`${name} FPR (${d.benignTotal} benign)`, pct(d.fpr));
  }
  for (const leak of r.leakage.items) console.log(`  LEAK ${leak.scenarioId} user=${leak.userId} record=${leak.recordId}`);
  for (const m of r.detailAccuracy.mismatches) {
    console.log(`  MISMATCH ${m.scenarioId} record=${m.recordId} expected=${m.expected ?? "-"} actual=${m.actual ?? "-"}`);
  }
  for (const name of ["seen", "heldout"] as const) {
    for (const m of r.detector[name].misses) console.log(`  MISS ${name} ${clip(m.id)} [${clip(m.category)}]`);
    for (const m of r.detector[name].falsePositives) console.log(`  FALSE POSITIVE ${name} ${clip(m.id)} [${clip(m.category)}]`);
  }
  console.log("Gates");
  for (const g of gates) console.log(`  ${g.status.toUpperCase().padEnd(14)}${g.kind.padEnd(11)}${g.name.padEnd(28)}${g.message}`);
}

const writeBaseline = process.argv.includes("--write-baseline");
const scenarios = parseScenarios(readJson(at("eval/scenarios/access.json")));
const report = await runEvaluation({ scenarios, seen: loadPair(SEEN_DIRS), heldout: loadPair(HELDOUT_DIRS) });

const baselinePath = at("eval/baseline.json");
let baseline: Baseline | null = existsSync(baselinePath) ? parseBaseline(readJson(baselinePath)) : null;
const HELDOUT_NAME = HELDOUT_DIRS.join("+");
let gates = evaluateGates(report, baseline, HELDOUT_NAME);

if (writeBaseline) {
  if (!hardGatesPass(gates)) {
    printScorecard(report, gates);
    console.error("Refusing to write a baseline: a hard gate fails.");
    process.exit(1);
  }
  const fresh: Baseline = {
    date: new Date().toISOString().slice(0, 10),
    commit: gitCommit(),
    heldoutCorpus: HELDOUT_NAME,
    metrics: metricsOf(report),
  };
  writeFileSync(baselinePath, `${JSON.stringify(fresh, null, 2)}\n`);
  baseline = fresh;
  gates = evaluateGates(report, baseline, HELDOUT_NAME);
  console.log(`Baseline written to eval/baseline.json (${fresh.commit}, ${fresh.date})`);
} else if (baseline === null) {
  console.log("No eval/baseline.json: regression gates are not gated. Run `pnpm eval --write-baseline`.");
}

mkdirSync(at("reports"), { recursive: true });
writeFileSync(at("reports/eval.json"), `${JSON.stringify({ report, gates, baseline }, null, 2)}\n`);
printScorecard(report, gates);
process.exit(anyGateFailed(gates) ? 1 : 0);
