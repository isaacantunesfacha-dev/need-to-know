/** Hard and regression gates over an EvalReport. Pure. */
import type { EvalReport } from "./metrics.ts";

export interface BaselineMetrics {
  readonly availability?: number;
  readonly heldoutTpr?: number;
  readonly seenFpr?: number;
  readonly heldoutFpr?: number;
}
export interface Baseline {
  readonly date: string;
  readonly commit: string;
  /** Which held-out corpus the detector metrics were measured on, e.g. "heldout-v2". */
  readonly heldoutCorpus?: string;
  readonly metrics: BaselineMetrics;
}

/** fail = gate broken; pass = verified; the other two never count as passing. */
export type GateStatus = "pass" | "fail" | "not_available" | "not_gated";
export interface GateResult {
  readonly name: string;
  readonly kind: "hard" | "regression";
  readonly status: GateStatus;
  readonly message: string;
}

const EPS = 1e-12;
const fmt = (v: number | null): string => (v === null ? "n/a" : v.toFixed(4));

export function metricsOf(report: EvalReport): BaselineMetrics {
  const out: { -readonly [K in keyof BaselineMetrics]: number } = {};
  if (report.availability.value !== null) out.availability = report.availability.value;
  if (report.detector.heldout.tpr !== null) out.heldoutTpr = report.detector.heldout.tpr;
  if (report.detector.seen.fpr !== null) out.seenFpr = report.detector.seen.fpr;
  if (report.detector.heldout.fpr !== null) out.heldoutFpr = report.detector.heldout.fpr;
  return out;
}

export function parseBaseline(raw: unknown): Baseline {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const m = (typeof o["metrics"] === "object" && o["metrics"] !== null ? o["metrics"] : {}) as Record<string, unknown>;
  const num = (k: string): number | undefined => {
    const v = m[k];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`baseline: metric ${k} must be a number in [0,1]`);
    return v;
  };
  const metrics: { -readonly [K in keyof BaselineMetrics]: number } = {};
  for (const key of ["availability", "heldoutTpr", "seenFpr", "heldoutFpr"] as const) {
    const v = num(key);
    if (v !== undefined) metrics[key] = v;
  }
  const heldoutCorpus = typeof o["heldoutCorpus"] === "string" ? o["heldoutCorpus"] : undefined;
  return {
    date: String(o["date"] ?? ""),
    commit: String(o["commit"] ?? ""),
    ...(heldoutCorpus === undefined ? {} : { heldoutCorpus }),
    metrics,
  };
}

function regression(
  name: string,
  current: number | null,
  base: number | undefined,
  direction: "min" | "max",
): GateResult {
  const mk = (status: GateStatus, message: string): GateResult => ({ name, kind: "regression", status, message });
  if (base === undefined) {
    return current === null
      ? mk("not_available", "no measurement and no baseline")
      : mk("not_gated", `current ${fmt(current)}, no baseline`);
  }
  if (current === null) return mk("fail", `baseline ${fmt(base)} but no measurement: cannot verify`);
  const ok = direction === "min" ? current >= base - EPS : current <= base + EPS;
  return mk(ok ? "pass" : "fail", `current ${fmt(current)} ${direction === "min" ? ">=" : "<="} baseline ${fmt(base)}`);
}

/**
 * `heldoutCorpus` names the corpus measured now. When it differs from the one
 * the baseline was measured on, the held-out numbers are not comparable: both
 * held-out gates fail until someone re-baselines on purpose.
 */
export function evaluateGates(report: EvalReport, baseline: Baseline | null, heldoutCorpus?: string): GateResult[] {
  const hard = (name: string, ok: boolean, message: string): GateResult => ({
    name,
    kind: "hard",
    status: ok ? "pass" : "fail",
    message,
  });
  const b = baseline?.metrics ?? {};
  const seenTpr = report.detector.seen.tpr;
  const acc = report.detailAccuracy.value;
  const corpusChanged =
    baseline !== null && heldoutCorpus !== undefined && (baseline.heldoutCorpus ?? "unrecorded") !== heldoutCorpus;
  const heldout = (gate: GateResult): GateResult =>
    corpusChanged
      ? {
          ...gate,
          status: "fail",
          message: `baseline measured ${baseline?.heldoutCorpus ?? "an unrecorded corpus"}, now ${heldoutCorpus}: re-baseline deliberately`,
        }
      : gate;
  return [
    hard("leakage === 0", report.leakage.count === 0, `${report.leakage.count} leaked chunk(s)`),
    hard("detailAccuracy === 1", acc !== null && Math.abs(acc - 1) < EPS, `accuracy ${fmt(acc)}`),
    hard("seen TPR === 1", seenTpr !== null && Math.abs(seenTpr - 1) < EPS, `seen TPR ${fmt(seenTpr)}`),
    regression("availability >= baseline", report.availability.value, b.availability, "min"),
    heldout(regression("heldout TPR >= baseline", report.detector.heldout.tpr, b.heldoutTpr, "min")),
    regression("seen FPR <= baseline", report.detector.seen.fpr, b.seenFpr, "max"),
    heldout(regression("heldout FPR <= baseline", report.detector.heldout.fpr, b.heldoutFpr, "max")),
  ];
}

export const hardGatesPass = (gates: readonly GateResult[]): boolean => gates.filter((g) => g.kind === "hard").every((g) => g.status === "pass");
export const anyGateFailed = (gates: readonly GateResult[]): boolean => gates.some((g) => g.status === "fail");
