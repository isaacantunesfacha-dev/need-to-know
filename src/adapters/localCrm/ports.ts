/**
 * The project's ports, answered by the local reference CRM.
 *
 * Same answer shapes the Salesforce adapters give, measured on the org:
 *   unknown user            -> throws          (org: INVALID_CROSS_REFERENCE_KEY)
 *   unknown object          -> undefined       (no EntityDefinition row)
 *   field the CRM lacks     -> key left out    (no FieldDefinition row)
 *   live read of such field -> throws          (SOQL error)
 * so verifyAccess and retrieval reach the same detail on both backends.
 */
import type { EditAccessPort, TaskDraft, TaskWriterPort } from "../../approval/harness.ts";
import type { HygieneLedger, IngestSourcePort } from "../../ingest/ingestRecord.ts";
import type { AccessPort, SourcePort } from "../../retrieval/types.ts";
import { isApiName, isFieldList, isSalesforceId } from "../../retrieval/validate.ts";
import { type LocalCrm, newId } from "./db.ts";

type Row = Record<string, unknown>;

function guard(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("aborted");
}

function knownUser(crm: LocalCrm, userId: string): Row {
  if (!isSalesforceId(userId)) throw new Error("invalid user id");
  const user = crm.db.prepare("SELECT id, view_all, modify_all FROM users WHERE id = ?").get(userId);
  if (user === undefined) throw new Error("unknown user");
  return user;
}

function objectRow(crm: LocalCrm, objectName: string): Row | undefined {
  if (!isApiName(objectName)) throw new Error("invalid api name");
  return crm.db.prepare("SELECT name, key_prefix, sharing FROM objects WHERE name = ?").get(objectName);
}

function recordRow(crm: LocalCrm, recordId: string): Row | undefined {
  if (!isSalesforceId(recordId)) throw new Error("invalid record id");
  return crm.db.prepare("SELECT id, object, owner_id, values_json, system_modstamp FROM records WHERE id = ?").get(recordId);
}

function shareFor(crm: LocalCrm, recordId: string, userId: string): string | undefined {
  const row = crm.db.prepare("SELECT access FROM record_shares WHERE record_id = ? AND user_id = ?").get(recordId, userId);
  return row === undefined ? undefined : String(row["access"]);
}

function fieldValues(row: Row, fields: readonly string[], crm: LocalCrm): Record<string, unknown> {
  const object = String(row["object"]);
  const defined = new Set(
    crm.db.prepare("SELECT name FROM fields WHERE object = ?").all(object).map((r) => String(r["name"]).toLowerCase()),
  );
  if (!fields.every((field) => defined.has(field.toLowerCase()))) throw new Error("no such field");
  const stored = JSON.parse(String(row["values_json"])) as Record<string, unknown>;
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const key = Object.keys(stored).find((k) => k.toLowerCase() === field.toLowerCase());
    values[field] = key === undefined ? null : stored[key] ?? null;
  }
  return values;
}

export function localAccessPort(crm: LocalCrm): AccessPort {
  return {
    async entityReadable(userId, objectName, signal) {
      guard(signal);
      knownUser(crm, userId);
      if (objectRow(crm, objectName) === undefined) return undefined;
      const perm = crm.db.prepare("SELECT can_read FROM object_perms WHERE user_id = ? AND object = ?").get(userId, objectName);
      return perm?.["can_read"] === 1;
    },

    async fieldsAccessible(userId, objectName, fields, signal) {
      guard(signal);
      knownUser(crm, userId);
      if (!isFieldList(fields)) throw new Error("invalid field list");
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (objectRow(crm, objectName) === undefined) return result;
      const lookup = crm.db.prepare(
        "SELECT f.name AS name, p.readable AS readable FROM fields f LEFT JOIN field_perms p ON p.object = f.object AND p.field = f.name AND p.user_id = ? WHERE f.object = ? AND lower(f.name) = lower(?)",
      );
      for (const field of fields) {
        const rows = lookup.all(userId, objectName, field);
        // Undefined field or ambiguous answer: left out, denied upstream as unreadable.
        if (rows.length !== 1) continue;
        result[field] = rows[0]?.["readable"] === 1;
      }
      return result;
    },

    async recordReadable(userId, recordId, signal) {
      guard(signal);
      const user = knownUser(crm, userId);
      const record = recordRow(crm, recordId);
      if (record === undefined) return undefined;
      const object = objectRow(crm, String(record["object"]));
      if (object === undefined) return undefined;
      return (
        user["view_all"] === 1 ||
        user["modify_all"] === 1 ||
        record["owner_id"] === userId ||
        object["sharing"] !== "private" ||
        shareFor(crm, recordId, userId) !== undefined
      );
    },

    async recordBelongsTo(objectName, recordId, signal) {
      guard(signal);
      if (!isSalesforceId(recordId)) throw new Error("invalid record id");
      const object = objectRow(crm, objectName);
      const prefix = object?.["key_prefix"];
      return typeof prefix === "string" && recordId.startsWith(prefix);
    },
  };
}

/** Live read of the declared fields. Text never comes from the index. */
export function localSourcePort(crm: LocalCrm): SourcePort {
  return {
    async fetchFields(objectName, recordId, fields, signal) {
      guard(signal);
      if (!isApiName(objectName) || !isFieldList(fields)) throw new Error("invalid source request");
      const record = recordRow(crm, recordId);
      if (record === undefined || String(record["object"]).toLowerCase() !== objectName.toLowerCase()) {
        throw new Error("record not returned");
      }
      return fieldValues(record, fields, crm);
    },
  };
}

export function localIngestSource(crm: LocalCrm): IngestSourcePort {
  return {
    async readSnapshot(objectName, recordId, fields, signal) {
      guard(signal);
      if (!isApiName(objectName) || !isFieldList(fields)) throw new Error("invalid snapshot request");
      if (fields.some((field) => ["id", "systemmodstamp"].includes(field.toLowerCase()))) {
        throw new Error("Id and SystemModstamp are metadata, not indexable fields");
      }
      const record = recordRow(crm, recordId);
      if (record === undefined || String(record["object"]).toLowerCase() !== objectName.toLowerCase()) {
        throw new Error("record not returned");
      }
      return { values: fieldValues(record, fields, crm), systemModstamp: record["system_modstamp"] };
    },
  };
}

/** Hygiene ledger stored with the CRM. Only an "approved" row counts. */
export function localHygieneLedger(crm: LocalCrm): HygieneLedger {
  return {
    async approvalFor(tenantId, objectName, recordId, signal) {
      guard(signal);
      const rows = crm.db
        .prepare(
          "SELECT status, audited_by, audited_at FROM hygiene_approvals WHERE tenant_id = ? AND object = ? AND record_id = ?",
        )
        .all(tenantId, objectName, recordId);
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row === undefined || row["status"] !== "approved") return undefined;
      return { status: "approved", auditedBy: row["audited_by"], auditedAt: row["audited_at"] };
    },
  };
}

export function localEditAccess(crm: LocalCrm): EditAccessPort {
  return {
    async recordEditable(userId, recordId, signal) {
      guard(signal);
      const user = knownUser(crm, userId);
      const record = recordRow(crm, recordId);
      if (record === undefined) return undefined;
      const object = objectRow(crm, String(record["object"]));
      if (object === undefined) return undefined;
      if (user["modify_all"] === 1) return true;
      const perm = crm.db.prepare("SELECT can_edit FROM object_perms WHERE user_id = ? AND object = ?").get(userId, String(object["name"]));
      if (perm?.["can_edit"] !== 1) return false;
      return (
        record["owner_id"] === userId || object["sharing"] === "public_read_write" || shareFor(crm, recordId, userId) === "edit"
      );
    },
  };
}

const TAG = /^#[A-Za-z0-9]{1,12}$/;

/** The only write in the local backend, reached only through the approval harness. */
export function localTaskWriter(crm: LocalCrm, clock: () => string = () => new Date().toISOString()): TaskWriterPort {
  return {
    async findOpenTask(whatId, requestTag, signal) {
      guard(signal);
      if (!isSalesforceId(whatId) || !TAG.test(requestTag)) throw new Error("invalid task lookup");
      const rows = crm.db
        .prepare("SELECT id, subject FROM tasks WHERE what_id = ? AND is_closed = 0")
        .all(whatId)
        .filter((row) => String(row["subject"]).endsWith(requestTag));
      if (rows.length > 1) throw new Error("ambiguous: more than one open task for this request");
      const id = rows[0]?.["id"];
      return isSalesforceId(id) ? id : undefined;
    },
    async createTask(draft: TaskDraft, signal) {
      guard(signal);
      if (!isSalesforceId(draft.WhatId) || !isSalesforceId(draft.OwnerId)) throw new Error("invalid task draft");
      const id = newId("00T");
      crm.db
        .prepare(
          "INSERT INTO tasks (id, what_id, owner_id, subject, description, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, draft.WhatId, draft.OwnerId, draft.Subject, draft.Description, draft.Status, draft.Priority, clock());
      return id;
    },
  };
}
