/**
 * Run the agent once from the command line and print the /run response JSON.
 *
 *   npx tsx scripts/run-agent.ts "Review tomorrow's field operations and handle anything affected by weather."
 *   WEATHER_PROVIDER=mock npx tsx scripts/run-agent.ts "..."   (simulated weather demo)
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { runAgent } from "../src/agent/run.ts";

const request = process.argv[2] ?? "Review tomorrow's field operations and handle anything that could be affected by changing weather.";
const result = await runAgent(request);
const out = process.argv[3];
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, summary: result.summary, activities: result.activities }, null, 2));
console.log(`\nagent_summary:\n${result.agent_summary}`);
