import type { EditAccessPort, TaskDraft, TaskWriterPort } from "../approval/harness.ts";
import { isRecord, isSalesforceId } from "../retrieval/validate.ts";
import type { SalesforceConfig, SoqlRunner } from "./salesforceAccessPort.ts";

const TAG = /^#[A-Za-z0-9]{1,12}$/;

/** Live edit-access check (UserRecordAccess.HasEditAccess). Read-only. */
export function createEditAccessPort(soql: SoqlRunner): EditAccessPort {
  return {
    async recordEditable(userId, recordId, signal) {
      if (!isSalesforceId(userId) || !isSalesforceId(recordId)) throw new Error("invalid salesforce id");
      const rows = await soql(
        `SELECT RecordId, HasEditAccess FROM UserRecordAccess WHERE UserId = '${userId}' AND RecordId = '${recordId}'`,
        signal,
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      return row !== undefined && row["RecordId"] === recordId ? row["HasEditAccess"] : undefined;
    },
  };
}

/**
 * Task writer over REST. `findOpenTask` is a SOQL read; `createTask` is the
 * only write in the whole project. Same host and token rules as the access
 * adapter. Not exercised by live-check: writing to the org needs the owner's
 * explicit go-ahead.
 */
export function createTaskWriter(soql: SoqlRunner, config: SalesforceConfig): TaskWriterPort {
  const base = new URL(config.instanceUrl);
  if (base.protocol !== "https:" || !base.hostname.endsWith(".salesforce.com")) {
    throw new Error("instanceUrl must be an https *.salesforce.com host");
  }
  if (typeof config.accessToken !== "string" || config.accessToken.length === 0) throw new Error("accessToken is required");
  const apiVersion = config.apiVersion ?? "68.0";
  if (!/^\d{2}\.0$/.test(apiVersion)) throw new Error("invalid apiVersion");
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async findOpenTask(whatId, requestTag, signal) {
      if (!isSalesforceId(whatId) || !TAG.test(requestTag)) throw new Error("invalid task lookup");
      const rows = await soql(
        `SELECT Id FROM Task WHERE WhatId = '${whatId}' AND IsClosed = false AND Subject LIKE '%${requestTag}'`,
        signal,
      );
      if (rows.length > 1) throw new Error("ambiguous: more than one open task for this request");
      const id = rows[0]?.["Id"];
      return isSalesforceId(id) ? id : undefined;
    },
    async createTask(draft: TaskDraft, signal) {
      if (!isSalesforceId(draft.WhatId) || !isSalesforceId(draft.OwnerId)) throw new Error("invalid task draft");
      const response = await doFetch(new URL(`/services/data/v${apiVersion}/sobjects/Task`, base.origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
        redirect: "error",
        signal,
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error(`task create failed: ${response.status}`);
      const body: unknown = await response.json();
      const id = isRecord(body) && body["success"] === true ? body["id"] : undefined;
      if (!isSalesforceId(id)) throw new Error("unexpected task create response");
      return id;
    },
  };
}
