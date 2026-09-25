/**
 * Seed test-data/activities.json into the Notion "Field Activities" table.
 * Idempotent: rows whose activity_id already exists are skipped.
 * With --reset, existing seeded rows are set back to status "planned" with their seed notes.
 *
 *   npx tsx scripts/seed-notion.ts [--reset]
 */
import { readFileSync } from "node:fs";
import { createActivity, getActivitiesTable, readActivities, updateActivity } from "../src/integrations/notion.ts";
import type { Activity } from "../src/types.ts";

const seed: Activity[] = JSON.parse(readFileSync(new URL("../test-data/activities.json", import.meta.url), "utf8"));
const reset = process.argv.includes("--reset");

const table = await getActivitiesTable();
console.log(`Table found: data source ${table.dataSourceId}`);
console.log("Schema:", table.schema);

const existing = new Map((await readActivities()).map((a) => [a.activity_id, a]));
for (const a of seed) {
  const row = existing.get(a.activity_id);
  if (!row) {
    const id = await createActivity(a);
    console.log(`created ${a.activity_id} → page ${id}`);
  } else if (reset) {
    await updateActivity(row.page_id!, { status: a.status, notes: a.notes });
    console.log(`reset   ${a.activity_id} → status ${a.status}`);
  } else {
    console.log(`skip    ${a.activity_id} (exists, status ${row.status})`);
  }
}
