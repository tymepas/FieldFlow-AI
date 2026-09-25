/**
 * Print the current Notion state of every activity (status + notes). Read-only.
 *
 *   npx tsx scripts/show-activities.ts
 */
import { readActivities } from "../src/integrations/notion.ts";

for (const a of await readActivities()) {
  console.log(`${a.activity_id}  ${a.status.padEnd(11)} ${a.activity_name} (${a.location} ${a.date} ${a.start_time})`);
  console.log(`  notes: ${a.notes.replace(/\n/g, "\n         ")}`);
}
