/**
 * The human approval channel. The model never runs this; a person does.
 *
 *   pnpm approvals list
 *   pnpm approvals show <requestId>
 *   pnpm approvals approve <requestId> --as <yourUserId> --hash <payloadHash>
 *   pnpm approvals reject  <requestId> --as <yourUserId> --hash <payloadHash>
 *   pnpm approvals preview <requestId>                 # the Task that would be created; writes nothing
 *   pnpm approvals execute <requestId>                 # local backend (default): Task in the local CRM
 *   GINA_BACKEND=salesforce pnpm approvals execute <requestId> --live-write
 *                                                      # creates the Task in the org (REST token in .env.local)
 *
 * `approve` requires the payload hash printed by `show`: you approve exactly
 * what you read. Against the org, `execute` without --live-write refuses:
 * writing to the org needs a deliberate flag every time.
 */
import { resolve } from "node:path";
import { openLocalBackend } from "../src/adapters/localBackend.ts";
import { createRestSoqlRunner } from "../src/adapters/salesforceAccessPort.ts";
import { createEditAccessPort, createTaskWriter } from "../src/adapters/salesforceApproval.ts";
import { createApprovalHarness, GINA_TASK_PREFIX, requestTag } from "../src/approval/harness.ts";
import { createFileApprovalStore, listApprovals } from "../src/approval/fileStore.ts";

const root = resolve(import.meta.dirname, "..");
const backendKind = process.env["GINA_BACKEND"] === "salesforce" ? "salesforce" : "local";
const approvalsPath = resolve(
  root,
  process.env["GINA_APPROVALS_FILE"] ?? (backendKind === "local" ? ".gina/local/approvals.json" : ".gina/approvals.json"),
);
const store = createFileApprovalStore(approvalsPath);
const harness = createApprovalHarness({
  store,
  log: (e) => console.error(JSON.stringify(e)),
  serviceUserId: process.env["GINA_SERVICE_USER_ID"] ?? "000000000000000AAA",
});

const [command, id] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const done = (code: number): never => process.exit(code);

switch (command) {
  case "list": {
    for (const r of listApprovals(approvalsPath)) {
      console.log(`${r.id}  ${r.status.padEnd(9)}  ${r.action.whatId}  ${r.action.subject}`);
    }
    break;
  }
  case "show": {
    const r = id === undefined ? undefined : await store.get(id);
    if (r === undefined) done(1);
    else {
      console.log(`request     ${r.id}\nstatus      ${r.status}\nrequested   by ${r.requesterId} at ${new Date(r.createdAt).toISOString()}`);
      console.log(`expires     ${new Date(r.expiresAt).toISOString()}\nrecord      ${r.action.whatId}`);
      console.log(`subject     ${r.action.subject}\ndescription ${r.action.description || "(empty)"}`);
      console.log(`sources     ${r.action.sourceChunkIds.join(", ")}\nhash        ${r.payloadHash}`);
    }
    break;
  }
  case "approve":
  case "reject": {
    const outcome = await harness.decide(id, {
      approverId: flag("as"),
      verdict: command === "approve" ? "approve" : "reject",
      payloadHash: flag("hash"),
    });
    console.log(outcome.ok ? `${command}d ${outcome.value.id}` : `refused: ${outcome.detail}`);
    done(outcome.ok ? 0 : 1);
    break;
  }
  case "preview": {
    const r = id === undefined ? undefined : await store.get(id);
    if (r === undefined) done(1);
    else {
      console.log(JSON.stringify({
        WhatId: r.action.whatId,
        OwnerId: r.approverId ?? "(set at approval)",
        Subject: `${GINA_TASK_PREFIX} ${r.action.subject} ${requestTag(r.id)}`.slice(0, 255),
        Description: r.action.description,
        Status: "Not Started",
        Priority: "Normal",
      }, null, 2));
    }
    break;
  }
  case "execute": {
    if (backendKind === "local") {
      const backend = await openLocalBackend({ dir: resolve(root, process.env["GINA_LOCAL_DIR"] ?? ".gina/local"), embedder: "hash" });
      const outcome = await harness.execute(id, { edit: backend.edit, writer: backend.writer });
      console.log(outcome.ok ? `executed: local task ${outcome.value.taskId}${outcome.value.reused ? " (existing, reused)" : ""}` : `refused: ${outcome.detail}`);
      backend.close();
      done(outcome.ok ? 0 : 1);
      break;
    }
    if (!process.argv.includes("--live-write")) {
      console.error("refused: execute writes a Task to the org. Re-run with --live-write if that is what you want.");
      done(1);
    }
    process.loadEnvFile(resolve(root, ".env.local"));
    const instanceUrl = process.env["SALESFORCE_INSTANCE_URL"] ?? "";
    const accessToken = process.env["SALESFORCE_ACCESS_TOKEN"] ?? "";
    const soql = createRestSoqlRunner({ instanceUrl, accessToken });
    const outcome = await harness.execute(id, {
      edit: createEditAccessPort(soql),
      writer: createTaskWriter(soql, { instanceUrl, accessToken }),
    });
    console.log(outcome.ok ? `executed: task ${outcome.value.taskId}${outcome.value.reused ? " (existing, reused)" : ""}` : `refused: ${outcome.detail}`);
    done(outcome.ok ? 0 : 1);
    break;
  }
  default:
    console.error("usage: pnpm approvals list | show <id> | approve|reject <id> --as <userId> --hash <hash> | preview <id> | execute <id> [--live-write with GINA_BACKEND=salesforce]");
    done(2);
}
