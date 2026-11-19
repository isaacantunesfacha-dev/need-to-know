// assets/pipeline.svg: the one diagram at the top of the README.
// Thesis: the horizontal line is the happy path; every denial falls vertically.
// Deny codes are grouped by REASON_FOR from src/retrieval/reasons.ts, so the
// grouping cannot drift from the table; tests/pipelineDiagram.test.ts checks
// the committed SVG against the table.
// usage: node design/diagrams/pipeline.mjs
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REASON_FOR } from "../../src/retrieval/reasons.ts";

const root = resolve(import.meta.dirname, "../..");

// Which stage emits which detail (from the code, not from memory).
const STAGES = [
  { name: "retrieve", details: ["malformed_request", "retriever_error", "timeout"] },
  {
    name: "contract v1",
    contract: true,
    details: ["malformed_candidate", "schema_mismatch", "tenant_mismatch", "embedding_model_rejected", "undeclared_field", "hygiene_unapproved"],
  },
  {
    name: "access check",
    sub: "FLS · sharing",
    details: ["entity_denied", "field_denied", "record_denied", "object_mismatch",
      "entity_unreadable", "field_unreadable", "record_unreadable", "object_unverified", "access_check_error", "audit_failure", "timeout"],
  },
  { name: "live re-read", sub: "hash must match", details: ["stale_chunk", "source_error", "source_mismatch", "timeout"] },
  { name: "sanitize", details: ["hidden_payload", "embedded_instruction", "oversize_chunk", "empty_after_sanitize"] },
  { name: "Trust Layer", sub: "local classifier", details: ["classifier_flagged", "classifier_error", "timeout"] },
  { name: "LLM", llm: true, narrow: true, details: [] },
];

// Every deny detail must appear somewhere; fail the build otherwise.
const placed = new Set(STAGES.flatMap((s) => s.details));
const missing = Object.keys(REASON_FOR).filter((d) => d !== "ok" && !placed.has(d));
if (missing.length) throw new Error(`details not placed in the diagram: ${missing.join(", ")}`);
for (const d of placed) if (!(d in REASON_FOR)) throw new Error(`unknown detail: ${d}`);

const CODE = 12, HEAD = 12, CH = 0.6; // monospace advance ≈ 0.6em
const BOX_W = 124, BOX_H = 56, CON_W = 108, CON_H = 42;
const RAIL = 9, INDENT = 18, GAP = 16, LH = 18;
const TOP = 104, LINE_Y = TOP + BOX_H / 2;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

let x = 84; // room for "question" on the left
const cols = STAGES.map((s) => {
  const groups = [];
  for (const d of s.details) {
    const r = REASON_FOR[d];
    let g = groups.find((g) => g.reason === r);
    if (!g) groups.push((g = { reason: r, details: [] }));
    g.details.push(d);
  }
  const textW = Math.max(0, ...groups.flatMap((g) => [g.reason.length * HEAD * CH, ...g.details.map((d) => d.length * CODE * CH)]));
  const w = s.contract || s.narrow ? CON_W : BOX_W;
  const colW = Math.max(w, INDENT + textW);
  const col = { ...s, groups, x, w, colW };
  x += colW + GAP;
  return col;
});
const W = Math.ceil(x - GAP + 60);

let maxY = 0;
const parts = [];
for (const c of cols) {
  const h = c.contract ? CON_H : BOX_H;
  const by = LINE_Y - h / 2;
  const cx = c.x + c.w / 2;
  parts.push(`<g data-stage="${esc(c.name)}">`);
  parts.push(`<rect class="box${c.contract ? " contract" : ""}" x="${c.x}" y="${by}" width="${c.w}" height="${h}" rx="6"/>`);
  if (c.sub) {
    parts.push(`<text class="label" x="${cx}" y="${by + 24}" text-anchor="middle">${esc(c.name)}</text>`);
    parts.push(`<text class="sub" x="${cx}" y="${by + 42}" text-anchor="middle">${esc(c.sub)}</text>`);
  } else {
    parts.push(`<text class="${c.contract ? "sub mono" : "label"}" x="${cx}" y="${LINE_Y + 5}" text-anchor="middle">${esc(c.name)}</text>`);
  }
  if (c.groups.length) {
    const railX = c.x + RAIL;
    let y = by + h + 40;
    const start = by + h;
    const rows = [];
    for (const g of c.groups) {
      // A detail named like its reason is drawn once, as the reason.
      if (g.details.length === 1 && g.details[0] === g.reason) {
        rows.push(`<text class="reason" x="${c.x + INDENT}" y="${y}" data-detail="${g.reason}" data-reason="${g.reason}">${g.reason}</text>`);
        y += LH + 8;
        continue;
      }
      rows.push(`<text class="reason" x="${c.x + INDENT}" y="${y}" data-reason="${g.reason}">${g.reason}</text>`);
      y += LH;
      for (const d of g.details) {
        rows.push(`<text class="code" x="${c.x + INDENT}" y="${y}" data-detail="${d}" data-reason="${g.reason}">${d}</text>`);
        y += LH;
      }
      y += 8;
    }
    const end = y - LH - 8 + 5;
    parts.push(`<path class="deny" d="M${railX} ${start} V${end}"/>`);
    parts.push(`<path class="deny" d="M${railX - 5} ${start + 14} L${railX} ${start + 22} L${railX + 5} ${start + 14}"/>`);
    parts.push(...rows);
    maxY = Math.max(maxY, y);
  }
  if (c.llm) {
    parts.push(`<text class="sub" x="${c.x}" y="${by + h + 32}">no deny branch:</text>`);
    parts.push(`<text class="sub" x="${c.x}" y="${by + h + 50}">it reads, never decides</text>`);
  }
  parts.push(`</g>`);
}

// The happy path: one line under the boxes, from the question to the answer.
const first = cols[0], last = cols.at(-1);
const flow = [`<path class="flow" d="M20 ${LINE_Y} H${first.x}"/>`];
for (let i = 0; i < cols.length - 1; i++) {
  const a = cols[i], b = cols[i + 1];
  flow.push(`<path class="flow" d="M${a.x + a.w} ${LINE_Y} H${b.x - 3}"/><path class="flow" d="M${b.x - 9} ${LINE_Y - 5} L${b.x - 3} ${LINE_Y} L${b.x - 9} ${LINE_Y + 5}"/>`);
}
const endX = last.x + last.w;
flow.push(`<path class="flow" d="M${endX} ${LINE_Y} H${W - 20}"/><path class="flow" d="M${W - 26} ${LINE_Y - 5} L${W - 20} ${LINE_Y} L${W - 26} ${LINE_Y + 5}"/>`);

const H = Math.ceil(maxY + 48);
const legendY = H - 22;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">need-to-know retrieval pipeline</title>
<desc id="d">A question flows left to right through retrieve, contract v1, access check, live re-read, sanitize and Trust Layer to the LLM. Every stage except the LLM can deny, and each denial drops down with its audit reason and detail code.</desc>
<style>
  .label { font: 600 16px system-ui, -apple-system, "Segoe UI", sans-serif; fill: #1f2328; }
  .sub { font: 400 13px system-ui, -apple-system, "Segoe UI", sans-serif; fill: #59636e; }
  .mono, .code, .reason { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .sub.mono { font-size: 14px; }
  .code { font-size: ${CODE}px; fill: #59636e; }
  .reason { font-size: ${HEAD}px; font-weight: 700; fill: #cf222e; }
  .cap { font: 600 14px system-ui, -apple-system, "Segoe UI", sans-serif; fill: #1f2328; }
  .cap.deny-cap { fill: #cf222e; }
  .legend { font: 400 14px system-ui, -apple-system, "Segoe UI", sans-serif; fill: #59636e; }
  .legend tspan.n { font-weight: 700; fill: #1f2328; }
  .box { fill: none; stroke: #1f2328; stroke-width: 1.5; }
  .box.contract { stroke: #59636e; stroke-dasharray: 5 4; }
  .flow { fill: none; stroke: #1f2328; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .deny { fill: none; stroke: #cf222e; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  @media (prefers-color-scheme: dark) {
    .label, .cap, .legend tspan.n { fill: #f0f6fc; }
    .sub, .code, .legend { fill: #9198a1; }
    .reason, .cap.deny-cap { fill: #ff7b72; }
    .box, .flow { stroke: #f0f6fc; }
    .box.contract { stroke: #9198a1; }
    .deny { stroke: #ff7b72; }
  }
</style>
<text class="cap" x="20" y="40">→ happy path: every boundary said yes</text>
<text class="cap deny-cap" x="20" y="64">↓ any boundary can say no, and the audit log records why</text>
<text class="sub" x="20" y="${LINE_Y - 10}">question</text>
<text class="sub" x="${W - 20}" y="${LINE_Y + 24}" text-anchor="end">answer</text>
${flow.join("\n")}
${parts.join("\n")}
<text class="legend" x="20" y="${legendY}"><tspan class="n">0</tspan> leaked chunks in 36 permission scenarios  ·  <tspan class="n">316/316</tspan> offline tests  ·  injection detection <tspan class="n">76.3–81.3%</tspan> on blind corpus v2 (5 runs), false positives <tspan class="n">0–1.3%</tspan></text>
</svg>
`;
writeFileSync(join(root, "assets/pipeline.svg"), svg);
console.log(`wrote assets/pipeline.svg (${W}x${H})`);
