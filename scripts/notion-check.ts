/**
 * Verify real Notion read + update through Swytchcode.
 *  1. Read all rows and compare every field against test-data/activities.json.
 *  2. Update one row's status/notes, read it back, then restore the original values.
 *
 *   npx tsx scripts/notion-check.ts [activity_id]   (default FA-104)
 */
import { readFileSync } from "node:fs";
import { ACTIVITY_FIELDS, readActivities, updateActivity } from "../src/integrations/notion.ts";
import type { Activity } from "../src/types.ts";

const seed: Activity[] = JSON.parse(readFileSync(new URL("../test-data/activities.json", import.meta.url), "utf8"));
const targetId = process.argv[2] ?? "FA-104";
let failures = 0;

// 1. Read
const rows = await readActivities();
console.log(`read: notion.query.create → ${rows.length} rows`);
for (const s of seed) {
  const row = rows.find((r) => r.activity_id === s.activity_id);
  if (!row) {
    console.log(`  MISSING ${s.activity_id}`);
    failures++;
    continue;
  }
  const diffs = ACTIVITY_FIELDS.filter((f) => row[f] !== s[f]);
  for (const f of diffs) console.log(`  MISMATCH ${s.activity_id}.${f}: ${JSON.stringify(row[f])} != ${JSON.stringify(s[f])}`);
  failures += diffs.length;
  if (!diffs.length) console.log(`  ok ${s.activity_id} (${row.page_id})`);
}

// 2. Update round-trip
const target = rows.find((r) => r.activity_id === targetId);
if (!target) throw new Error(`${targetId} not found`);
const original = { status: target.status, notes: target.notes };
const probe = { status: "flagged" as const, notes: `${original.notes}\n[notion-check ${new Date().toISOString()}] update test` };

await updateActivity(target.page_id!, probe);
const after = (await readActivities()).find((r) => r.activity_id === targetId)!;
const updated = after.status === probe.status && after.notes === probe.notes;
console.log(`update: notion.page.update ${targetId} → status "${after.status}", notes updated: ${after.notes === probe.notes} → ${updated ? "ok" : "FAIL"}`);
if (!updated) failures++;

await updateActivity(target.page_id!, original);
const restored = (await readActivities()).find((r) => r.activity_id === targetId)!;
const ok = restored.status === original.status && restored.notes === original.notes;
console.log(`restore: ${targetId} → status "${restored.status}" → ${ok ? "ok" : "FAIL"}`);
if (!ok) failures++;

console.log(failures ? `\nFAILED (${failures})` : "\nALL CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
