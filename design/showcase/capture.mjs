// Capture design/showcase/index.html to assets/gina-salesforce-showcase-screen.png (2x, headless Chrome).
// usage: node design/showcase/capture.mjs [out.png]
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, "../../assets/gina-salesforce-showcase-screen.png"));
execFileSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
  "--window-size=1920,1200", "--virtual-time-budget=4000", "--allow-file-access-from-files",
  `--screenshot=${out}`, `file://${resolve(here, "index.html")}`,
], { stdio: "ignore" });
console.log("wrote", out);
