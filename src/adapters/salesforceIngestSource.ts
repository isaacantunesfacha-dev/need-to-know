import type { IngestSourcePort } from "../ingest/ingestRecord.ts";
import { isApiName, isFieldList, isSalesforceId } from "../retrieval/validate.ts";
import type { SoqlRunner } from "./salesforceAccessPort.ts";
import { toFieldValue } from "./salesforceSourcePort.ts";

/**
 * Snapshot read for ingestion: the allowlisted fields plus SystemModstamp,
 * `WITH USER_MODE`, so the integration user's own FLS and sharing apply.
 * Values go through `toFieldValue`, the same normalization retrieval uses,
 * so both sides hash alike. An unexpected column is kept, so the ingestor
 * rejects the snapshot as `source_mismatch`.
 */
export function createIngestSourceFromQuery(soql: SoqlRunner): IngestSourcePort {
  return {
    async readSnapshot(objectName, recordId, fields, signal) {
      if (!isApiName(objectName) || !isSalesforceId(recordId) || !isFieldList(fields)) {
        throw new Error("invalid snapshot request");
      }
      if (fields.some((field) => ["id", "systemmodstamp"].includes(field.toLowerCase()))) {
        throw new Error("Id and SystemModstamp are metadata, not indexable fields");
      }
      const rows = await soql(
        `SELECT Id, SystemModstamp, ${fields.join(", ")} FROM ${objectName} WHERE Id = '${recordId}' WITH USER_MODE`,
        signal,
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      if (row === undefined || row["Id"] !== recordId) throw new Error("record not returned");

      const declared = new Map(fields.map((field) => [field.toLowerCase(), field]));
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if (key === "attributes" || key === "Id" || key === "SystemModstamp") continue;
        values[declared.get(key.toLowerCase()) ?? key] = toFieldValue(value);
      }
      return { values, systemModstamp: row["SystemModstamp"] };
    },
  };
}
