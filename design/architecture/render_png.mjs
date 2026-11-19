// Render an SVG to PNG with headless Chrome (local fonts available).
// usage: node render_png.mjs <in.svg> <out.png> <width> <height> [scale]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const [inp, out, w, h, scale = "2"] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "gina-svg-"));
const html = join(dir, "page.html");
writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#0F172A}</style>${readFileSync(resolve(inp), "utf8")}`);
execFileSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${scale}`,
  `--window-size=${w},${h}`, "--virtual-time-budget=3000", `--screenshot=${resolve(out)}`, `file://${html}`,
], { stdio: "inherit" });
console.log("wrote", out);
