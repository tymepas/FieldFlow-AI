/**
 * Live check: real OpenWeather forecast (via Swytchcode) → normalized weather → decision,
 * for every seed activity in test-data/activities.json. No Notion/Slack calls, no writes.
 *
 *   npx tsx scripts/weather-check.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { decide } from "../src/decision/engine.ts";
import { getWeatherProvider } from "../src/weather/index.ts";
import type { Activity } from "../src/types.ts";

const seed: Activity[] = JSON.parse(readFileSync(new URL("../test-data/activities.json", import.meta.url), "utf8"));
const weather = getWeatherProvider();
console.log(`weather provider: ${weather.name}\n`);

for (const a of seed) {
  const w = await weather.getWeather(a.location, a.date, a.start_time);
  const d = decide(a, w);
  console.log(`${a.activity_id} ${a.location} ${a.date} ${a.start_time} (${a.activity_type})`);
  console.log(`  [${w.source}] slot ${w.forecast_time}: ${w.condition}, rain ${w.precipitation_mm_per_hour.toFixed(2)} mm/h, wind ${w.wind_speed_m_per_s} m/s gust ${w.wind_gust_m_per_s ?? "-"} m/s, ${w.temperature_c} °C`);
  console.log(`  → ${d.decision}: ${d.reason}`);
}
