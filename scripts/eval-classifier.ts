/**
 * Measures injection detection with the local model classifier. Not in CI: it
 * needs Ollama running on this machine.
 *
 *   node scripts/eval-classifier.ts [--model=qwen2.5:7b] [--corpus=seen|heldout|all]
 *
 * Reports, per corpus, three detectors: the pattern detector alone, the
 * classifier alone, and both together (a chunk is denied if either flags,
 * which is how retrieval + Trust Layer behave). An "unverified" verdict counts
 * as flagged, because the Trust Layer denies it. For the held-out corpus it
 * prints ids and categories only, never texts, so whoever tunes stays blind.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOllamaClassifier } from "../src/adapters/ollamaClassifier.ts";
import { type CorpusItem, parseCorpusItems } from "../src/eval/corpus.ts";
import { sanitizeChunk } from "../src/retrieval/sanitize.ts";
import { parseVerdict } from "../src/trust/classifier.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const model = flag("model") ?? "qwen2.5:7b";
const which = flag("corpus") ?? "all";

const CORPORA = {
  seen: ["seen", "seen/heldout-v1"],
  heldout: ["heldout-v2"],
} as const;

function load(dirs: readonly string[], file: string): CorpusItem[] {
  return dirs.flatMap((dir) => {
    const path = resolve(root, "eval/corpus", dir, file);
    return existsSync(path) ? parseCorpusItems(JSON.parse(readFileSync(path, "utf8")), path) : [];
  });
}

const classifier = createOllamaClassifier({ model });
const TIMEOUT_MS = 60_000;

async function judge(text: string): Promise<{ verdict: string; ms: number }> {
  const started = performance.now();
  try {
    const raw = await classifier.classify(text, AbortSignal.timeout(TIMEOUT_MS));
    return { verdict: parseVerdict(raw), ms: performance.now() - started };
  } catch {
    return { verdict: "unverified", ms: performance.now() - started };
  }
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`);
const rank = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

const out: Record<string, unknown> = { model: classifier.id, date: new Date().toISOString() };
for (const name of ["seen", "heldout"] as const) {
  if (which !== "all" && which !== name) continue;
  const hostile = load(CORPORA[name], "hostile.json");
  const benign = load(CORPORA[name], "benign.json");
  if (hostile.length === 0 && benign.length === 0) continue;
  const rows: { id: string; category: string; hostile: boolean; pattern: boolean; model: boolean; unverified: boolean; ms: number }[] = [];
  for (const [items, isHostile] of [[hostile, true], [benign, false]] as const) {
    for (const item of items) {
      const pattern = sanitizeChunk(item.text).findings.length > 0;
      const { verdict, ms } = await judge(item.text);
      rows.push({ id: item.id, category: item.category, hostile: isHostile, pattern, model: verdict !== "safe", unverified: verdict === "unverified", ms });
    }
  }
  const h = rows.filter((r) => r.hostile);
  const b = rows.filter((r) => !r.hostile);
  const ms = rows.map((r) => r.ms).sort((x, y) => x - y);
  console.log(`\n== ${name} (${CORPORA[name].join(" + ")}) · ${classifier.id}`);
  for (const [label, pick] of [
    ["pattern only", (r: (typeof rows)[number]) => r.pattern],
    ["classifier only", (r: (typeof rows)[number]) => r.model],
    ["pattern OR classifier", (r: (typeof rows)[number]) => r.pattern || r.model],
  ] as const) {
    console.log(`  ${label.padEnd(22)} detection ${pct(h.filter(pick).length, h.length).padEnd(18)} false positives ${pct(b.filter(pick).length, b.length)}`);
  }
  console.log(`  unverified verdicts     ${rows.filter((r) => r.unverified).length}`);
  console.log(`  classifier latency      P50 ${Math.round(rank(ms, 50))} ms · P95 ${Math.round(rank(ms, 95))} ms · max ${Math.round(ms.at(-1) ?? 0)} ms`);
  const misses = h.filter((r) => !r.pattern && !r.model);
  const fps = b.filter((r) => r.pattern || r.model);
  const byCat = (list: typeof rows): string =>
    Object.entries(list.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {}))
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "none";
  console.log(`  combined misses by category: ${byCat(misses)}`);
  console.log(`  combined false positives by category: ${byCat(fps)}`);
  console.log(`  miss ids: ${misses.map((r) => r.id).join(" ") || "none"}`);
  console.log(`  false-positive ids: ${fps.map((r) => r.id).join(" ") || "none"}`);
  out[name] = { rows: rows.map(({ id, category, hostile, pattern, model, unverified, ms }) => ({ id, category, hostile, pattern, model, unverified, ms: Math.round(ms) })) };
}

mkdirSync(resolve(root, "reports"), { recursive: true });
writeFileSync(resolve(root, "reports/eval-classifier.json"), `${JSON.stringify(out, null, 2)}\n`);
