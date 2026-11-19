/**
 * Local reference CRM on node:sqlite. It stands in for the org behind the
 * same ports, so the whole pipeline runs offline and in CI.
 *
 * Permission model, kept as close to what live-check measured on the org as
 * a local model can be:
 *   object read/edit per user, field-level security per field, record
 *   sharing (org-wide default + owner + explicit share + "View All Data").
 * A user, object or field the CRM does not know is not "false": the ports
 * answer with an error or leave the key out, and the pipeline fails closed.
 *
 * Every statement is parameterized. Ids and names are validated again in
 * the ports before they reach SQL.
 */
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Sharing = "private" | "public_read" | "public_read_write";

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS org (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  view_all INTEGER NOT NULL DEFAULT 0 CHECK (view_all IN (0, 1)),
  modify_all INTEGER NOT NULL DEFAULT 0 CHECK (modify_all IN (0, 1))
);
CREATE TABLE IF NOT EXISTS objects (
  name TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL UNIQUE CHECK (length(key_prefix) = 3),
  sharing TEXT NOT NULL CHECK (sharing IN ('private', 'public_read', 'public_read_write'))
);
CREATE TABLE IF NOT EXISTS fields (
  object TEXT NOT NULL REFERENCES objects(name),
  name TEXT NOT NULL,
  PRIMARY KEY (object, name)
);
CREATE TABLE IF NOT EXISTS object_perms (
  user_id TEXT NOT NULL REFERENCES users(id),
  object TEXT NOT NULL REFERENCES objects(name),
  can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
  can_edit INTEGER NOT NULL CHECK (can_edit IN (0, 1)),
  PRIMARY KEY (user_id, object)
);
CREATE TABLE IF NOT EXISTS field_perms (
  user_id TEXT NOT NULL REFERENCES users(id),
  object TEXT NOT NULL,
  field TEXT NOT NULL,
  readable INTEGER NOT NULL CHECK (readable IN (0, 1)),
  PRIMARY KEY (user_id, object, field),
  FOREIGN KEY (object, field) REFERENCES fields(object, name)
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  object TEXT NOT NULL REFERENCES objects(name),
  owner_id TEXT NOT NULL REFERENCES users(id),
  values_json TEXT NOT NULL,
  system_modstamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS record_shares (
  record_id TEXT NOT NULL REFERENCES records(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  access TEXT NOT NULL CHECK (access IN ('read', 'edit')),
  PRIMARY KEY (record_id, user_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  what_id TEXT NOT NULL REFERENCES records(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hygiene_approvals (
  tenant_id TEXT NOT NULL,
  object TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(id),
  status TEXT NOT NULL CHECK (status IN ('approved', 'revoked')),
  audited_by TEXT NOT NULL REFERENCES users(id),
  audited_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, object, record_id)
);
-- Outbox: every insert or change to a record leaves a row here. Reindex reads it.
CREATE TABLE IF NOT EXISTS crm_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  object TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS records_ins AFTER INSERT ON records BEGIN
  INSERT INTO crm_changes (record_id, object, changed_at) VALUES (NEW.id, NEW.object, NEW.system_modstamp);
END;
CREATE TRIGGER IF NOT EXISTS records_upd AFTER UPDATE ON records BEGIN
  INSERT INTO crm_changes (record_id, object, changed_at) VALUES (NEW.id, NEW.object, NEW.system_modstamp);
END;
`;

export interface LocalCrm {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  close(): void;
}

export function openLocalCrm(path: string, tenantId?: string): LocalCrm {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const existing = db.prepare("SELECT id FROM org").all();
  let id: string;
  if (existing.length === 0) {
    if (tenantId === undefined) throw new Error("new local CRM needs a tenant id");
    db.prepare("INSERT INTO org (id) VALUES (?)").run(tenantId);
    id = tenantId;
  } else if (existing.length === 1 && typeof existing[0]?.["id"] === "string") {
    id = existing[0]["id"];
    if (tenantId !== undefined && tenantId !== id) throw new Error("local CRM belongs to another tenant");
  } else {
    throw new Error("local CRM has an ambiguous org row");
  }
  return { db, tenantId: id, close: () => db.close() };
}

// ------------------------------------------------------------ admin writes
// Used by the seed, the demo and tests. Never reachable from the MCP server.

export function addUser(crm: LocalCrm, user: { id: string; name: string; viewAll?: boolean; modifyAll?: boolean }): void {
  crm.db
    .prepare("INSERT INTO users (id, name, view_all, modify_all) VALUES (?, ?, ?, ?)")
    .run(user.id, user.name, user.viewAll === true ? 1 : 0, user.modifyAll === true ? 1 : 0);
}

export function addObject(crm: LocalCrm, object: { name: string; keyPrefix: string; sharing: Sharing; fields: readonly string[] }): void {
  crm.db.prepare("INSERT INTO objects (name, key_prefix, sharing) VALUES (?, ?, ?)").run(object.name, object.keyPrefix, object.sharing);
  const insert = crm.db.prepare("INSERT INTO fields (object, name) VALUES (?, ?)");
  for (const field of object.fields) insert.run(object.name, field);
}

export function grantObject(crm: LocalCrm, userId: string, object: string, perms: { read: boolean; edit: boolean }): void {
  crm.db
    .prepare("INSERT OR REPLACE INTO object_perms (user_id, object, can_read, can_edit) VALUES (?, ?, ?, ?)")
    .run(userId, object, perms.read ? 1 : 0, perms.edit ? 1 : 0);
}

/** Sets FLS for every field of the object: listed fields readable, the rest explicitly not. */
export function grantFields(crm: LocalCrm, userId: string, object: string, readable: readonly string[]): void {
  const all = crm.db.prepare("SELECT name FROM fields WHERE object = ?").all(object);
  const allowed = new Set(readable);
  const insert = crm.db.prepare("INSERT OR REPLACE INTO field_perms (user_id, object, field, readable) VALUES (?, ?, ?, ?)");
  for (const row of all) {
    const name = String(row["name"]);
    insert.run(userId, object, name, allowed.has(name) ? 1 : 0);
  }
}

export function shareRecord(crm: LocalCrm, recordId: string, userId: string, access: "read" | "edit"): void {
  crm.db.prepare("INSERT OR REPLACE INTO record_shares (record_id, user_id, access) VALUES (?, ?, ?)").run(recordId, userId, access);
}

export function insertRecord(
  crm: LocalCrm,
  record: { id: string; object: string; ownerId: string; values: Record<string, unknown>; modifiedAt?: string },
): void {
  crm.db
    .prepare("INSERT INTO records (id, object, owner_id, values_json, system_modstamp) VALUES (?, ?, ?, ?, ?)")
    .run(record.id, record.object, record.ownerId, JSON.stringify(record.values), record.modifiedAt ?? new Date().toISOString());
}

/** Merges values into a record and bumps SystemModstamp; the trigger writes the outbox row. */
export function updateRecord(crm: LocalCrm, recordId: string, values: Record<string, unknown>, modifiedAt = new Date().toISOString()): void {
  const row = crm.db.prepare("SELECT values_json FROM records WHERE id = ?").get(recordId);
  if (row === undefined) throw new Error("record not found");
  const merged = { ...(JSON.parse(String(row["values_json"])) as Record<string, unknown>), ...values };
  crm.db.prepare("UPDATE records SET values_json = ?, system_modstamp = ? WHERE id = ?").run(JSON.stringify(merged), modifiedAt, recordId);
}

/** A person records the hygiene audit. Without an "approved" row the record never enters the index. */
export function recordHygiene(
  crm: LocalCrm,
  entry: { object: string; recordId: string; status: "approved" | "revoked"; auditedBy: string; auditedAt?: string },
): void {
  crm.db
    .prepare(
      "INSERT OR REPLACE INTO hygiene_approvals (tenant_id, object, record_id, status, audited_by, audited_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(crm.tenantId, entry.object, entry.recordId, entry.status, entry.auditedBy, entry.auditedAt ?? new Date().toISOString());
}

/** 18-char id with the object's key prefix, like Salesforce ids look. */
export function newId(prefix: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(15);
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `${prefix}${body}`;
}
