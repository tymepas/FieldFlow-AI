import { test } from "node:test";
import assert from "node:assert/strict";
import { newRunState, runTool, summarize } from "../src/agent/tools.ts";
import { Trace } from "../src/agent/trace.ts";
import { MockWeatherProvider } from "../src/weather/mock.ts";
import type { Activity } from "../src/types.ts";

// Guard paths only: none of these reach Notion or Slack.

const activity = (id: string, location: string, activity_type: Activity["activity_type"]): Activity => ({
  activity_id: id, activity_name: id, location, date: "2026-09-26", start_time: "10:00",
  activity_type, priority: "high", stakeholder: "", status: "planned", notes: "", page_id: `page-${id}`,
});

function setup() {
  const state = newRunState();
  state.activities.set("IN-1", activity("IN-1", "Gurgaon", "indoor")); // mock: heavy rain
  state.activities.set("OUT-1", activity("OUT-1", "Gurgaon", "outdoor_inspection"));
  const ctx = { state, trace: new Trace(), weather: new MockWeatherProvider() };
  return { state, ctx };
}

test("tools reject ids that read_activities did not return", async () => {
  const { ctx } = setup();
  await assert.rejects(runTool("get_weather", { activity_id: "FA-999" }, ctx), /Unknown activity_id/);
});

test("evaluate_risk requires weather first", async () => {
  const { ctx } = setup();
  await assert.rejects(runTool("evaluate_risk", { activity_id: "OUT-1" }, ctx), /Call get_weather first/);
});

test("update and notify require a decision first", async () => {
  const { ctx } = setup();
  await assert.rejects(runTool("update_activity", { activity_id: "OUT-1", explanation: "x" }, ctx), /Call evaluate_risk first/);
  await assert.rejects(runTool("notify_team", { activity_id: "OUT-1", required_action: "x" }, ctx), /Call evaluate_risk first/);
});

test("decision comes from the engine, and PROCEED cannot be written or alerted", async () => {
  const { state, ctx } = setup();
  await runTool("get_weather", { activity_id: "IN-1" }, ctx);
  const d: any = await runTool("evaluate_risk", { activity_id: "IN-1" }, ctx);
  assert.equal(d.decision, "PROCEED"); // indoor, despite simulated heavy rain
  await assert.rejects(runTool("update_activity", { activity_id: "IN-1", explanation: "x" }, ctx), /only updated for FLAG or RESCHEDULE/);
  await assert.rejects(runTool("notify_team", { activity_id: "IN-1", required_action: "x" }, ctx), /only for FLAG or RESCHEDULE/);
  assert.equal(state.updated.size, 0);
});

test("summary refuses to post until every loaded activity is evaluated", async () => {
  const { ctx } = setup();
  await runTool("get_weather", { activity_id: "OUT-1" }, ctx);
  await runTool("evaluate_risk", { activity_id: "OUT-1" }, ctx);
  await assert.rejects(runTool("post_run_summary", { headline: "x" }, ctx), /Not every activity is evaluated yet: IN-1/);
});

test("trace records decisions and summary counts come from engine results", async () => {
  const { state, ctx } = setup();
  for (const id of ["IN-1", "OUT-1"]) {
    await runTool("get_weather", { activity_id: id }, ctx);
    await runTool("evaluate_risk", { activity_id: id }, ctx);
  }
  assert.deepEqual(summarize(state), { total: 2, proceed: 1, flag: 0, reschedule: 1 });
  const decisions = ctx.trace.steps.filter((s) => s.type === "decision").map((s) => s.decision);
  assert.deepEqual(decisions, ["PROCEED", "RESCHEDULE"]);
  const weatherSteps = ctx.trace.steps.filter((s) => s.action === "forecast_simulated");
  assert.ok(weatherSteps.every((s) => s.tool === "mock_weather" && s.result!.includes("[SIMULATED]")));
});
