import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent/run.ts";
import { currentWeatherResult } from "./currentWeather.ts";
import { getWeatherProvider } from "./weather/index.ts";
import { emailStoredResult, ResultStore } from "./email.ts";
import { getConnectedAddress, sendEmail } from "./integrations/gmail.ts";
import { redact } from "./swytch.ts";

const app = express();
app.use(express.json());

/** Completed runs, so a result can be emailed without re-running the agent. */
const results = new ResultStore();

app.get("/", (_req, res) => {
  res.sendFile(fileURLToPath(new URL("../frontend/index.html", import.meta.url)));
});

/** Browser-location helper module used by the UI (navigator.geolocation only). */
app.get("/location.js", (_req, res) => {
  res.type("application/javascript").sendFile(fileURLToPath(new URL("../frontend/location.js", import.meta.url)));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, weather_provider: process.env.WEATHER_PROVIDER === "mock" ? "mock" : "openweather" });
});

app.post("/run", async (req, res) => {
  const request = req.body?.request;
  if (typeof request !== "string" || !request.trim()) {
    res.status(400).json({ error: 'Body must be JSON: { "request": "<natural-language request>" }' });
    return;
  }
  try {
    const result = await runAgent(request.trim());
    results.put(result);
    res.status(result.status === "failed" ? 500 : 200).json(result);
  } catch (e) {
    res.status(500).json({ request, status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Current weather at coordinates the browser shared after the user granted location permission.
 * Goes straight to the SwytchCode OpenWeather method (no agent run); coordinates are not stored.
 */
app.post("/current-weather", async (req, res) => {
  const { http, body } = await currentWeatherResult(req.body, getWeatherProvider());
  res.status(http).json(body);
});

/** Email a completed run's result to the connected Gmail account (via SwytchCode). Never re-runs the agent. */
app.post("/email-result", async (req, res) => {
  const runId = req.body?.run_id;
  if (typeof runId !== "string" || !runId) {
    res.status(400).json({ status: "bad_request", error: 'Body must be JSON: { "run_id": "<id from /run>" }' });
    return;
  }
  const { http, body } = await emailStoredResult(results, runId, { getAddress: getConnectedAddress, send: sendEmail, redact });
  res.status(http).json(body);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`FieldFlow AI listening on http://localhost:${port} (POST /run, POST /current-weather, POST /email-result)`);
});
