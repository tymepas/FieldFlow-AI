import type Anthropic from "@anthropic-ai/sdk";
import { assessConditions, decide, THRESHOLDS, type ConditionsAssessment } from "../decision/engine.ts";
import { createReviewPage, readActivities, updateActivity } from "../integrations/notion.ts";
import { postMessage } from "../integrations/slack.ts";
import type { AreaForecast, WeatherProvider } from "../weather/provider.ts";
import type { Activity, DecisionResult, NormalizedWeather } from "../types.ts";
import type { Trace } from "./trace.ts";
import { asksForNotion, asksForSlack, resolveScope, type RunScope } from "./scope.ts";
import { resolvePlace } from "../weather/places.ts";

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
  /** Ad-hoc (untracked place/event) review state, only used when scope.mode is "adhoc". */
  adhoc: {
    place?: string;
    /** How the coordinates were obtained, shown wherever they are. */
    resolution?: string;
    forecast?: AreaForecast;
    assessment?: ConditionsAssessment;
    notionPage?: { id: string; url?: string };
    slackTs?: string;
  };
}

export function newRunState(): RunState {
  return { activities: new Map(), weather: new Map(), decisions: new Map(), updated: new Set(), notified: new Set(), summaryPosted: false, activitiesRead: false, adhoc: {} };
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
      "Declare what this request is about. Call once, after read_activities and before any other tool. schedule_review: the user asked about the scheduled operations in general (optionally one date). specific_activities: the user explicitly named tracked records (by id or activity name). adhoc: the user asked about their own event or place that is not a tracked record (e.g. weather for a venue or a visit); tracked records are never touched, weather for that place is checked with get_location_weather. not_tracked: the request cannot be served (not a weather/operations question, or it needs something unsupported); no actions are allowed. Never pick a similar or closest tracked record as a proxy.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["schedule_review", "specific_activities", "adhoc", "not_tracked"] },
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
  {
    name: "get_location_weather",
    description:
      "adhoc scope only. Real forecast for the user's own place on a date (whole day, or the slot nearest a time if they gave one), graded by the same fixed thresholds as tracked activities. Places in FieldFlow's place directory (e.g. Gurgaon Sector 59) are resolved to verified coordinates automatically. For any other place, supply your best latitude/longitude; it is labelled as an estimate. The result shows the area name the weather provider reports. Never use a tracked activity's location as a stand-in. Call once.",
    input_schema: {
      type: "object",
      properties: {
        place: { type: "string", description: "The place as the user described it, e.g. 'Gurgaon Sector 59'." },
        latitude: { type: "number", description: "Only if the place may not be in the directory: best-estimate latitude (-90..90)." },
        longitude: { type: "number", description: "Only if the place may not be in the directory: best-estimate longitude (-180..180)." },
        date: { type: "string", description: "Local ISO date (YYYY-MM-DD) the user asked about." },
        time: { type: "string", description: "Local HH:MM if the user named a time; omit for the whole day." },
      },
      required: ["place", "date"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "record_review_in_notion",
    description:
      "adhoc scope only, and only if the user asked to record/log it in Notion. Creates an 'Ad-hoc operational review' page under the FieldFlow page (never a Field Activities record) with the request, place, date, weather, assessment and requested actions. Call once, after get_location_weather.",
    input_schema: {
      type: "object",
      properties: { operational_note: { type: "string", description: "One or two sentences: what the weather means for the user's plan." } },
      required: ["operational_note"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "post_team_update",
    description:
      "adhoc scope only, and only if the user asked to update Slack / tell the team. Posts the ad-hoc weather review to #field-ops. Call once, after get_location_weather.",
    input_schema: {
      type: "object",
      properties: { message: { type: "string", description: "One or two sentences for the team: what the weather means for the user's plan." } },
      required: ["message"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function requireAdhoc(state: RunState, needForecast: boolean): NonNullable<RunState["adhoc"]> {
  if (!state.scope) throw new Error("Call set_scope first.");
  if (state.scope.mode !== "adhoc") throw new Error(`This tool is only for adhoc requests; the scope is ${state.scope.mode}.`);
  if (needForecast && !state.adhoc.forecast) throw new Error("Call get_location_weather first.");
  return state.adhoc;
}

function fmtArea(f: AreaForecast, place: string, resolution: string): string {
  const when = f.time ? `${f.date} ${f.time}` : `${f.date} (whole day, ${f.slots} forecast slots)`;
  const w = f.worst;
  const gust = w.wind_gust_m_per_s === null ? "" : `, gusts up to ${w.wind_gust_m_per_s.toFixed(1)} m/s`;
  return `${place} ${when} [${f.provider_area}; coordinates ≈${f.latitude.toFixed(3)}, ${f.longitude.toFixed(3)} ${resolution}]: ${w.condition}; rain up to ${w.precipitation_mm_per_hour.toFixed(1)} mm/h, wind up to ${w.wind_speed_m_per_s.toFixed(1)} m/s${gust}, ${f.temperature_c_min.toFixed(1)}–${w.temperature_c.toFixed(1)} °C`;
}

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
          ? `Not tracked: "${scope.description}" is outside what FieldFlow can act on; no operational actions were taken.`
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
      if (state.scope.mode === "adhoc") throw new Error("post_run_summary is for tracked reviews; for adhoc requests use post_team_update, and only if the user asked for Slack.");
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

    case "get_location_weather": {
      const adhoc = requireAdhoc(state, false);
      if (adhoc.forecast) throw new Error("get_location_weather was already called for this request.");
      const place = String(input.place ?? "").trim();
      if (!place) throw new Error("place is required.");
      // Directory first (verified coordinates); otherwise the agent's labelled estimate.
      const known = resolvePlace(place);
      let lat: number, lon: number, resolution: string;
      if (known) {
        [lat, lon, resolution] = [known.latitude, known.longitude, `from FieldFlow's place directory (${known.source})`];
      } else {
        lat = Number(input.latitude);
        lon = Number(input.longitude);
        if (input.latitude === undefined || input.longitude === undefined) {
          throw new Error(`"${place}" is not in FieldFlow's place directory; supply your best latitude/longitude for it.`);
        }
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
          throw new Error("latitude/longitude out of range.");
        }
        resolution = "estimated by the agent";
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "")) throw new Error("date must be YYYY-MM-DD.");
      if (input.time !== undefined && !/^\d{2}:\d{2}$/.test(input.time)) throw new Error("time must be HH:MM.");
      const forecast = await weather.getAreaForecast(place, lat, lon, input.date, input.time);
      const assessment = assessConditions(forecast.worst);
      Object.assign(adhoc, { place, forecast, assessment, resolution });
      trace.add({
        type: "tool", tool: forecast.source === "mock" ? "mock_weather" : "openweather",
        action: forecast.source === "mock" ? "area_forecast_simulated" : "area_forecast", status: "completed",
        result: fmtArea(forecast, place, resolution) + (forecast.source === "mock" ? " [SIMULATED]" : ""),
      });
      trace.add({ type: "decision", tool: "decision_engine", status: "completed", reason: `Ad-hoc weather assessment (${assessment.level}): ${assessment.summary}` });
      return { place, location_resolution: resolution, forecast, assessment, thresholds: THRESHOLDS };
    }

    case "record_review_in_notion": {
      const adhoc = requireAdhoc(state, true);
      if (!asksForNotion(ctx.request)) throw new Error("The user did not ask to record this in Notion; do not write to Notion.");
      if (adhoc.notionPage) throw new Error("This ad-hoc review was already recorded in Notion.");
      const f = adhoc.forecast!, a = adhoc.assessment!;
      const requested = [asksForNotion(ctx.request) && "Notion record", asksForSlack(ctx.request) && "Slack update"].filter(Boolean).join(", ");
      const page = await createReviewPage(`Ad-hoc operational review · ${adhoc.place} · ${f.date}`, [
        { label: "Record type", value: "Ad-hoc operational review (not a planned Field Activity)" },
        { label: "Request", value: ctx.request },
        { label: "Location", value: `${adhoc.place} (weather area: ${f.provider_area}; coordinates ≈${f.latitude.toFixed(3)}, ${f.longitude.toFixed(3)}, ${adhoc.resolution})` },
        { label: "Date", value: f.time ? `${f.date} ${f.time}` : `${f.date} (whole day)` },
        { label: "Weather", value: fmtArea(f, adhoc.place!, adhoc.resolution!).split("]: ")[1] ?? f.worst.condition },
        { label: "Assessment", value: `${a.level.toUpperCase()}: ${a.summary}` },
        { label: "Operational note", value: String(input.operational_note ?? "") },
        { label: "Actions requested", value: requested || "none" },
        { label: "Weather source", value: f.source === "mock" ? "SIMULATED (demo scenario, not a live forecast)" : "OpenWeather (live forecast via SwytchCode)" },
        { label: "Recorded", value: new Date().toISOString() },
      ]);
      adhoc.notionPage = page;
      trace.add({ type: "tool", tool: "notion", action: "create_review_page", status: "completed", result: `Ad-hoc review page created in Notion (${page.id})` });
      return { recorded: true, page_id: page.id };
    }

    case "post_team_update": {
      const adhoc = requireAdhoc(state, true);
      if (!asksForSlack(ctx.request)) throw new Error("The user did not ask to update Slack; do not post.");
      if (adhoc.slackTs) throw new Error("The team was already updated for this request.");
      const f = adhoc.forecast!, a = adhoc.assessment!;
      const icon = a.level === "significant" ? ":red_circle:" : a.level === "caution" ? ":large_orange_circle:" : ":large_blue_circle:";
      const text = [
        `${icon} *Ad-hoc weather review* · ${adhoc.place} · ${f.time ? `${f.date} ${f.time}` : f.date}`,
        `*Weather:* ${fmtArea(f, adhoc.place!, adhoc.resolution!).split("]: ")[1] ?? f.worst.condition}`,
        `*Assessment:* ${a.level.toUpperCase()} — ${a.summary}`,
        `*Note:* ${String(input.message ?? "")}`,
        adhoc.notionPage ? "*Notion:* ad-hoc review recorded" : "",
        f.source === "mock" ? ":warning: _Simulated weather (demo scenario), not a live forecast._" : "_Weather: live OpenWeather forecast._",
      ].filter(Boolean).join("\n");
      const res = await postMessage(text);
      adhoc.slackTs = res.ts;
      trace.add({ type: "tool", tool: "slack", action: "send_message", status: "completed", result: `Ad-hoc weather review posted to #field-ops (ts ${res.ts})` });
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
