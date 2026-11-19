/** The world and index policy the access scenarios run against. */
import type { IndexPolicy } from "../contract/vectorRecord.ts";
import type { World } from "./world.ts";

export const EVAL_TENANT = "00D000000000001AAA";
export const EVAL_MODEL = "eval-model-v1";
export const EVAL_AUDITOR = "005000000000009AAA";

export const USERS = {
  admin: "005000000000001AAA",
  restricted: "005000000000002AAA",
  stranger: "005000000000003AAA",
  /** Account read, Name only: the FLS-hidden-field case. */
  nameonly: "005000000000004AAA",
} as const;

export const RECORDS = {
  acme1: "001000000000001AAA",
  acme2: "001000000000002AAA",
  acme3: "001000000000003AAA",
  opp1: "006000000000001AAA",
  noteAdmin: "a00000000000001AAA",
  noteRestricted: "a00000000000002AAA",
} as const;

export const FIXTURE_WORLD: World = {
  users: [
    {
      id: USERS.admin,
      viewAll: true,
      readableObjects: new Set(["Account", "Opportunity", "Gina_Private_Note__c"]),
      fieldGrants: {
        Account: new Set(["Name", "Industry", "Phone"]),
        Opportunity: new Set(["Name"]),
        Gina_Private_Note__c: new Set(["Name"]),
      },
    },
    {
      id: USERS.restricted,
      viewAll: false,
      readableObjects: new Set(["Account", "Gina_Private_Note__c"]),
      fieldGrants: { Account: new Set(["Name", "Industry"]), Gina_Private_Note__c: new Set(["Name"]) },
    },
    { id: USERS.stranger, viewAll: false, readableObjects: new Set(), fieldGrants: {} },
    {
      id: USERS.nameonly,
      viewAll: false,
      readableObjects: new Set(["Account"]),
      fieldGrants: { Account: new Set(["Name"]) },
    },
  ],
  objects: [
    { name: "Account", keyPrefix: "001", sharing: "public" },
    { name: "Opportunity", keyPrefix: "006", sharing: "public" },
    { name: "Gina_Private_Note__c", keyPrefix: "a00", sharing: "private" },
  ],
  records: [
    { id: RECORDS.acme1, object: "Account", ownerId: USERS.admin, values: { Name: "Edge Communications", Industry: "Energy", Phone: "555-0101" } },
    { id: RECORDS.acme2, object: "Account", ownerId: USERS.admin, values: { Name: "Burlington Textiles", Industry: "Apparel", Phone: "555-0102" } },
    { id: RECORDS.acme3, object: "Account", ownerId: USERS.admin, values: { Name: "Pyramid Construction", Industry: "Construction", Phone: "555-0103" } },
    { id: RECORDS.opp1, object: "Opportunity", ownerId: USERS.admin, values: { Name: "Edge Renewal Q4" } },
    { id: RECORDS.noteAdmin, object: "Gina_Private_Note__c", ownerId: USERS.admin, values: { Name: "Admin private note" } },
    { id: RECORDS.noteRestricted, object: "Gina_Private_Note__c", ownerId: USERS.restricted, values: { Name: "Restricted own note" } },
  ],
};

export const FIXTURE_POLICY: IndexPolicy = {
  tenantId: EVAL_TENANT,
  acceptedEmbeddingModels: [EVAL_MODEL],
  fieldAllowlist: {
    Account: ["Name", "Industry"],
    Opportunity: ["Name"],
    Gina_Private_Note__c: ["Name"],
  },
};
