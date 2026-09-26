import type Anthropic from "@anthropic-ai/sdk";
import { decide, THRESHOLDS } from "../decision/engine.ts";
import { readActivities, updateActivity } from "../integrations/notion.ts";
import { postMessage } from "../integrations/slack.ts";
import type { WeatherProvider } from "../weather/provider.ts";
import type { Activity, DecisionResult, NormalizedWeather } from "../types.ts";
import type { Trace } from "./trace.ts";
import { resolveScope, type RunScope } from "./scope.ts";

/** Everything the run has learned so far. Tools read from here so the model cannot
 *  supply locations, times, weather or decisions itself — only activity ids. */
export interface RunState {
  activities: Map<string, Activity>;
  weather: Map<string, NormalizedWeather>;
  decisions: Map<string, DecisionResult>;
  updated: Set<string>;
  notified: Set<string>;
  summaryPosted: boolean;
  /** Set by read_activities; set_scope requires it. */
  activitiesRead: boolean;
  /** Records this run may act on, declared via set_scope and validated in code. */
  scope?: RunScope;
}

export function newRunState(): RunState {
  return { activities: new Map(), weather: new Map(), decisions: new Map(), updated: new Set(), notified: new Set(), summaryPosted: false, activitiesRead: false };
}

const activityIdInput = {
  type: "object" as const,
  properties: { activity_id: { type: "string", description: "activity_id from read_activities, e.g. FA-101" } },
  required: ["activity_id"],
  additionalProperties: false,
};

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "read_activities",
    description:
      "Read planned field activities from the Notion 'Field Activities' database. Optionally filter to one date (YYYY-MM-DD). Must be called first, then set_scope.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Only return activities on this ISO date (YYYY-MM-DD). Omit for all." } },
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "set_scope",
    description:
      "Declare which tracked Notion records this request is about. Call once, after read_activities and before any other tool. schedule_review: the user asked to review the scheduled operations in general (optionally one date). specific_activities: the user explicitly named tracked records (by id or activity name). not_tracked: the user asked about an event, activity or location that is not a tracked record; no weather, decision, Notion or Slack actions are then allowed. Never pick a similar or closest record as a proxy.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["schedule_review", "specific_activities", "not_tracked"] },
        activity_ids: { type: "array", items: { type: "string" }, description: "For specific_activities: the ids the user referred to." },
        date: { type: "string", description: "For schedule_review: limit the review to this ISO date (YYYY-MM-DD)." },
        requested_description: { type: "string", description: "Short description of what the user asked about, in their terms." },
        untracked_subjects: {
          type: "array",
          items: { type: "string" },
          description: "Every specific event, activity, place or route the user mentioned that is NOT a tracked record (e.g. a personal event, a venue, a commute). Empty if none. A non-empty list rules out schedule_review.",
        },
      },
      required: ["mode", "requested_description", "untracked_subjects"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_weather",
    description:
      "Get the real forecast for an activity's location and start time (location/time are taken from the Notion record). Returns normalized weather with units in field names.",
    input_schema: activityIdInput,
    strict: true,
  },
  {
    name: "evaluate_risk",
    description:
      "Run the deterministic decision engine on an activity and its fetched weather. Returns PROCEED, FLAG or RESCHEDULE with the rule that fired. Thresholds are fixed in code; this result is final and must not be overridden.",
    input_schema: activityIdInput,
    strict: true,
  },
  {
    name: "update_activity",
    description:
      "Write the decision to Notion: sets status (flagged/rescheduled, from the evaluate_risk result) and appends the reasoning to notes. Only allowed for FLAG or RESCHEDULE decisions.",
    input_schema: {
      type: "object",
      properties: {
        activity_id: activityIdInput.properties.activity_id,
        explanation: { type: "string", description: "One or two sentences for the operations record explaining the decision and its operational impact." },
      },
      required: ["activity_id", "explanation"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "notify_team",
    description:
      "Post a Slack alert to #field-ops for one FLAG or RESCHEDULE activity, including weather evidence, decision and reason. You supply the required action for the team.",
    input_schema: {
      type: "object",
      properties: {
        activity_id: activityIdInput.properties.activity_id,
        required_action: { type: "string", description: "Concrete next step for the ops team (and stakeholder contact, if an external stakeholder is named)." },
      },
      required: ["activity_id", "required_action"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "post_run_summary",
    description: "Post one Slack summary to #field-ops of the whole review (counts and each activity's decision). Call once, after every in-scope activity has been evaluated and actioned. Not allowed when the scope is not_tracked.",
    input_schema: {
      type: "object",
      properties: { headline: { type: "string", description: "One-sentence overview of the review outcome." } },
      required: ["headline"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function requireActivity(state: RunState, id: string): Activity {
  const a = state.activities.get(id);
  if (!a) throw new Error(`Unknown activity_id "${id}". Call read_activities first and use an id it returned.`);
  const scope = state.scope;
  if (!scope) throw new Error("Call set_scope before acting on any activity.");
  if (scope.mode === "not_tracked") {
    throw new Error(`The requested item ("${scope.description}") is not a tracked record, so no weather, decision, Notion or Slack action is allowed on ${id}.`);
  }
  if (!scope.activityIds.has(id)) throw new Error(`${id} is outside the declared scope (${scope.mode}); do not act on it.`);
  return a;
}

function fmtWeather(w: NormalizedWeather): string {
  const gust = w.wind_gust_m_per_s === null ? "" : `, gusts ${w.wind_gust_m_per_s.toFixed(1)} m/s`;
  return `${w.condition}, rain ${w.precipitation_mm_per_hour.toFixed(1)} mm/h, wind ${w.wind_speed_m_per_s.toFixed(1)} m/s${gust}, ${w.temperature_c.toFixed(1)} °C`;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Execute one tool call. Returns the JSON-serialisable result for the model; throws on failure. */
export async function runTool(
  name: string,
  input: any,
  ctx: { state: RunState; trace: Trace; weather: WeatherProvider; request: string },
): Promise<unknown> {
  const { state, trace, weather } = ctx;

  switch (name) {
    case "read_activities": {
      const all = await readActivities();
      const rows = input.date ? all.filter((a) => a.date === input.date) : all;
      for (const a of rows) state.activities.set(a.activity_id, a);
      state.activitiesRead = true;
      trace.add({
        type: "tool", tool: "notion", action: "read_activities", status: "completed",
        result: `${rows.length} activities loaded${input.date ? ` for ${input.date}` : ""} (${all.length} in database)`,
      });
      return rows.map(({ page_id, ...a }) => a);
    }

    case "set_scope": {
      if (!state.activitiesRead) throw new Error("Call read_activities before set_scope.");
      if (state.scope) throw new Error(`Scope already set to ${state.scope.mode}; it cannot be changed within a run.`);
      const scope = resolveScope(ctx.request, [...state.activities.values()], input);
      state.scope = scope;
      const ids = [...scope.activityIds];
      trace.add({
        type: "agent", action: "set_scope", status: "completed",
        result: scope.mode === "not_tracked"
          ? `Not tracked: "${scope.description}" is not in the Notion field activities; no operational actions will be taken.`
          : `${scope.mode}: ${ids.length} activit${ids.length === 1 ? "y" : "ies"} in scope (${ids.join(", ") || "none"})`,
      });
      return { mode: scope.mode, activity_ids: ids };
    }

    case "get_weather": {
      const a = requireActivity(state, input.activity_id);
      const w = await weather.getWeather(a.location, a.date, a.start_time);
      state.weather.set(a.activity_id, w);
      const label = w.source === "mock" ? " [SIMULATED]" : "";
      trace.add({
        type: "tool", tool: w.source === "mock" ? "mock_weather" : "openweather", action: w.source === "mock" ? "forecast_simulated" : "forecast", status: "completed",
        activity_id: a.activity_id, result: `${a.location} ${a.start_time}${label}: ${fmtWeather(w)}`,
      });
      return w;
    }

    case "evaluate_risk": {
      const a = requireActivity(state, input.activity_id);
      const w = state.weather.get(a.activity_id);
      if (!w) throw new Error(`No weather for ${a.activity_id}. Call get_weather first.`);
      const d = decide(a, w);
      state.decisions.set(a.activity_id, d);
      trace.add({ type: "decision", tool: "decision_engine", status: "completed", activity_id: a.activity_id, decision: d.decision, reason: d.reason });
      return { ...d, thresholds: THRESHOLDS };
    }

    case "update_activity": {
      const a = requireActivity(state, input.activity_id);
      const d = state.decisions.get(a.activity_id);
      if (!d) throw new Error(`No decision for ${a.activity_id}. Call evaluate_risk first.`);
      if (d.decision === "PROCEED") throw new Error(`${a.activity_id} is PROCEED; Notion is only updated for FLAG or RESCHEDULE.`);
      if (state.updated.has(a.activity_id)) throw new Error(`${a.activity_id} was already updated in this run.`);
      const w = state.weather.get(a.activity_id)!;
      const note = `[FieldFlow ${today()}] ${d.decision}${w.source === "mock" ? " (simulated weather)" : ""}: ${d.reason} ${input.explanation}`.trim();
      const notes = a.notes ? `${a.notes}\n${note}` : note;
      await updateActivity(a.page_id!, { status: d.new_status, notes });
      state.updated.add(a.activity_id);
      trace.add({
        type: "tool", tool: "notion", action: "update_activity", status: "completed", activity_id: a.activity_id,
        result: `status ${a.status} → ${d.new_status}; reasoning appended to notes`,
      });
      return { activity_id: a.activity_id, status: d.new_status, note_appended: note };
    }

    case "notify_team": {
      const a = requireActivity(state, input.activity_id);
      const d = state.decisions.get(a.activity_id);
      if (!d) throw new Error(`No decision for ${a.activity_id}. Call evaluate_risk first.`);
      if (d.decision === "PROCEED") throw new Error(`${a.activity_id} is PROCEED; per-activity alerts are only for FLAG or RESCHEDULE. Include it in post_run_summary instead.`);
      if (state.notified.has(a.activity_id)) throw new Error(`${a.activity_id} was already notified in this run.`);
      const w = state.weather.get(a.activity_id)!;
      const icon = d.decision === "RESCHEDULE" ? ":red_circle:" : ":large_orange_circle:";
      const sim = w.source === "mock" ? "\n:warning: _Simulated weather (demo scenario), not a live forecast._" : "";
      const text = [
        `${icon} *${d.decision}* · ${a.activity_id} ${a.activity_name}`,
        `*Location / time:* ${a.location}, ${a.date} ${a.start_time} · priority ${a.priority}`,
        `*Weather:* ${fmtWeather(w)}`,
        `*Reason:* ${d.reason}`,
        `*Required action:* ${input.required_action}`,
        a.stakeholder ? `*External stakeholder:* ${a.stakeholder}` : "",
        `*Notion status:* ${state.updated.has(a.activity_id) ? d.new_status : a.status}`,
      ].filter(Boolean).join("\n") + sim;
      const res = await postMessage(text);
      state.notified.add(a.activity_id);
      trace.add({
        type: "tool", tool: "slack", action: "send_message", status: "completed", activity_id: a.activity_id,
        result: `${d.decision} alert posted to #field-ops (ts ${res.ts})`,
      });
      return { posted: true, ts: res.ts };
    }

    case "post_run_summary": {
      if (state.summaryPosted) throw new Error("Summary already posted in this run.");
      if (!state.scope) throw new Error("Call set_scope first.");
      if (state.scope.mode === "not_tracked") throw new Error("No summary is posted when the request is not about a tracked record.");
      const pending = [...state.scope.activityIds].filter((id) => !state.decisions.has(id));
      if (pending.length) throw new Error(`Not every activity is evaluated yet: ${pending.join(", ")}`);
      const counts = summarize(state);
      const simulated = [...state.weather.values()].some((w) => w.source === "mock");
      const lines = [...state.decisions.entries()].map(([id, d]) => {
        const a = state.activities.get(id)!;
        return `• ${d.decision} · ${id} ${a.activity_name} (${a.location} ${a.start_time})`;
      });
      const text = [
        `:clipboard: *FieldFlow review* · ${input.headline}`,
        `${counts.total} activities: ${counts.proceed} proceed, ${counts.flag} flagged, ${counts.reschedule} rescheduled`,
        ...lines,
        simulated ? ":warning: _Simulated weather (demo scenario), not a live forecast._" : "_Weather: live OpenWeather forecast._",
      ].join("\n");
      const res = await postMessage(text);
      state.summaryPosted = true;
      trace.add({ type: "tool", tool: "slack", action: "send_summary", status: "completed", result: `run summary posted to #field-ops (ts ${res.ts})` });
      return { posted: true, ts: res.ts };
    }

    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}

export function summarize(state: RunState) {
  const ds = [...state.decisions.values()];
  return {
    total: ds.length,
    proceed: ds.filter((d) => d.decision === "PROCEED").length,
    flag: ds.filter((d) => d.decision === "FLAG").length,
    reschedule: ds.filter((d) => d.decision === "RESCHEDULE").length,
  };
}
