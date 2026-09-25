import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, THRESHOLDS } from "../src/decision/engine.ts";
import type { Activity, NormalizedWeather } from "../src/types.ts";

const activity = (activity_type: Activity["activity_type"]): Activity => ({
  activity_id: "T-1",
  activity_name: "Test",
  location: "Gurgaon",
  date: "2026-09-26",
  start_time: "10:00",
  activity_type,
  priority: "medium",
  stakeholder: "",
  status: "planned",
  notes: "",
});

const weather = (w: Partial<NormalizedWeather> = {}): NormalizedWeather => ({
  source: "mock",
  location: "Gurgaon",
  forecast_time: "2026-09-26T10:00:00+05:30",
  condition: "clear sky",
  precipitation_mm_per_hour: 0,
  wind_speed_m_per_s: 3,
  wind_gust_m_per_s: null,
  temperature_c: 30,
  ...w,
});

const HEAVY = { precipitation_mm_per_hour: THRESHOLDS.heavy_rain_mm_per_hour };
const MODERATE = { precipitation_mm_per_hour: THRESHOLDS.moderate_rain_mm_per_hour };
const WIND = { wind_speed_m_per_s: THRESHOLDS.high_wind_m_per_s };
const GUST = { wind_gust_m_per_s: THRESHOLDS.high_gust_m_per_s };
const HEAT = { temperature_c: THRESHOLDS.extreme_heat_c };

test("indoor always proceeds, even in heavy rain + wind + heat", () => {
  const r = decide(activity("indoor"), weather({ ...HEAVY, ...WIND, ...HEAT }));
  assert.equal(r.decision, "PROCEED");
  assert.equal(r.new_status, "proceed");
});

test("outdoor inspection: normal conditions proceed", () => {
  assert.equal(decide(activity("outdoor_inspection"), weather()).decision, "PROCEED");
});

test("outdoor inspection: heavy rain reschedules", () => {
  const r = decide(activity("outdoor_inspection"), weather(HEAVY));
  assert.equal(r.decision, "RESCHEDULE");
  assert.deepEqual(r.triggered, ["heavy_rain"]);
  assert.equal(r.new_status, "rescheduled");
});

test("outdoor inspection: moderate rain alone proceeds", () => {
  assert.equal(decide(activity("outdoor_inspection"), weather(MODERATE)).decision, "PROCEED");
});

test("outdoor inspection: high wind flags", () => {
  const r = decide(activity("outdoor_inspection"), weather(WIND));
  assert.equal(r.decision, "FLAG");
  assert.deepEqual(r.triggered, ["high_wind"]);
});

test("outdoor inspection: high gust alone flags", () => {
  assert.equal(decide(activity("outdoor_inspection"), weather(GUST)).decision, "FLAG");
});

test("outdoor inspection: extreme heat flags", () => {
  const r = decide(activity("outdoor_inspection"), weather(HEAT));
  assert.equal(r.decision, "FLAG");
  assert.deepEqual(r.triggered, ["extreme_heat"]);
});

test("outdoor inspection: heavy rain outranks wind (reschedule wins)", () => {
  assert.equal(decide(activity("outdoor_inspection"), weather({ ...HEAVY, ...WIND })).decision, "RESCHEDULE");
});

test("outdoor installation: heavy rain reschedules", () => {
  assert.equal(decide(activity("outdoor_installation"), weather(HEAVY)).decision, "RESCHEDULE");
});

test("outdoor installation: high wind reschedules", () => {
  const r = decide(activity("outdoor_installation"), weather(WIND));
  assert.equal(r.decision, "RESCHEDULE");
  assert.deepEqual(r.triggered, ["high_wind"]);
});

test("outdoor installation: moderate rain flags", () => {
  const r = decide(activity("outdoor_installation"), weather(MODERATE));
  assert.equal(r.decision, "FLAG");
  assert.deepEqual(r.triggered, ["moderate_rain"]);
});

test("outdoor installation: extreme heat alone proceeds (not in its rule set)", () => {
  assert.equal(decide(activity("outdoor_installation"), weather(HEAT)).decision, "PROCEED");
});

test("just below thresholds proceeds", () => {
  const r = decide(
    activity("outdoor_installation"),
    weather({
      precipitation_mm_per_hour: THRESHOLDS.moderate_rain_mm_per_hour - 0.1,
      wind_speed_m_per_s: THRESHOLDS.high_wind_m_per_s - 0.1,
      wind_gust_m_per_s: THRESHOLDS.high_gust_m_per_s - 0.1,
    }),
  );
  assert.equal(r.decision, "PROCEED");
});

test("reason cites the measured value and threshold", () => {
  const r = decide(activity("outdoor_inspection"), weather({ precipitation_mm_per_hour: 12.3 }));
  assert.match(r.reason, /12\.3 mm\/h/);
  assert.match(r.reason, /7\.6/);
});
