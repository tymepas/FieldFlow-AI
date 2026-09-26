import { test } from "node:test";
import assert from "node:assert/strict";
import { requestBrowserLocation } from "../frontend/location.js";
import { currentWeatherResult, parseCoordinates } from "../src/currentWeather.ts";
import { normalizeCurrent } from "../src/weather/openweather.ts";
import { MockWeatherProvider } from "../src/weather/mock.ts";
import type { WeatherProvider } from "../src/weather/provider.ts";

// Current-location weather. The browser side is tested with a fake navigator.geolocation;
// the backend side with the labelled mock provider. Nothing here reaches OpenWeather.

const geo = (outcome: { coords?: object; error?: { code: number } }) => ({
  getCurrentPosition: (ok: (p: unknown) => void, fail: (e: unknown) => void) =>
    outcome.coords ? ok({ coords: outcome.coords }) : fail(outcome.error),
});

test("location permission granted: coordinates and accuracy come from the browser", async () => {
  const r = await requestBrowserLocation(geo({ coords: { latitude: 28.7063, longitude: 77.1088, accuracy: 35 } }));
  assert.deepEqual(r, { ok: true, latitude: 28.7063, longitude: 77.1088, accuracy_m: 35 });
});

test("location permission denied: clear message, nothing continues", async () => {
  const r = await requestBrowserLocation(geo({ error: { code: 1 } }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "denied");
    assert.match(r.message, /Allow location access for this site/);
    assert.match(r.message, /type a place instead/);
  }
});

test("location unavailable, timeout and unsupported browser are reported distinctly", async () => {
  const unavailable = await requestBrowserLocation(geo({ error: { code: 2 } }));
  const timeout = await requestBrowserLocation(geo({ error: { code: 3 } }));
  const unsupported = await requestBrowserLocation(undefined);
  assert.equal(!unavailable.ok && unavailable.reason, "unavailable");
  assert.equal(!timeout.ok && timeout.reason, "timeout");
  assert.equal(!unsupported.ok && unsupported.reason, "unsupported");
});

test("weather lookup with coordinates: labelled browser location, weather, assessment and trace", async () => {
  const { http, body } = await currentWeatherResult({ latitude: 28.7063, longitude: 77.1088, accuracy_m: 35 }, new MockWeatherProvider());
  assert.equal(http, 200);
  const r = body as any;
  assert.equal(r.status, "completed");
  assert.deepEqual(r.location, { latitude: 28.7063, longitude: 77.1088, accuracy_m: 35, source: "browser geolocation (user permission)" });
  assert.equal(r.weather.source, "mock");
  assert.equal(r.assessment.level, "low"); // mock: 1.2 mm last hour, 4.4 m/s
  assert.deepEqual(r.steps.map((s: any) => s.action ?? s.type), ["browser_location", "current_weather_simulated", "decision"]);
  assert.match(r.steps[0].result, /after user permission: 28\.7063, 77\.1088 \(±35 m\)/);
  assert.match(r.steps[1].result, /\[SIMULATED\]/);
});

test("missing or invalid coordinates are rejected before any weather call", async () => {
  let called = 0;
  const spy = { getCurrentWeather: async () => { called++; throw new Error("should not be called"); } } as unknown as WeatherProvider;
  for (const bad of [undefined, {}, { latitude: 28.7 }, { longitude: 77.1 }, { latitude: null, longitude: 77 }]) {
    const { http, body } = await currentWeatherResult(bad, spy);
    assert.equal(http, 400);
    assert.match((body as any).error, /latitude and longitude are required/);
  }
  assert.equal((await currentWeatherResult({ latitude: 95, longitude: 77 }, spy)).http, 400);
  assert.equal(called, 0);
  assert.equal(parseCoordinates({ latitude: 1, longitude: 2, accuracy_m: -5 }).ok && (parseCoordinates({ latitude: 1, longitude: 2, accuracy_m: -5 }) as any).coords.accuracy_m, null);
});

test("weather failure is reported honestly, not as success", async () => {
  const failing = { getCurrentWeather: async () => { throw new Error("openweather down"); } } as unknown as WeatherProvider;
  const { http, body } = await currentWeatherResult({ latitude: 28.7, longitude: 77.1 }, failing);
  assert.equal(http, 502);
  assert.equal((body as any).status, "failed");
  assert.equal((body as any).weather, null);
  assert.equal((body as any).steps.at(-1).status, "failed");
});

test("OpenWeather current payload maps to units-labelled fields (rain absent means 0)", () => {
  const live = { name: "Bhundsi", sys: { country: "IN" }, dt: 1790413698, timezone: 19800, weather: [{ description: "overcast clouds" }],
    main: { temp: 23.2, feels_like: 23.27, humidity: 65 }, wind: { speed: 5.82, gust: 8.56 } };
  const w = normalizeCurrent("openweather", 28.403, 77.107, live);
  assert.equal(w.provider_area, "Bhundsi, IN");
  assert.equal(w.temperature_c, 23.2);
  assert.equal(w.precipitation_mm_last_hour, 0);
  assert.equal(w.wind_gust_m_per_s, 8.56);
  assert.match(w.observed_at, /\+05:30$/);
  assert.equal(normalizeCurrent("openweather", 1, 2, { ...live, rain: { "1h": 2.4 } }).precipitation_mm_last_hour, 2.4);
  assert.throws(() => normalizeCurrent("openweather", 1, 2, {}), /no current temperature/);
});
