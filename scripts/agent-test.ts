/**
 * Safe runner for Agentforce Testing Center suites. One attempt, never a loop.
 *
 *   pnpm agent:test                          runs GinaPresalesSDR against the org
 *   pnpm agent:test --suite <ApiName>        another suite
 *   pnpm agent:test --suite GinaOwnerTaskWrite --allow-write
 *                                            creates a real Task: only with the owner's ok
 *   pnpm agent:test --clear-stale            after cancelling a stuck run in the Testing Center,
 *                                            drop its entry from ~/.sf/agent-test-cache.json (backup kept)
 *   pnpm agent:test --check                  preflight only, starts nothing
 *
 * Exit codes: 0 completed · 2 preflight refused · 3 org blocked by another run
 *             4 still running (resume once) · 1 any other failure.
 * Why: docs/failure-log.md #19 — 8 retries 3 min apart never freed a server-side lock.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type CachedRun, classifyRunOutput, nextStep, preflight, STALE_RUN_MS } from "../src/agentTest/guard.ts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const suite = flag("suite") ?? "GinaPresalesSDR";
const org = flag("target-org") ?? "minha-org-agentforce";
const waitMin = Math.min(Math.max(Number(flag("wait") ?? 20), 1), 60);
const cachePath = join(homedir(), ".sf", "agent-test-cache.json");
const lockPath = join(root, ".gina", "agent-test.lock");

function readCache(): Record<string, CachedRun> {
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, CachedRun>;
  } catch {
    // Unreadable cache: report it, never guess what it held.
    console.error(`Aviso: ${cachePath} ilegível; ignorado.`);
    return {};
  }
}

function readLock(): number | null {
  if (!existsSync(lockPath)) return null;
  const t = Number(readFileSync(lockPath, "utf8").trim());
  return Number.isFinite(t) ? t : 0; // garbage lock counts as very old
}

if (has("clear-stale")) {
  const cache = readCache();
  const now = Date.now();
  const stale = Object.entries(cache).filter(
    ([, r]) => r.name === suite && !(now - Date.parse(r.timestamp) < STALE_RUN_MS),
  );
  if (stale.length === 0) {
    console.log(`Nada velho em cache para ${suite}.`);
  } else {
    const backup = `${cachePath}.bak-${now}`;
    copyFileSync(cachePath, backup);
    for (const [id] of stale) delete cache[id];
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    console.log(`Removido do cache: ${stale.map(([id]) => id).join(", ")}. Backup: ${backup}`);
  }
  process.exit(0);
}

const verdict = preflight({
  suite,
  allowWrite: has("allow-write"),
  now: Date.now(),
  cachedRuns: Object.values(readCache()),
  lockStartedAt: readLock(),
});
if (!verdict.ok) {
  console.error(`[${verdict.code}] ${verdict.message}`);
  process.exit(2);
}
for (const w of verdict.warnings) console.warn(`Aviso: ${w}`);
if (has("check")) {
  console.log(`Preflight ok para ${suite}. Nada foi iniciado.`);
  process.exit(0);
}

const outDir = join(root, ".gina", "agent-tests", `${suite}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(lockPath, String(Date.now()));

const sfArgs = [
  "agent", "test", "run",
  "--api-name", suite,
  "--target-org", org,
  "--wait", String(waitMin),
  "--result-format", "json",
  "--output-dir", outDir,
  "--json",
];
console.log(`Rodando ${suite} uma vez (espera máx. ${waitMin} min). Saída: ${outDir}`);

execFile("sf", sfArgs, { timeout: (waitMin + 3) * 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
  rmSync(lockPath, { force: true });
  writeFileSync(join(outDir, "sf-run.json"), stdout);
  const killed = err !== null && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
  const outcome = killed
    ? { kind: "wait_timed_out" as const, runId: null, message: "sf não respondeu no prazo; processo encerrado." }
    : classifyRunOutput(stdout);

  if (outcome.kind === "completed") {
    const { summary } = outcome;
    console.log(`runId ${outcome.runId ?? "?"} · ${summary.status} · ${summary.testCases} casos`);
    for (const [name, [pass, total]] of Object.entries(summary.scorers)) {
      console.log(`  ${name}: ${pass}/${total}`);
    }
  } else {
    console.error(`[${outcome.kind}] ${outcome.message}`);
  }
  console.log(nextStep(outcome, suite));
  const code = { completed: 0, blocked_by_server_run: 3, wait_timed_out: 4, failed: 1 }[outcome.kind];
  process.exit(code);
});
