import { test } from "node:test";
import assert from "node:assert/strict";
import { composeResultEmail, emailStoredResult, ResultStore } from "../src/email.ts";
import { buildRawMessage } from "../src/integrations/gmail.ts";
import type { RunResponse } from "../src/agent/run.ts";

// Email result composition and duplicate-send protection with fake mail functions (no Gmail).

function result(over: Partial<RunResponse> = {}): RunResponse {
  return {
    request: "Review tomorrow's field operations",
    status: "completed",
    summary: { total: 2, proceed: 1, flag: 0, reschedule: 1 },
    steps: [
      { id: "step-1", type: "tool", tool: "notion", action: "read_activities", status: "completed", result: "2 loaded" },
      { id: "step-2", type: "tool", tool: "notion", action: "update_activity", status: "completed", activity_id: "FA-101" },
      { id: "step-3", type: "tool", tool: "slack", action: "send_message", status: "completed" },
      { id: "step-4", type: "tool", tool: "slack", action: "send_summary", status: "failed", error: "x" },
    ],
    activities: [
      { activity_id: "FA-101", activity_name: "Rooftop solar", decision: "RESCHEDULE", reason: "heavy rain 11.2 mm/h", weather_source: "openweather", notion_updated: true, slack_notified: true },
      { activity_id: "FA-104", activity_name: "Warehouse audit", decision: "PROCEED", reason: "indoor", weather_source: "openweather", notion_updated: false, slack_notified: false },
    ],
    agent_summary: "One activity rescheduled.",
    weather_provider: "openweather",
    model: "claude-opus-5",
    run_id: "run-1",
    scope: { mode: "schedule_review", description: "tomorrow" },
    adhoc: null,
    ...over,
  };
}

test("tracked result email reflects only actions that actually completed", () => {
  const { subject, text } = composeResultEmail(result());
  assert.equal(subject, "FieldFlow: 1 activity needs attention");
  assert.match(text, /2 activities: 1 proceed, 0 flagged, 1 rescheduled/);
  assert.match(text, /- RESCHEDULE · FA-101 Rooftop solar: heavy rain 11\.2 mm\/h/);
  assert.match(text, /Notion: 1 update\n/);
  assert.match(text, /Slack: 1 message posted/, "the failed summary post must not be counted");
});

test("ad-hoc result email", () => {
  const { subject, text } = composeResultEmail(result({
    summary: { total: 0, proceed: 0, flag: 0, reschedule: 0 }, activities: [], steps: [],
    adhoc: {
      place: "Gurgaon Sector 59", date: "2026-09-27", time: null, provider_area: "Gurugram, IN", location_resolution: "estimated by the agent", latitude: 28.41, longitude: 77.07,
      weather_source: "mock", condition: "moderate rain", precipitation_mm_per_hour_max: 3.4, wind_speed_m_per_s_max: 6.2,
      wind_gust_m_per_s_max: 9.1, temperature_c_min: 24, temperature_c_max: 29.5, assessment_level: "caution",
      assessment: "Some weather risk: moderate rain 3.4 mm/h (≥ 2.5).", notion_recorded: false, slack_notified: false,
    },
  }));
  assert.equal(subject, "FieldFlow: Gurgaon Sector 59 2026-09-27 — caution weather risk");
  assert.match(text, /AD-HOC WEATHER REVIEW/);
  assert.match(text, /coordinates estimated by the agent/);
  assert.match(text, /Notion: no changes/);
  assert.match(text, /SIMULATED/);
});

test("raw message is valid base64url RFC 2822 with a UTF-8 subject", () => {
  const raw = buildRawMessage("me@example.com", "FieldFlow — résumé ✓", "Body ✓");
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /^To: me@example\.com\r\n/);
  const subj = mime.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)![1];
  assert.equal(Buffer.from(subj, "base64").toString("utf8"), "FieldFlow — résumé ✓");
  const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Body ✓");
});

test("email is sent once; repeats are refused; failure can be retried; unknown/failed runs refused", async () => {
  const store = new ResultStore();
  store.put(result());
  let sends = 0;
  const ok = { getAddress: async () => "me@example.com", send: async () => { sends++; return `msg-${sends}`; } };

  const first = await emailStoredResult(store, "run-1", ok);
  assert.equal(first.http, 200);
  assert.equal(first.body.status, "sent");
  const again = await emailStoredResult(store, "run-1", ok);
  assert.equal(again.http, 409);
  assert.equal(again.body.status, "already_sent");
  assert.equal(sends, 1, "no duplicate email");
  assert.equal(store.get("run-1")!.result.steps.at(-1)!.tool, "gmail");

  store.put(result({ run_id: "run-2" }));
  const failing = { getAddress: async () => "me@example.com", send: async () => { throw new Error("gmail down"); } };
  const failed = await emailStoredResult(store, "run-2", failing);
  assert.equal(failed.http, 502);
  assert.equal(failed.body.error, "Email could not be sent.");
  const retried = await emailStoredResult(store, "run-2", ok);
  assert.equal(retried.body.status, "sent", "retry after failure is allowed");

  store.put(result({ run_id: "run-3" }));
  let release!: () => void;
  const slow = { getAddress: async () => "me@example.com", send: () => new Promise<string>((r) => { release = () => r("slow"); }) };
  const inFlight = emailStoredResult(store, "run-3", slow);
  const concurrent = await emailStoredResult(store, "run-3", ok);
  assert.equal(concurrent.body.status, "sending", "double click while sending is refused");
  release();
  assert.equal((await inFlight).body.status, "sent");

  assert.equal((await emailStoredResult(store, "nope", ok)).http, 404);
  store.put(result({ run_id: "run-4", status: "failed" }));
  assert.equal((await emailStoredResult(store, "run-4", ok)).http, 400);
});
