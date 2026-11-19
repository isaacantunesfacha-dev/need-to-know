/**
 * Simulated org for the evaluator (Module 4). Pure data plus two ports that
 * answer from it with literal booleans and exact field maps. Never I/O.
 */
import type { AccessPort, SourcePort } from "../retrieval/types.ts";

export interface WorldUser {
  readonly id: string;
  /** "View All Data": sees every record of a private object. */
  readonly viewAll: boolean;
  readonly readableObjects: ReadonlySet<string>;
  /** object -> fields the user may read. A field not listed is hidden. */
  readonly fieldGrants: Readonly<Record<string, ReadonlySet<string>>>;
}

export interface WorldObject {
  readonly name: string;
  readonly keyPrefix: string;
  /** "private": only the owner, plus users flagged `viewAll`. */
  readonly sharing: "public" | "private";
}

export interface WorldRecord {
  readonly id: string;
  readonly object: string;
  readonly ownerId: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface World {
  readonly users: readonly WorldUser[];
  readonly objects: readonly WorldObject[];
  readonly records: readonly WorldRecord[];
}

export interface Faults {
  /** Source answers after a delay far beyond any eval timeout. */
  readonly slowRecordIds?: ReadonlySet<string>;
  readonly throwOnRecordIds?: ReadonlySet<string>;
  /** Source answers with one column more than requested. */
  readonly extraFieldOnRecordIds?: ReadonlySet<string>;
}

export const SLOW_SOURCE_MS = 400;
export const EXTRA_FIELD_NAME = "Secret__c";

const findUser = (world: World, id: string): WorldUser | undefined => world.users.find((user) => user.id === id);
const findRecord = (world: World, id: string): WorldRecord | undefined => world.records.find((record) => record.id === id);

export function accessPortFromWorld(world: World): AccessPort {
  return {
    entityReadable: async (userId, objectName) => findUser(world, userId)?.readableObjects.has(objectName) === true,
    fieldsAccessible: async (userId, objectName, fields) => {
      const granted = findUser(world, userId)?.fieldGrants[objectName];
      return Object.fromEntries(fields.map((field) => [field, granted?.has(field) === true]));
    },
    recordReadable: async (userId, recordId) => {
      const user = findUser(world, userId);
      const record = findRecord(world, recordId);
      if (user === undefined || record === undefined) return false;
      const object = world.objects.find((candidate) => candidate.name === record.object);
      if (object === undefined) return false;
      return object.sharing === "public" || user.viewAll || record.ownerId === user.id;
    },
    recordBelongsTo: async (objectName, recordId) => {
      const record = findRecord(world, recordId);
      const object = world.objects.find((candidate) => candidate.name === objectName);
      return record !== undefined && object !== undefined && record.object === objectName && recordId.startsWith(object.keyPrefix);
    },
  };
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function sourcePortFromWorld(world: World, faults: Faults = {}): SourcePort {
  return {
    fetchFields: async (objectName, recordId, fields, signal) => {
      if (faults.throwOnRecordIds?.has(recordId) === true) throw new Error("source down");
      if (faults.slowRecordIds?.has(recordId) === true) await waitOrAbort(SLOW_SOURCE_MS, signal);
      const record = findRecord(world, recordId);
      if (record === undefined || record.object !== objectName) throw new Error("not found");
      const values: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field, record.values[field] ?? null]));
      if (faults.extraFieldOnRecordIds?.has(recordId) === true) values[EXTRA_FIELD_NAME] = "leak";
      return values;
    },
  };
}
