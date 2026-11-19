/**
 * Ground truth for leakage. Deliberately independent of src/retrieval/: it
 * reads the world definition and nothing else (no ports, no verifyAccess).
 */
import type { World } from "./world.ts";

export function canRead(world: World, userId: string, recordId: string, fields: readonly string[]): boolean {
  const user = world.users.find((u) => u.id === userId);
  const record = world.records.find((r) => r.id === recordId);
  if (user === undefined || record === undefined) return false;
  if (!user.readableObjects.has(record.object)) return false;
  const granted = user.fieldGrants[record.object];
  if (granted === undefined) return false;
  for (const field of fields) {
    if (!granted.has(field)) return false;
  }
  const object = world.objects.find((o) => o.name === record.object);
  if (object === undefined) return false;
  if (object.sharing === "private") return user.viewAll || record.ownerId === user.id;
  return true;
}
