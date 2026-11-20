import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REASON_FOR } from "../src/retrieval/reasons.ts";

// The README diagram names deny codes. If reasons.ts changes and the SVG is not
// regenerated (node design/diagrams/pipeline.mjs), the diagram lies; this fails.
const svg = readFileSync(new URL("../assets/pipeline.svg", import.meta.url), "utf8");
const codes = [...svg.matchAll(/<text\b[^>]*\bdata-detail="([^"]+)"[^>]*\bdata-reason="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
  .map(([, detail = "", reason = "", label = ""]) => ({ detail, reason, label }));
const table: Record<string, string> = REASON_FOR;

test("pipeline diagram · every code drawn is a real detail, under its real reason", () => {
  assert.ok(codes.length > 0, "no codes found in assets/pipeline.svg");
  for (const c of codes) {
    assert.ok(Object.hasOwn(table, c.detail), `unknown detail in diagram: ${c.detail}`);
    assert.equal(c.reason, table[c.detail], `${c.detail} is drawn under ${c.reason}`);
    assert.equal(c.label, c.detail, `label text differs from data-detail for ${c.detail}`);
  }
});

test("pipeline diagram · every deny detail in reasons.ts is drawn", () => {
  const drawn = new Set(codes.map((c) => c.detail));
  const missing = Object.keys(table).filter((d) => d !== "ok" && !drawn.has(d));
  assert.deepEqual(missing, []);
});

test("pipeline diagram · the allow path draws no code", () => {
  assert.ok(!codes.some((c) => c.detail === "ok"));
});
