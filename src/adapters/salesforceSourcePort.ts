import type { SourcePort } from "../retrieval/types.ts";
import { isApiName, isFieldList, isRecord, isSalesforceId } from "../retrieval/validate.ts";
import type { SoqlRunner } from "./salesforceAccessPort.ts";

/**
 * One normalization for every Salesforce read (ingestion and retrieval), so
 * the same record always hashes the same. A related-record object is never
 * indexed as text: it becomes null.
 */
export function toFieldValue(value: unknown): unknown {
  return isRecord(value) && "attributes" in value ? null : value;
}

/**
 * Live read of the declared fields only. The SELECT list is built from the
 * fields fixed at ingestion, so an undeclared field is never even requested.
 *
 * `WITH USER_MODE` makes Salesforce enforce FLS and sharing for the running
 * user: a field that user cannot read fails the query (=> deny upstream).
 * With an integration user this is the integration user's view; checking the
 * END user's view natively requires per-user OAuth (open item, see docs).
 *
 * Every failure throws; any key besides the declared fields is passed
 * through so retrieval denies the row as `source_mismatch`.
 */
export function createSourcePortFromQuery(soql: SoqlRunner): SourcePort {
  return {
    async fetchFields(objectName, recordId, fields, signal) {
      if (!isApiName(objectName) || !isSalesforceId(recordId) || !isFieldList(fields)) {
        throw new Error("invalid source request");
      }
      const rows = await soql(
        `SELECT Id, ${fields.join(", ")} FROM ${objectName} WHERE Id = '${recordId}' WITH USER_MODE`,
        signal,
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row === undefined || row["Id"] !== recordId) throw new Error("record not returned");

      const declared = new Map(fields.map((field) => [field.toLowerCase(), field]));
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if (key === "attributes") continue;
        if (key === "Id" && !declared.has("id")) continue;
        // Unknown keys keep their own name, so the caller sees the extra field.
        values[declared.get(key.toLowerCase()) ?? key] = toFieldValue(value);
      }
      return values;
    },
  };
}
