/**
 * Guard for Agentforce Testing Center runs (`sf agent test run`).
 *
 * Failure it prevents (docs/failure-log.md #19): a run stuck on the server
 * blocks every new run with "a test run is already in progress". Retrying in
 * a loop never frees it — only the Testing Center UI cancels it — and it burns
 * time and tokens. So the guard is fail-closed:
 *   - one attempt per invocation, never an automatic retry;
 *   - a stale cached run for the same suite blocks the start (likely culprit);
 *   - a local lock stops two runners from racing;
 *   - suites that write to the CRM need an explicit flag.
 * Pure functions only; effects live in scripts/agent-test.ts.
 */

/** Suites whose cases can create real records in the org. */
export const WRITE_SUITES: ReadonlySet<string> = new Set(["GinaOwnerTaskWrite"]);

/** A cached run older than this is treated as stuck, not as running. */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

/** A local lock older than this is abandoned (runner crashed). */
export const STALE_LOCK_MS = 60 * 60 * 1000;

export interface CachedRun {
  runId: string;
  name: string;
  timestamp: string;
}

export interface PreflightInput {
  suite: string;
  allowWrite: boolean;
  now: number;
  /** Parsed ~/.sf/agent-test-cache.json values; empty when the file is absent. */
  cachedRuns: readonly CachedRun[];
  /** Start time (ms) of the local lock, or null when there is none. */
  lockStartedAt: number | null;
}

export type PreflightVerdict =
  | { ok: true; warnings: string[] }
  | { ok: false; code: "write_suite_needs_flag" | "local_lock_held" | "stale_run_cached" | "invalid_suite"; message: string };

const SUITE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

export function preflight(input: PreflightInput): PreflightVerdict {
  const { suite, allowWrite, now, cachedRuns, lockStartedAt } = input;
  if (!SUITE_NAME.test(suite)) {
    return { ok: false, code: "invalid_suite", message: `Nome de suíte inválido: ${JSON.stringify(suite)}.` };
  }
  if (WRITE_SUITES.has(suite) && !allowWrite) {
    return {
      ok: false,
      code: "write_suite_needs_flag",
      message: `${suite} cria registros reais na org. Rode só com o ok do dono e a flag --allow-write.`,
    };
  }
  if (lockStartedAt !== null && now - lockStartedAt < STALE_LOCK_MS) {
    const min = Math.round((now - lockStartedAt) / 60000);
    return {
      ok: false,
      code: "local_lock_held",
      message: `Outro runner local começou há ${min} min (.gina/agent-test.lock). Espere ele terminar; não rode em paralelo.`,
    };
  }
  const warnings: string[] = [];
  for (const run of cachedRuns) {
    const started = Date.parse(run.timestamp);
    // Unparseable timestamp: ambiguous, so treat it as stale (fail closed).
    const age = Number.isFinite(started) ? now - started : Number.POSITIVE_INFINITY;
    if (age < STALE_RUN_MS) continue;
    const when = Number.isFinite(started) ? new Date(started).toISOString() : "data ilegível";
    if (run.name === suite) {
      return {
        ok: false,
        code: "stale_run_cached",
        message:
          `Execução ${run.runId} de ${suite} (${when}) nunca fechou no cache local. ` +
          `É a suspeita nº 1 de trava no servidor. Cancele no Testing Center e rode de novo com --clear-stale.`,
      };
    }
    warnings.push(`Execução antiga em cache: ${run.runId} (${run.name}, ${when}).`);
  }
  return { ok: true, warnings };
}

export type RunOutcome =
  | { kind: "completed"; runId: string | null; summary: RunSummary }
  | { kind: "blocked_by_server_run"; message: string }
  | { kind: "wait_timed_out"; runId: string | null; message: string }
  | { kind: "failed"; message: string };

export interface RunSummary {
  status: string;
  testCases: number;
  /** scorer name -> [passed, total] */
  scorers: Record<string, [number, number]>;
}

const BLOCKED = /already in progress/i;
const TIMED_OUT = /timed? ?out|wait time|still running|IN_PROGRESS/i;

/**
 * Classify the JSON printed by `sf agent test run --json`.
 * Anything unrecognized is `failed`: an unknown shape is never "passed".
 */
export function classifyRunOutput(raw: string): RunOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "failed", message: `Saída do sf não é JSON (${raw.slice(0, 120)}).` };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "failed", message: "Saída do sf vazia." };
  const doc = parsed as { status?: number; message?: string; name?: string; result?: Record<string, unknown> };
  const message = typeof doc.message === "string" ? doc.message : "";
  if (BLOCKED.test(message)) return { kind: "blocked_by_server_run", message };
  const result = doc.result ?? {};
  const runId = typeof result.runId === "string" ? result.runId : null;
  if (doc.status !== 0) {
    if (TIMED_OUT.test(message) || TIMED_OUT.test(String(doc.name ?? ""))) {
      return { kind: "wait_timed_out", runId, message };
    }
    return { kind: "failed", message: message || `status ${String(doc.status)}` };
  }
  const status = typeof result.status === "string" ? result.status : "UNKNOWN";
  if (status.toUpperCase() !== "COMPLETED") {
    return { kind: "wait_timed_out", runId, message: `Status ${status}` };
  }
  return { kind: "completed", runId, summary: summarize(result) };
}

function summarize(result: Record<string, unknown>): RunSummary {
  const cases = Array.isArray(result.testCases) ? (result.testCases as Array<Record<string, unknown>>) : [];
  const scorers: Record<string, [number, number]> = {};
  for (const tc of cases) {
    const results = Array.isArray(tc.testResults) ? (tc.testResults as Array<Record<string, unknown>>) : [];
    for (const r of results) {
      const name = typeof r.name === "string" ? r.name : "unknown";
      const entry = (scorers[name] ??= [0, 0]);
      entry[1] += 1;
      if (r.result === "PASS") entry[0] += 1;
    }
  }
  return { status: String(result.status), testCases: cases.length, scorers };
}

/** Text the runner prints for each outcome; the next step is always explicit. */
export function nextStep(outcome: RunOutcome, suite: string): string {
  switch (outcome.kind) {
    case "completed":
      return "Concluído. Compare com o último relatório antes de ativar qualquer versão.";
    case "blocked_by_server_run":
      return (
        "Org travada por outra execução. NÃO repita em loop: isso não destrava nada. " +
        "Cancele no Setup → Testing Center (Teste em lote) e rode uma vez de novo."
      );
    case "wait_timed_out":
      return outcome.runId
        ? `A execução segue no servidor. Uma vez só: sf agent test resume --job-id ${outcome.runId} --wait 20 --result-format json --target-org minha-org-agentforce`
        : `Sem runId; confira ${suite} no Testing Center antes de tentar de novo.`;
    case "failed":
      return "Falhou antes de rodar. Leia a mensagem; não tente de novo sem entender a causa.";
  }
}
