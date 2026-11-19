import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRunOutput, nextStep, preflight, STALE_LOCK_MS, STALE_RUN_MS } from "../src/agentTest/guard.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const base = { suite: "GinaPresalesSDR", allowWrite: false, now: NOW, cachedRuns: [], lockStartedAt: null };

test("AT01 write suite refused without --allow-write", () => {
  const v = preflight({ ...base, suite: "GinaOwnerTaskWrite" });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "write_suite_needs_flag");
});

test("AT02 write suite allowed with the explicit flag", () => {
  assert.equal(preflight({ ...base, suite: "GinaOwnerTaskWrite", allowWrite: true }).ok, true);
});

test("AT03 stale cached run of the same suite blocks the start (the 2026-11-07 run)", () => {
  const v = preflight({
    ...base,
    cachedRuns: [{ runId: "3A2gK000008FPMTSA4", name: "GinaPresalesSDR", timestamp: "2026-11-07T09:51:04.116Z" }],
  });
  assert.equal(!v.ok && v.code, "stale_run_cached");
});

test("AT04 stale run of another suite only warns", () => {
  const v = preflight({
    ...base,
    cachedRuns: [{ runId: "X", name: "Other", timestamp: "2026-11-07T09:51:04.116Z" }],
  });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.warnings.length, 1);
});

test("AT05 fresh cached run is not stale", () => {
  const fresh = new Date(NOW - STALE_RUN_MS + 60_000).toISOString();
  assert.equal(preflight({ ...base, cachedRuns: [{ runId: "Y", name: "GinaPresalesSDR", timestamp: fresh }] }).ok, true);
});

test("AT06 unparseable cache timestamp fails closed", () => {
  const v = preflight({ ...base, cachedRuns: [{ runId: "Z", name: "GinaPresalesSDR", timestamp: "ontem" }] });
  assert.equal(!v.ok && v.code, "stale_run_cached");
});

test("AT07 live local lock blocks; abandoned lock does not", () => {
  assert.equal(preflight({ ...base, lockStartedAt: NOW - 5 * 60_000 }).ok, false);
  assert.equal(preflight({ ...base, lockStartedAt: NOW - STALE_LOCK_MS - 1 }).ok, true);
});

test("AT08 suite name injection refused", () => {
  const v = preflight({ ...base, suite: "GinaPresalesSDR --allow-write; rm -rf ~" });
  assert.equal(!v.ok && v.code, "invalid_suite");
});

test("AT09 'already in progress' is classified as blocked, never retried", () => {
  const raw = JSON.stringify({ status: 1, name: "TestStartFailed", message: "Failed to start test: a test run is already in progress" });
  const o = classifyRunOutput(raw);
  assert.equal(o.kind, "blocked_by_server_run");
  assert.match(nextStep(o, "GinaPresalesSDR"), /NÃO repita em loop/);
});

test("AT10 non-JSON and unknown shapes are failures, not passes", () => {
  assert.equal(classifyRunOutput("Warning: update available").kind, "failed");
  assert.equal(classifyRunOutput("null").kind, "failed");
  assert.equal(classifyRunOutput(JSON.stringify({ status: 0, result: {} })).kind, "wait_timed_out");
});

test("AT11 completed run is summarized per scorer", () => {
  const raw = JSON.stringify({
    status: 0,
    result: {
      runId: "4KB1",
      status: "COMPLETED",
      testCases: [
        { testResults: [{ name: "topic_sequence_match", result: "PASS" }, { name: "bot_response_rating", result: "FAILURE" }] },
        { testResults: [{ name: "topic_sequence_match", result: "PASS" }, { name: "bot_response_rating", result: "PASS" }] },
      ],
    },
  });
  const o = classifyRunOutput(raw);
  assert.equal(o.kind, "completed");
  assert.deepEqual(o.kind === "completed" && o.summary.scorers, {
    topic_sequence_match: [2, 2],
    bot_response_rating: [1, 2],
  });
});

test("AT12 timeout with runId points to a single resume", () => {
  const o = classifyRunOutput(JSON.stringify({ status: 1, message: "Operation timed out", result: { runId: "4KB2" } }));
  assert.equal(o.kind, "wait_timed_out");
  assert.match(nextStep(o, "GinaPresalesSDR"), /Uma vez só: sf agent test resume --job-id 4KB2/);
});
