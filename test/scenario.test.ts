import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide } from "../src/decision/engine.ts";
import { MockWeatherProvider } from "../src/weather/mock.ts";
import type { Activity } from "../src/types.ts";

const activities: Activity[] = JSON.parse(readFileSync(new URL("../test-data/activities.json", import.meta.url), "utf8"));

test("seed activities + mock weather produce the demo decision mix", async () => {
  const weather = new MockWeatherProvider();
  const decisions: Record<string, string> = {};
  for (const a of activities) {
    const w = await weather.getWeather(a.location, a.date, a.start_time);
    assert.equal(w.source, "mock");
    decisions[a.activity_id] = decide(a, w).decision;
  }
  assert.deepEqual(decisions, {
    "FA-101": "RESCHEDULE", // installation + heavy rain
    "FA-102": "FLAG", // inspection + high wind
    "FA-103": "FLAG", // installation + moderate rain
    "FA-104": "PROCEED", // indoor
    "FA-105": "PROCEED", // inspection, normal conditions
    "FA-106": "PROCEED", // indoor despite heavy rain
  });
});
