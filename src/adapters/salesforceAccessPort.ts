import type { AccessPort } from "../retrieval/types.ts";
import { isApiName, isFieldList, isRecord, isSalesforceId } from "../retrieval/validate.ts";

export interface SalesforceConfig {
  readonly instanceUrl: string;
  readonly accessToken: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Read-only Salesforce adapter for the access checks.
 * Every failure throws, and `verifyAccess` turns a throw into a deny.
 * The token is only ever sent to an https *.salesforce.com host.
 *
 * Note: reading UserRecordAccess for another user needs an integration user
 * with "View All Data" (or equivalent). Without it the query fails => deny.
 */
export function createSalesforceAccessPort(config: SalesforceConfig): AccessPort {
  return createAccessPortFromQuery(createRestSoqlRunner(config));
}

/** SOQL over REST. Validates the host before the token is ever used. */
export function createRestSoqlRunner(config: SalesforceConfig): SoqlRunner {
  const base = new URL(config.instanceUrl);
  if (base.protocol !== "https:" || !base.hostname.endsWith(".salesforce.com")) {
    throw new Error("instanceUrl must be an https *.salesforce.com host");
  }
  if (base.username !== "" || base.password !== "") {
    throw new Error("instanceUrl must not carry credentials");
  }
  if (typeof config.accessToken !== "string" || config.accessToken.length === 0) {
    throw new Error("accessToken is required");
  }
  const apiVersion = config.apiVersion ?? "68.0";
  if (!/^\d{2}\.0$/.test(apiVersion)) throw new Error("invalid apiVersion");
  const doFetch = config.fetchImpl ?? fetch;

  async function soql(query: string, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const url = new URL(`/services/data/v${apiVersion}/query`, base.origin);
    url.searchParams.set("q", query);
    const response = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(`salesforce query failed: ${response.status}`);
    const body: unknown = await response.json();
    // A partial page (done !== true) is an incomplete answer, so it is an error.
    if (!isRecord(body) || body["done"] !== true || !Array.isArray(body["records"])) {
      throw new Error("unexpected salesforce response shape");
    }
    const rows: unknown[] = body["records"];
    if (!rows.every(isRecord)) throw new Error("unexpected salesforce record shape");
    return rows;
  }

  return soql;
}

/** Runs one SOQL query and returns its complete row set, or throws. */
export type SoqlRunner = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly Record<string, unknown>[]>;

/** Builds the access port on top of any SOQL transport (REST, sf CLI, fake). */
export function createAccessPortFromQuery(soql: SoqlRunner): AccessPort {
  // Inputs are validated again here: this file is the only place that builds SOQL.
  function assertIds(...ids: readonly string[]): void {
    if (!ids.every(isSalesforceId)) throw new Error("invalid salesforce id");
  }
  function assertNames(...names: readonly string[]): void {
    if (!names.every(isApiName)) throw new Error("invalid api name");
  }
  function sameDurableId(row: Record<string, unknown>, expected: string): boolean {
    const actual = row["DurableId"];
    return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
  }

  const sameName = (value: unknown, expected: string): boolean =>
    typeof value === "string" && value.toLowerCase() === expected.toLowerCase();

  /**
   * The org's own key for an object. Standard objects use the API name
   * ("Account"); custom objects use an internal id ("01I..."). Access rows are
   * keyed by this value, so it is always read from the org, never assumed.
   */
  async function entityDurableId(objectName: string, signal: AbortSignal): Promise<string | undefined> {
    const rows = await soql(
      `SELECT QualifiedApiName, DurableId FROM EntityDefinition WHERE QualifiedApiName = '${objectName}'`,
      signal,
    );
    const row = rows.length === 1 ? rows[0] : undefined;
    const durableId = row?.["DurableId"];
    return row !== undefined &&
      sameName(row["QualifiedApiName"], objectName) &&
      typeof durableId === "string" &&
      /^[A-Za-z0-9_]{1,80}$/.test(durableId)
      ? durableId
      : undefined;
  }

  return {
    async entityReadable(userId, objectName, signal) {
      assertIds(userId);
      assertNames(objectName);
      const entityId = await entityDurableId(objectName, signal);
      if (entityId === undefined) return undefined;
      const durableId = `${entityId}.${userId}`;
      const rows = await soql(
        `SELECT DurableId, IsReadable FROM UserEntityAccess WHERE DurableId = '${durableId}'`,
        signal,
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      return row !== undefined && sameDurableId(row, durableId) ? row["IsReadable"] : undefined;
    },

    async fieldsAccessible(userId, objectName, fields, signal) {
      assertIds(userId);
      assertNames(objectName);
      if (!isFieldList(fields)) throw new Error("invalid field list");
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      // Field keys also come from the org: "Account.Name" or "01I....00N...".
      const definitions = await soql(
        `SELECT QualifiedApiName, DurableId FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' AND QualifiedApiName IN (${fields
          .map((field) => `'${field}'`)
          .join(", ")})`,
        signal,
      );
      const known = new Map<string, string>();
      for (const field of fields) {
        const matches = definitions.filter((row) => sameName(row["QualifiedApiName"], field));
        const durableId = matches.length === 1 ? matches[0]?.["DurableId"] : undefined;
        if (typeof durableId === "string" && /^[A-Za-z0-9_]{1,80}\.[A-Za-z0-9_]{1,80}$/.test(durableId)) {
          known.set(field, `${durableId}.${userId}`);
        }
      }
      // A field the org does not define is left out => denied upstream.
      if (known.size === 0) return result;
      const rows = await soql(
        `SELECT DurableId, IsAccessible FROM UserFieldAccess WHERE DurableId IN (${[...known.values()]
          .map((id) => `'${id}'`)
          .join(", ")})`,
        signal,
      );
      fields.forEach((field) => {
        const expected = known.get(field);
        if (expected === undefined) return;
        const matches = rows.filter((row) => sameDurableId(row, expected));
        // No row or an ambiguous answer leaves the field out => denied upstream.
        const only = matches.length === 1 ? matches[0] : undefined;
        if (only !== undefined) result[field] = only["IsAccessible"];
      });
      return result;
    },

    async recordReadable(userId, recordId, signal) {
      assertIds(userId, recordId);
      const rows = await soql(
        `SELECT RecordId, HasReadAccess FROM UserRecordAccess WHERE UserId = '${userId}' AND RecordId = '${recordId}'`,
        signal,
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      return row !== undefined && row["RecordId"] === recordId ? row["HasReadAccess"] : undefined;
    },

    async recordBelongsTo(objectName, recordId, signal) {
      assertIds(recordId);
      assertNames(objectName);
      const rows = await soql(
        `SELECT QualifiedApiName, KeyPrefix FROM EntityDefinition WHERE QualifiedApiName = '${objectName}'`,
        signal,
      );
      const row = rows.length === 1 ? rows[0] : undefined;
      const prefix = row?.["KeyPrefix"];
      return typeof prefix === "string" && prefix.length === 3 && recordId.startsWith(prefix);
    },
  };
}
