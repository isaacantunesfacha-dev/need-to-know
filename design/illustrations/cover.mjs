// Cover for the repo and LinkedIn: "It wasn't a hallucination. Your index leaked it."
// Same sketch language as the case-study illustrations. No invented numbers: the
// leaked value is redacted; the stats line uses measured results only.
// usage: node design/illustrations/cover.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const outDir = join(root, "assets/cover");
mkdirSync(outDir, { recursive: true });

const INK = "#111111";
const RED = "#E5322D";
const ORANGE = "#F07A1A";
const BLUE = "#2F6FDF";
const HAND = "Caveat, 'Bradley Hand', cursive";
const line = `fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;
const thin = `fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

function cover(W, H) {
  // Layout is designed on 1280x640 and scaled to the target box.
  const s = Math.min(W / 1280, H / 640);
  const ox = (W - 1280 * s) / 2;
  const oy = (H - 640 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs>
  <filter id="wobble" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency="0.032" numOctaves="2" seed="11" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="3"/>
  </filter>
  <marker id="ar" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="12" markerHeight="12" orient="auto">
    <path d="M1 1 L10 6 L1 11" fill="none" stroke="${RED}" stroke-width="2" stroke-linecap="round"/>
  </marker>
</defs>
<rect width="${W}" height="${H}" fill="#ffffff"/>
<g transform="translate(${ox} ${oy}) scale(${s})">
  <!-- headline -->
  <text x="72" y="118" fill="${INK}" font-family="${HAND}" font-size="76" font-weight="700">It wasn't a hallucination.</text>
  <text x="72" y="204" fill="${RED}" font-family="${HAND}" font-size="76" font-weight="700">Your index leaked it.</text>
  <path d="M74 132 C260 140 520 136 720 128" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round" filter="url(#wobble)"/>

  <g filter="url(#wobble)">
    <!-- the model, a plain box, mid-sentence -->
    <path d="M800 370 L1000 370 L1000 540 L800 540 Z" ${line} fill="#fff"/>
    <circle cx="860" cy="430" r="9" fill="${INK}"/><circle cx="940" cy="430" r="9" fill="${INK}"/>
    <!-- speech bubble with a redacted value -->
    <path d="M800 290 C780 250 820 226 880 222 L1150 214 C1210 212 1230 240 1226 270 C1222 300 1196 314 1150 316 L960 322 L900 362 L915 318 C850 316 812 306 800 290 Z" ${line} fill="#fff"/>
    <!-- the stamp tool in the creature's hands -->
    <path d="M736 478 L736 444" ${line}/>
    <circle cx="736" cy="434" r="11" ${line} fill="#fff"/>
    <path d="M714 478 L758 478 L758 500 L714 500 Z" ${line} fill="#fff"/>
  </g>
  <text x="846" y="276" fill="${INK}" font-family="${HAND}" font-size="34" font-weight="600">"Acme's revenue is</text>
  <rect x="1090" y="250" width="110" height="32" fill="${INK}" transform="rotate(-1.5 1145 266)"/>

  <!-- the creature, holding the stamp -->
  <g transform="translate(640 610)">
    <path d="M-14 -12 L-18 0 M14 -12 L16 0" ${line}/>
    <path d="M-18 0 L-28 2 M16 0 L26 2" ${thin}/>
    <path d="M-38 -40 C-46 -110 -30 -168 6 -170 C44 -172 52 -112 46 -52 C42 -18 22 -8 2 -8 C-22 -8 -34 -18 -38 -40 Z" fill="${INK}"/>
    <circle cx="-4" cy="-128" r="5.5" fill="#fff"/><circle cx="18" cy="-128" r="5.5" fill="#fff"/>
    <path d="M32 -104 L64 -126 L82 -138" ${thin}/>
    <path d="M30 -84 L66 -112 L84 -126" ${thin}/>
  </g>
  <!-- the stamp mark, over the model's mouth -->
  <g transform="rotate(-7 900 490)">
    <rect x="770" y="456" width="268" height="66" rx="8" fill="#fff" fill-opacity="0.9" stroke="${RED}" stroke-width="5"/>
    <text x="904" y="504" text-anchor="middle" fill="${RED}" font-family="${HAND}" font-size="38" font-weight="700">NEED TO KNOW</text>
  </g>

  <!-- left column: what it is, measured facts only -->
  <text x="72" y="300" fill="${INK}" font-family="${HAND}" font-size="40" font-weight="700">need-to-know</text>
  <text x="72" y="344" fill="${INK}" font-family="${HAND}" font-size="32">a fail-closed gate between</text>
  <text x="72" y="380" fill="${INK}" font-family="${HAND}" font-size="32">your CRM and any LLM</text>
  <text x="72" y="458" fill="${BLUE}" font-family="${HAND}" font-size="30" font-weight="600">permissions checked live, every question</text>
  <text x="72" y="496" fill="${BLUE}" font-family="${HAND}" font-size="30" font-weight="600">0 leaks in 36 permission scenarios</text>
  <text x="72" y="590" fill="${INK}" font-family="${HAND}" font-size="26" opacity="0.75">open source · Apache-2.0 · Salesforce + MCP</text>
</g>
</svg>`;
}

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
for (const [name, W, H] of [["cover-1280x640", 1280, 640], ["cover-1200x627", 1200, 627]]) {
  const svg = cover(W, H);
  writeFileSync(join(outDir, `${name}.svg`), svg);
  const html = join(outDir, `${name}.html`);
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&display=block" rel="stylesheet"><style>html,body{margin:0;background:#fff}svg{display:block}</style>${svg}`);
  execFileSync(BRAVE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    `--window-size=${W},${H}`, "--virtual-time-budget=6000", `--screenshot=${join(outDir, `${name}.png`)}`, `file://${html}`], { stdio: "ignore" });
  console.log("wrote", `assets/cover/${name}.png`);
}
