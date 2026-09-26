import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestReferencesActivity, untrackedSubjects } from "../src/agent/scope.ts";
import { newRunState, runTool, summarize } from "../src/agent/tools.ts";
import { Trace } from "../src/agent/trace.ts";
import { MockWeatherProvider } from "../src/weather/mock.ts";
import type { Activity } from "../src/types.ts";

// Scope guardrail tests. No call here reaches Notion or Slack: activities are loaded
// directly (as read_activities would), weather is the mock, and every write attempt is
// expected to be rejected by the scope gate before any integration is called.

const seed: Activity[] = JSON.parse(readFileSync(new URL("../test-data/activities.json", import.meta.url), "utf8"));
const HACKATHON =
  "Hey I have a hackathon tomorrow at Gurgaon Sector 59 and I am coming from Rohini. Please check the weather and update it on Notion and Slack.";
const DEMO = "Review tomorrow's field operations and handle anything that could be affected by changing weather.";

function loaded(request: string) {
  const state = newRunState();
  for (const a of seed) state.activities.set(a.activity_id, { ...a, page_id: `page-${a.activity_id}` });
  state.activitiesRead = true; // as if read_activities returned the six seed rows
  const ctx = { state, trace: new Trace(), weather: new MockWeatherProvider(), request };
  return { state, ctx };
}

test("hackathon prompt: no closest-record proxy, no schedule broadening, not_tracked blocks every action", async () => {
  const { state, ctx } = loaded(HACKATHON);

  // The observed failure: FA-101 picked as the "closest" Gurgaon record.
  await assert.rejects(
    runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-101"], requested_description: "hackathon at Gurgaon Sector 59" }, ctx),
    /not referenced by the request.*closest/,
  );
  // Broadening into a full schedule review.
  await assert.rejects(
    runTool("set_scope", { mode: "schedule_review", requested_description: "hackathon at Gurgaon Sector 59" }, ctx),
    /not a tracked record \(Sector, Rohini, hackathon\)/,
  );
  // The correct declaration.
  const scope: any = await runTool("set_scope", { mode: "not_tracked", requested_description: "hackathon at Gurgaon Sector 59" }, ctx);
  assert.deepEqual(scope, { mode: "not_tracked", activity_ids: [] });

  // Every operational tool is now refused for every tracked record.
  for (const a of seed) {
    await assert.rejects(runTool("get_weather", { activity_id: a.activity_id }, ctx), /not a tracked record/);
    await assert.rejects(runTool("evaluate_risk", { activity_id: a.activity_id }, ctx), /not a tracked record/);
    await assert.rejects(runTool("update_activity", { activity_id: a.activity_id, explanation: "x" }, ctx), /not a tracked record/);
    await assert.rejects(runTool("notify_team", { activity_id: a.activity_id, required_action: "x" }, ctx), /not a tracked record/);
  }
  await assert.rejects(runTool("post_run_summary", { headline: "x" }, ctx), /not about a tracked record/);

  assert.equal(state.weather.size, 0);
  assert.equal(state.decisions.size, 0);
  assert.equal(state.updated.size, 0, "no Notion updates");
  assert.equal(state.notified.size, 0, "no per-activity Slack alerts");
  assert.equal(state.summaryPosted, false, "no Slack summary");
  assert.deepEqual(summarize(state), { total: 0, proceed: 0, flag: 0, reschedule: 0 });

  const steps = ctx.trace.steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].action, "set_scope");
  assert.match(steps[0].result!, /Not tracked: "hackathon at Gurgaon Sector 59" is outside what FieldFlow can act on/);
});

test("demo request still reviews all six tomorrow activities", async () => {
  const { state, ctx } = loaded(DEMO);
  const scope: any = await runTool("set_scope", { mode: "schedule_review", date: "2026-09-27", requested_description: "tomorrow's field operations" }, ctx);
  assert.equal(scope.activity_ids.length, 6);

  for (const a of seed) {
    await runTool("get_weather", { activity_id: a.activity_id }, ctx);
    await runTool("evaluate_risk", { activity_id: a.activity_id }, ctx);
  }
  assert.deepEqual(summarize(state), { total: 6, proceed: 3, flag: 2, reschedule: 1 });
});

test("schedule review is limited to the declared date", async () => {
  const { ctx } = loaded(DEMO);
  const scope: any = await runTool("set_scope", { mode: "schedule_review", date: "2026-09-28", requested_description: "field operations" }, ctx);
  assert.equal(scope.activity_ids.length, 0);
  await assert.rejects(runTool("get_weather", { activity_id: "FA-101" }, ctx), /outside the declared scope/);
});

test("summary waits for every in-scope activity (and only those)", async () => {
  const { ctx } = loaded("Check the rooftop solar installation and the antenna mounting");
  await runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-101", "FA-103"], requested_description: "solar install and antenna" }, ctx);
  await runTool("get_weather", { activity_id: "FA-101" }, ctx);
  await runTool("evaluate_risk", { activity_id: "FA-101" }, ctx);
  await assert.rejects(runTool("post_run_summary", { headline: "x" }, ctx), /Not every activity is evaluated yet: FA-103/);
});

test("specific activities: explicitly named records are allowed, others stay out of scope", async () => {
  const { ctx } = loaded("Is the rooftop solar installation still on for tomorrow?");
  const scope: any = await runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-101"], requested_description: "rooftop solar installation" }, ctx);
  assert.deepEqual(scope.activity_ids, ["FA-101"]);
  await runTool("get_weather", { activity_id: "FA-101" }, ctx);
  await assert.rejects(runTool("get_weather", { activity_id: "FA-102" }, ctx), /outside the declared scope/);
});

test("specific activities by id", async () => {
  const { ctx } = loaded("Check FA-103 for me");
  const scope: any = await runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-103"], requested_description: "FA-103" }, ctx);
  assert.deepEqual(scope.activity_ids, ["FA-103"]);
});

test("sharing a location is not a reference to an activity", async () => {
  const { ctx } = loaded("Anything happening in Gurgaon I should worry about?");
  await assert.rejects(
    runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-101"], requested_description: "Gurgaon" }, ctx),
    /not referenced by the request/,
  );
});

test("sequencing: set_scope needs read_activities, tools need set_scope, scope is fixed once set", async () => {
  const fresh = newRunState();
  const ctx0 = { state: fresh, trace: new Trace(), weather: new MockWeatherProvider(), request: DEMO };
  await assert.rejects(runTool("set_scope", { mode: "not_tracked", requested_description: "x" }, ctx0), /Call read_activities before set_scope/);

  const { ctx } = loaded(DEMO);
  await assert.rejects(runTool("get_weather", { activity_id: "FA-101" }, ctx), /Call set_scope before acting/);
  await assert.rejects(runTool("post_run_summary", { headline: "x" }, ctx), /Call set_scope first/);
  await runTool("set_scope", { mode: "schedule_review", requested_description: "field operations" }, ctx);
  await assert.rejects(runTool("set_scope", { mode: "not_tracked", requested_description: "x" }, ctx), /cannot be changed/);
});

test("request classification helpers", () => {
  const fa101 = seed.find((a) => a.activity_id === "FA-101")!;
  assert.equal(requestReferencesActivity(HACKATHON, fa101), false);
  assert.equal(requestReferencesActivity("how is the solar install looking", fa101), true);
  for (const a of seed) assert.equal(requestReferencesActivity(HACKATHON, a), false, `${a.activity_id} must not match the hackathon prompt`);
});

// --- schedule-review intent without a keyword list ---------------------------------------

async function scheduleScope(request: string, untracked_subjects: string[] = []) {
  const { ctx } = loaded(request);
  return runTool("set_scope", { mode: "schedule_review", date: "2026-09-27", requested_description: "tomorrow", untracked_subjects }, ctx) as Promise<any>;
}

test("natural schedule questions are eligible for schedule_review (no keywords required)", async () => {
  for (const request of [
    "What's affected by the weather tomorrow?",
    "Do we need to change anything tomorrow because of the forecast?",
    "Will the forecast mess with tomorrow?",
    "Should we delay our installs tomorrow?",
    "Review field ops ASAP for Monday",
    DEMO,
  ]) {
    const scope = await scheduleScope(request);
    assert.equal(scope.mode, "schedule_review", request);
    assert.equal(scope.activity_ids.length, 6, request);
  }
});

test("exact hackathon prompt: schedule_review refused, not_tracked accepted", async () => {
  assert.deepEqual(untrackedSubjects(HACKATHON, seed), ["Sector", "Rohini", "hackathon"]);
  await assert.rejects(scheduleScope(HACKATHON), /not a tracked record/);
  const { ctx } = loaded(HACKATHON);
  const scope: any = await runTool("set_scope", { mode: "not_tracked", requested_description: "hackathon at Gurgaon Sector 59", untracked_subjects: ["hackathon", "Gurgaon Sector 59", "Rohini commute"] }, ctx);
  assert.equal(scope.mode, "not_tracked");
});

test("personal events and untracked places block schedule_review even in lower case or with tracked cities", async () => {
  for (const request of [
    "i have a hackathon tomorrow at sector 59, check the weather",
    "We have a wedding in Jaipur tomorrow, will the weather be ok?",
    "I'm going to Rohini tomorrow, anything I should know?",
    "Check the weather for our Rohini site tomorrow",
  ]) {
    await assert.rejects(scheduleScope(request), /not a tracked record/, request);
  }
});

test("the model's declared untracked subjects also block schedule_review", async () => {
  // Deterministic signals find nothing here; the model's own declaration still counts.
  await assert.rejects(scheduleScope("what about the offsite tomorrow?", ["offsite"]), /not a tracked record \(offsite\)/);
});

test("a request naming a real tracked activity: specific scope works, schedule_review also allowed", async () => {
  const request = "Is the antenna mounting in Faridabad still safe tomorrow?";
  assert.deepEqual(untrackedSubjects(request, seed), []);
  const { ctx } = loaded(request);
  const scope: any = await runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-103"], requested_description: "antenna mounting", untracked_subjects: [] }, ctx);
  assert.deepEqual(scope.activity_ids, ["FA-103"]);
});

test("a request mentioning only a tracked location: no proxy activity, but not an untracked subject either", async () => {
  const request = "Anything happening in Gurgaon I should worry about?";
  assert.deepEqual(untrackedSubjects(request, seed), []);
  const { ctx } = loaded(request);
  await assert.rejects(
    runTool("set_scope", { mode: "specific_activities", activity_ids: ["FA-101"], requested_description: "Gurgaon", untracked_subjects: [] }, ctx),
    /not referenced by the request/,
  );
});
