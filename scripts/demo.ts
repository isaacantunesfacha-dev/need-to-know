/**
 * End-to-end demo with no Salesforce org. Every step goes through the real
 * entry points: `pnpm local` for the CRM and the index, the MCP server over
 * stdio JSON-RPC for the model side, `pnpm approvals` for the human side.
 *
 *   pnpm demo                  real embedder + classifier (Ollama: nomic-embed-text, qwen2.5:7b)
 *   pnpm demo --embedder hash  simulated embedder (offline); the classifier still needs Ollama,
 *                              and without it retrieval fails closed (safety_unverified)
 *
 * Uses its own data dir (.gina/demo), wiped at start. The human approval
 * step is scripted here and printed as such.
 */
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { SEED_RECORDS, SEED_USERS } from "../src/adapters/localCrm/seed.ts";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, ".gina/demo");
const embedder = process.argv.includes("--embedder") && process.argv[process.argv.indexOf("--embedder") + 1] === "hash" ? "hash" : "ollama";
const env = { ...process.env, GINA_BACKEND: "local", GINA_LOCAL_DIR: dir, GINA_EMBEDDER: embedder, GINA_APPROVALS_FILE: resolve(dir, "approvals.json"), NODE_NO_WARNINGS: "1" };

const title = (s: string): void => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const run = (script: string, args: string[]): string =>
  execFileSync(process.execPath, [resolve(root, "scripts", script), ...args], { env, encoding: "utf8" });

type Json = Record<string, unknown>;

/** One MCP session as a given user. Identity is fixed at startup, never by a tool argument. */
async function mcpSession(userId: string) {
  const child = spawn(process.execPath, [resolve(root, "scripts/mcp-server.ts")], {
    env: { ...env, GINA_USER_ID: userId },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (msg: Json) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as Json;
    pending.get(Number(msg["id"]))?.(msg);
  });
  const stderr: string[] = [];
  child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));
  let next = 1;
  const rpc = (method: string, params: Json): Promise<Json> =>
    new Promise((resolveMsg, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}\n${stderr.join("")}`)), 90_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveMsg(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gina-demo", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    async call(name: string, args: Json): Promise<Json> {
      const msg = await rpc("tools/call", { name, arguments: args });
      const result = msg["result"] as Json | undefined;
      return (result?.["structuredContent"] as Json | undefined) ?? (msg as Json);
    },
    close: () => child.kill(),
  };
}

const QUESTION = "Which accounts are evaluating contact center automation with Service Cloud?";

rmSync(dir, { recursive: true, force: true });
title("1 · seed the local reference CRM (mirrors the org fixtures, synthetic ids)");
process.stdout.write(run("local.ts", ["seed", "--dir", dir]));

title(`2 · ingest everything through the contract (embedder: ${embedder})`);
process.stdout.write(run("local.ts", ["reindex", "--full", "--dir", dir, "--embedder", embedder]));

title("3 · admin asks over MCP (gina_retrieve)");
const admin = await mcpSession(SEED_USERS.admin);
const adminAnswer = await admin.call("gina_retrieve", { query: QUESTION, topK: 3 });
console.log(JSON.stringify({ status: adminAnswer["status"], chunks: adminAnswer["chunks"], denied: adminAnswer["denied"] }, null, 2));

title("4 · restricted user asks the same question");
const restricted = await mcpSession(SEED_USERS.restricted);
const restrictedAnswer = await restricted.call("gina_retrieve", { query: QUESTION, topK: 3 });
console.log(JSON.stringify({ status: restrictedAnswer["status"], reason: restrictedAnswer["reason"], chunks: restrictedAnswer["chunks"], denied: restrictedAnswer["denied"] }, null, 2));
title("4b · restricted user asks what their own fields can answer (chunk profiles)");
const visible = await restricted.call("gina_retrieve", { query: "Which accounts are in the apparel or hospitality industry?", topK: 3 });
console.log(JSON.stringify({ status: visible["status"], chunks: visible["chunks"], denied: visible["denied"] }, null, 2));
console.log("Step 4 stays empty on purpose: only Description mentions contact centers, and a hidden field must not decide what this user sees.");
restricted.close();

title("5 · the model proposes a follow-up Task (nothing is written yet)");
const firstChunk = (adminAnswer["chunks"] as Json[] | undefined)?.[0];
if (firstChunk === undefined) {
  console.log("no chunk served to admin; stopping (see the denied list above)");
  admin.close();
  process.exit(1);
}
const proposal = await admin.call("gina_propose_owner_task", {
  retrievalId: adminAnswer["retrievalId"],
  whatId: firstChunk["recordId"],
  subject: "Book a Service Cloud discovery call",
  description: "Customer is evaluating case deflection; propose a 30-minute discovery.",
  sourceChunkIds: [firstChunk["chunkId"]],
});
console.log(JSON.stringify(proposal, null, 2));
const requestId = String(proposal["requestId"]);

title("6 · human channel (scripted for the demo): show, then approve with the hash just read");
const shown = run("approvals.ts", ["show", requestId]);
process.stdout.write(shown);
const hash = /hash\s+([a-f0-9]{64})/.exec(shown)?.[1] ?? "";
title("6a · the restricted user tries to approve (no edit access on the Account)");
process.stdout.write(run("approvals.ts", ["approve", requestId, "--as", SEED_USERS.restricted, "--hash", hash]).toString());
try {
  process.stdout.write(run("approvals.ts", ["execute", requestId]));
} catch (error) {
  process.stdout.write(String((error as { stdout?: string }).stdout ?? error));
}

title("6b · a new proposal, approved by the admin it was made for, then executed");
const second = await admin.call("gina_propose_owner_task", {
  retrievalId: adminAnswer["retrievalId"],
  whatId: firstChunk["recordId"],
  subject: "Send the Agentforce case-deflection one-pager",
  description: "Follow-up material for the contact center evaluation.",
  sourceChunkIds: [firstChunk["chunkId"]],
});
admin.close();
const secondId = String(second["requestId"]);
const secondHash = /hash\s+([a-f0-9]{64})/.exec(run("approvals.ts", ["show", secondId]))?.[1] ?? "";
process.stdout.write(run("approvals.ts", ["approve", secondId, "--as", SEED_USERS.admin, "--hash", secondHash]));
process.stdout.write(run("approvals.ts", ["execute", secondId]));
title("6c · executing the same request again creates no duplicate");
try {
  process.stdout.write(run("approvals.ts", ["execute", secondId]));
} catch (error) {
  process.stdout.write(String((error as { stdout?: string }).stdout ?? error));
}

title("7 · result in the local CRM");
process.stdout.write(run("local.ts", ["tasks", "--dir", dir]) || "(no task was created)\n");

title("8 · poisoned record: still quarantined after reindex");
console.log(`Omega Logistics (${SEED_RECORDS.poisoned}) carries "Ignore all previous instructions…" and never entered the index (step 2).`);
