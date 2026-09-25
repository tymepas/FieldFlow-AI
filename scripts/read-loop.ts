/**
 * Read-only loop: Notion read → weather → normalized weather → decision → console.
 * Performs NO writes.
 *
 *   npx tsx scripts/read-loop.ts
 */
import { readActivities } from "../src/integrations/notion.ts";
import { decide } from "../src/decision/engine.ts";
import { MockWeatherProvider } from "../src/weather/mock.ts";

const weather = new MockWeatherProvider();
const activities = await readActivities();
console.log(`notion.query.create → ${activities.length} activities loaded\n`);

for (const a of activities) {
  const w = await weather.getWeather(a.location, a.date, a.start_time);
  const d = decide(a, w);
  console.log(`${a.activity_id}  ${a.activity_name} (${a.activity_type}, ${a.location} ${a.date} ${a.start_time})`);
  console.log(`  weather[${w.source}]: ${w.condition}, rain ${w.precipitation_mm_per_hour} mm/h, wind ${w.wind_speed_m_per_s} m/s, ${w.temperature_c} °C`);
  console.log(`  decision: ${d.decision} — ${d.reason}\n`);
}
