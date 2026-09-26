import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessConditions } from "../src/decision/engine.ts";
import { summarizeForecast } from "../src/weather/openweather.ts";
import { newRunState, runTool } from "../src/agent/tools.ts";
import { asksForNotion, asksForSlack } from "../src/agent/scope.ts";
import { Trace } from "../src/agent/trace.ts";
import { MockWeatherProvider } from "../src/weather/mock.ts";
import { normalizePlace, resolvePlace } from "../src/weather/places.ts";
import type { Activity, NormalizedWeather } from "../src/types.ts";

// Ad-hoc (untracked place/event) behaviour. Nothing here reaches Notion, Slack or Gmail:
// weather is the mock, and every Notion/Slack attempt below is expected to be refused by a
// guard before any integration is called.

const seed: Activity[] = JSON.parse(readFileSync(new URL("../test-data/activities.json", import.meta.url), "utf8"));
const HACKATHON_WEATHER = "I have a hackathon tomorrow in Gurgaon Sector 59. Please check the weather.";

function loaded(request: string) {
  const state = newRunState();
  for (const a of seed) state.activities.set(a.activity_id, { ...a, page_id: `page-${a.activity_id}` });
  state.activitiesRead = true;
  return { state, ctx: { state, trace: new Trace(), weather: new MockWeatherProvider(), request } };
}

const w = (x: Partial<NormalizedWeather>): NormalizedWeather => ({
  source: "mock", location: "X", forecast_time: "2026-09-27", condition: "clear sky",
  precipitation_mm_per_hour: 0, wind_speed_m_per_s: 3, wind_gust_m_per_s: null, temperature_c: 30, ...x,
});

test("ad-hoc assessment uses the same fixed thresholds", () => {
  assert.equal(assessConditions(w({})).level, "low");
  assert.equal(assessConditions(w({ precipitation_mm_per_hour: 2.5 })).level, "caution");
  assert.equal(assessConditions(w({ temperature_c: 40 })).level, "caution");
  assert.equal(assessConditions(w({ precipitation_mm_per_hour: 7.6 })).level, "significant");
  assert.equal(assessConditions(w({ wind_gust_m_per_s: 17.2 })).level, "significant");
  assert.match(assessConditions(w({ precipitation_mm_per_hour: 9 })).summary, /heavy rain 9\.0 mm\/h \(≥ 7\.6\)/);
});

test("forecast summary: local-date filter, worst case across the day, nearest slot for a time", () => {
  const off = 19800; // +05:30
  const at = (iso: string) => Date.parse(iso) / 1000;
  const slots = [
    { dt: at("2026-09-26T21:30:00Z"), main: { temp: 24 }, wind: { speed: 2, gust: 3 }, weather: [{ description: "clear sky" }] }, // 27th 03:00 local
    { dt: at("2026-09-27T06:30:00Z"), main: { temp: 31 }, wind: { speed: 6, gust: 9 }, rain: { "3h": 6 }, weather: [{ description: "light rain" }] }, // 27th 12:00
    { dt: at("2026-09-27T21:30:00Z"), main: { temp: 20 }, wind: { speed: 12 }, weather: [{ description: "windy" }] }, // 28th
  ];
  const day = summarizeForecast("openweather", "Gurgaon Sector 59", 28.4, 77.07, "Gurugram, IN", slots, off, "2026-09-27");
  assert.equal(day.slots, 2);
  assert.equal(day.worst.precipitation_mm_per_hour, 2);
  assert.equal(day.worst.wind_speed_m_per_s, 6, "the 28th's 12 m/s must not leak into the 27th");
  assert.equal(day.worst.temperature_c, 31);
  assert.equal(day.temperature_c_min, 24);
  const noon = summarizeForecast("openweather", "X", 28.4, 77.07, "A", slots, off, "2026-09-27", "11:00");
  assert.equal(noon.slots, 1);
  assert.equal(noon.worst.condition, "light rain");
  assert.throws(() => summarizeForecast("openweather", "X", 0, 0, "A", slots, off, "2026-10-05"), /No forecast available for 2026-10-05/);
});

test("intent detection for explicitly requested actions", () => {
  assert.equal(asksForSlack(HACKATHON_WEATHER), false);
  assert.equal(asksForNotion(HACKATHON_WEATHER), false);
  assert.equal(asksForSlack("check the weather and notify the team"), true);
  assert.equal(asksForNotion("check the weather and record the result in Notion"), true);
});

test("ad-hoc hackathon request: weather allowed, no fabricated activity, no unrequested Notion/Slack", async () => {
  const { state, ctx } = loaded(HACKATHON_WEATHER);
  // Still no proxy record and no broadening into a schedule review.
  await assert.rejects(runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-101"], requested_description: "hackathon", untracked_subjects: ["hackathon"] }, ctx), /not referenced by the request/);
  await assert.rejects(runTool("set_scope", { mode: "schedule_review", requested_description: "hackathon", untracked_subjects: ["hackathon"] }, ctx), /not a tracked record/);

  await runTool("set_scope", { mode: "adhoc", requested_description: "hackathon at Gurgaon Sector 59", untracked_subjects: ["hackathon", "Gurgaon Sector 59"] }, ctx);
  await assert.rejects(runTool("record_review_in_notion", { operational_note: "x" }, ctx), /Call get_location_weather first/);

  const out: any = await runTool("get_location_weather", { place: "Gurgaon Sector 59", latitude: 28.41, longitude: 77.07, date: "2026-09-27" }, ctx);
  assert.equal(out.assessment.level, "caution"); // mock: moderate rain 3.4 mm/h
  await assert.rejects(runTool("get_location_weather", { place: "again", latitude: 1, longitude: 1, date: "2026-09-27" }, ctx), /already called/);

  // Not asked for Notion or Slack -> refused before any integration call.
  await assert.rejects(runTool("record_review_in_notion", { operational_note: "x" }, ctx), /did not ask to record this in Notion/);
  await assert.rejects(runTool("post_team_update", { message: "x" }, ctx), /did not ask to update Slack/);
  // Tracked-activity tools stay closed in adhoc mode.
  for (const a of seed) {
    await assert.rejects(runTool("get_weather", { activity_id: a.activity_id }, ctx), /outside the declared scope \(adhoc\)/);
    await assert.rejects(runTool("update_activity", { activity_id: a.activity_id, explanation: "x" }, ctx), /outside the declared scope/);
    await assert.rejects(runTool("notify_team", { activity_id: a.activity_id, required_action: "x" }, ctx), /outside the declared scope/);
  }
  await assert.rejects(runTool("post_run_summary", { headline: "x" }, ctx), /post_run_summary is for tracked reviews/);

  assert.equal(state.updated.size, 0);
  assert.equal(state.notified.size, 0);
  assert.equal(state.adhoc.notionPage, undefined);
  assert.equal(state.adhoc.slackTs, undefined);
  const tools = ctx.trace.steps.map((s) => `${s.tool ?? s.type}:${s.action ?? ""}`);
  assert.deepEqual(tools, ["agent:set_scope", "mock_weather:area_forecast_simulated", "decision_engine:"]);
  // Directory coordinates win over the model's estimate, and their source is shown.
  assert.match(ctx.trace.steps[1].result!, /coordinates ≈28\.403, 77\.107 from FieldFlow's place directory \(OpenStreetMap node 2735984441\)/);
  assert.equal(state.adhoc.forecast!.latitude, 28.4030162);
});

test("ad-hoc input validation", async () => {
  const { ctx } = loaded("check the weather for my site visit in Noida tomorrow");
  await runTool("set_scope", { mode: "adhoc", requested_description: "site visit", untracked_subjects: ["site visit"] }, ctx);
  await assert.rejects(runTool("get_location_weather", { place: "X", latitude: 123, longitude: 77, date: "2026-09-27" }, ctx), /out of range/);
  await assert.rejects(runTool("get_location_weather", { place: "X", latitude: 28, longitude: 77, date: "tomorrow" }, ctx), /YYYY-MM-DD/);
  await assert.rejects(runTool("get_location_weather", { place: "X", latitude: 28, longitude: 77, date: "2026-09-27", time: "2pm" }, ctx), /HH:MM/);
});

test("ad-hoc tools are refused outside adhoc scope", async () => {
  const { ctx } = loaded("Review tomorrow's field operations and handle anything that could be affected by changing weather.");
  await runTool("set_scope", { mode: "schedule_review", date: "2026-09-27", requested_description: "tomorrow", untracked_subjects: [] }, ctx);
  await assert.rejects(runTool("get_location_weather", { place: "X", latitude: 28, longitude: 77, date: "2026-09-27" }, ctx), /only for adhoc requests/);
  await assert.rejects(runTool("post_team_update", { message: "x" }, ctx), /only for adhoc requests/);
});

test("place directory: Gurgaon Sector 59 variants resolve; bare 'sector 59' and unknown places do not", () => {
  for (const p of ["Gurgaon Sector 59", "gurgaon sector-59", "Sector 59, Gurugram", "Gurugram Sector 59, Haryana, India"]) {
    assert.equal(resolvePlace(p)?.name, "Gurgaon Sector 59", p);
  }
  assert.equal(normalizePlace("Sector-59, Gurugram"), "sector 59 gurgaon");
  assert.equal(resolvePlace("Sector 59"), undefined, "ambiguous: Noida also has a Sector 59");
  assert.equal(resolvePlace("Rohini")?.name, "Rohini, Delhi");
  assert.equal(resolvePlace("Some Venue, Pune"), undefined);
});

test("ad-hoc place outside the directory: agent estimate is required and labelled", async () => {
  const { state, ctx } = loaded("I'm visiting a client in Pune tomorrow, check the weather");
  await runTool("set_scope", { mode: "adhoc", requested_description: "client visit in Pune", untracked_subjects: ["client visit", "Pune"] }, ctx);
  await assert.rejects(runTool("get_location_weather", { place: "Pune", date: "2026-09-27" }, ctx), /not in FieldFlow's place directory; supply your best latitude/);
  await runTool("get_location_weather", { place: "Pune", latitude: 18.52, longitude: 73.86, date: "2026-09-27" }, ctx);
  assert.equal(state.adhoc.resolution, "estimated by the agent");
  assert.match(ctx.trace.steps.at(-2)!.result!, /coordinates ≈18\.520, 73\.860 estimated by the agent/);
});

test("directory place needs no model coordinates, and never touches tracked FA-101 in the same city", async () => {
  const { state, ctx } = loaded("Check the weather for my hackathon tomorrow in Gurgaon Sector 59.");
  await runTool("set_scope", { mode: "adhoc", requested_description: "hackathon in Gurgaon Sector 59", untracked_subjects: ["hackathon", "Gurgaon Sector 59"] }, ctx);
  const out: any = await runTool("get_location_weather", { place: "Gurgaon Sector 59", date: "2026-09-27" }, ctx);
  assert.match(out.location_resolution, /place directory/);
  assert.equal(state.weather.size, 0, "no tracked-activity weather was fetched");
  assert.equal(state.decisions.size, 0, "no tracked-activity decision was made");
  await assert.rejects(runTool("get_weather", { activity_id: "FA-101" }, ctx), /outside the declared scope \(adhoc\)/);
});
