import { randomUUID } from "node:crypto";
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
} from "@anthropic-ai/sdk";
import { TOOL_USE_INSTRUCTIONS } from "@swytchcode/runtime";
import { redact } from "../swytch.ts";
import { getWeatherProvider } from "../weather/index.ts";
import type { WeatherProvider } from "../weather/provider.ts";
import { newRunState, runTool, summarize, TOOLS, type RunState } from "./tools.ts";
import { Trace, type TraceStep } from "./trace.ts";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const MAX_TURNS = 40;
const TIMEZONE = "Asia/Kolkata";

const SYSTEM = `You are FieldFlow AI, an operations continuity agent for a field-operations coordinator.
You reconcile planned field activities against real-world weather and coordinate the response.

Scope — the tracked operational scope is exactly the records in the Notion Field Activities database:
- After read_activities, call set_scope once, before any other tool.
- schedule_review: when the user asks about the scheduled operations in general — e.g. what is affected, whether anything needs to change, or to review a day — without introducing an event, place or route of their own.
- In set_scope, list in untracked_subjects every specific event, activity, place or route the user mentioned that is not a tracked record.
- specific_activities: only for tracked records the user explicitly named (by activity id or activity name).
- adhoc: when the user asks about their own event, visit or place that is not a tracked record (e.g. "I have a hackathon tomorrow in Gurgaon Sector 59, check the weather", "check the weather for Gurgaon tomorrow"). Never substitute a similar or "closest" tracked record (for example one in the same city) and never broaden the request into a full schedule review.
- not_tracked: when the request cannot be served at all (not a weather/operations question). Take no action and explain why.
- There is no traffic or route integration. Where someone is coming from (e.g. "coming from Rohini") is context only: check the destination's weather and never claim to have analysed traffic, route or commute.

Workflow for an adhoc request:
1. read_activities, then set_scope with mode adhoc.
2. get_location_weather once, with the place as the user named it and the date they meant (the time only if they gave one). Places in FieldFlow's place directory are resolved automatically; for any other place also pass your best latitude/longitude. Mention the provider's area name and how the coordinates were obtained (location_resolution).
3. Its assessment (low / caution / significant) uses the same fixed thresholds as tracked activities; do not override it.
4. Only if the user asked to record/log it in Notion: record_review_in_notion. Only if the user asked to update Slack / tell the team: post_team_update. Never create or modify a Field Activities record for an adhoc request.
5. Finish with a short plain-language answer: the weather, what it means for their plan, and which actions were actually taken.

Workflow for a tracked request (schedule_review or specific_activities):
1. Work out which date(s) the request covers, then call read_activities (with a date filter when the request names one), then set_scope.
2. For each in-scope activity: get_weather, then evaluate_risk.
3. evaluate_risk is a deterministic rules engine with fixed thresholds. Its decision is final: never override, soften or second-guess it, and never invent thresholds.
4. For every FLAG or RESCHEDULE: call update_activity (explain the operational impact in plain language), then notify_team with a concrete required action. If the activity names an external stakeholder, the required action must say who contacts them and about what; stakeholder email is not automated yet.
5. PROCEED activities need no update or alert.
6. After all in-scope activities are handled, call post_run_summary once (not for not_tracked).
7. Finish with a short plain-text summary for the coordinator.

Weather marked source "mock" is a simulated demo scenario; say so whenever you describe it.
If a tool fails, report the failure honestly rather than claiming success.

${TOOL_USE_INSTRUCTIONS}`;

export interface RunResponse {
  request: string;
  status: "completed" | "completed_with_errors" | "failed";
  summary: { total: number; proceed: number; flag: number; reschedule: number };
  steps: TraceStep[];
  /** Per-activity decisions and the actions taken. */
  activities: Array<{
    activity_id: string;
    activity_name: string;
    decision: string;
    reason: string;
    weather_source: string;
    notion_updated: boolean;
    slack_notified: boolean;
  }>;
  agent_summary: string;
  weather_provider: string;
  model: string;
  /** Identifies this completed run for follow-up actions such as POST /email-result. */
  run_id: string;
  /** The scope the agent declared (null if it never got that far). */
  scope: { mode: string; description: string } | null;
  /** Ad-hoc review result, present only for adhoc requests that fetched weather. */
  adhoc: {
    place: string;
    date: string;
    time: string | null;
    provider_area: string;
    /** How the coordinates were obtained (place directory, or agent estimate). */
    location_resolution: string;
    latitude: number;
    longitude: number;
    weather_source: string;
    condition: string;
    precipitation_mm_per_hour_max: number;
    wind_speed_m_per_s_max: number;
    wind_gust_m_per_s_max: number | null;
    temperature_c_min: number;
    temperature_c_max: number;
    assessment_level: string;
    assessment: string;
    notion_recorded: boolean;
    slack_notified: boolean;
  } | null;
}

export async function runAgent(request: string, opts: { weather?: WeatherProvider } = {}): Promise<RunResponse> {
  const client = new Anthropic();
  const weather = opts.weather ?? getWeatherProvider();
  const state: RunState = newRunState();
  const trace = new Trace();
  const now = new Date();
  const localDate = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Today is ${localDate} (${TIMEZONE}).\n\nRequest: ${request}` },
  ];
  let agentSummary = "";
  let failed = false;

  try {
    for (let turn = 0; ; turn++) {
      if (turn >= MAX_TURNS) throw new Error(`Exceeded ${MAX_TURNS} agent turns`);

      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          trace.add({ type: "agent", status: "completed", result: block.text.trim() });
          agentSummary = block.text.trim();
        }
      }

      if (response.stop_reason === "refusal") throw new Error(`Model refused: ${response.stop_details?.explanation ?? "no details"}`);
      if (response.stop_reason === "max_tokens") throw new Error("Model response truncated at max_tokens");
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      // Sequential on purpose: keeps the trace order deterministic and readable.
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const out = await runTool(block.name, block.input, { state, trace, weather, request });
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const input = block.input as { activity_id?: string };
          trace.add({
            type: "tool", tool: toolProvider(block.name), action: block.name, status: "failed",
            activity_id: input?.activity_id, error: message,
          });
          results.push({ type: "tool_result", tool_use_id: block.id, content: message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    failed = true;
    logAgentFailure(e);
    trace.add({ type: "agent", status: "failed", error: e instanceof Error ? e.message : String(e) });
  }

  const hadToolErrors = trace.steps.some((s) => s.status === "failed");
  return {
    request,
    status: failed ? "failed" : hadToolErrors ? "completed_with_errors" : "completed",
    summary: summarize(state),
    steps: trace.steps,
    activities: [...state.decisions.entries()].map(([id, d]) => ({
      activity_id: id,
      activity_name: state.activities.get(id)!.activity_name,
      decision: d.decision,
      reason: d.reason,
      weather_source: state.weather.get(id)!.source,
      notion_updated: state.updated.has(id),
      slack_notified: state.notified.has(id),
    })),
    agent_summary: agentSummary,
    weather_provider: weather.name,
    model: MODEL,
    run_id: randomUUID(),
    scope: state.scope ? { mode: state.scope.mode, description: state.scope.description } : null,
    adhoc: adhocResult(state),
  };
}

/**
 * Development-only metadata for failures before the agent can create a tool trace.
 * It intentionally excludes request/response headers and applies the existing API-key
 * redaction before writing text to the terminal.
 */
function logAgentFailure(error: unknown): void {
  if (process.env.NODE_ENV === "production") return;

  const err = error instanceof Error ? error : new Error(String(error));
  const details: Record<string, string | number | null | undefined> = {
    category: "unknown",
    name: err.name,
    class: err.constructor.name,
    message: redact(err.message),
  };

  if (error instanceof APIConnectionTimeoutError) {
    details.category = "timeout";
  } else if (error instanceof APIConnectionError) {
    details.category = "network";
  } else if (error instanceof APIError) {
    details.category = error instanceof AuthenticationError ? "authentication" : "api";
    details.http_status = error.status;
    details.anthropic_error_type = error.type;
  }

  const withMetadata = err as Error & { code?: unknown; cause?: unknown };
  if (typeof withMetadata.code === "string" || typeof withMetadata.code === "number") {
    details.code = withMetadata.code;
  }
  if (withMetadata.cause instanceof Error) {
    details.cause_name = withMetadata.cause.name;
    details.cause_message = redact(withMetadata.cause.message);
    const cause = withMetadata.cause as Error & { code?: unknown };
    if (typeof cause.code === "string" || typeof cause.code === "number") details.cause_code = cause.code;
  }

  console.error("[agent] request failure diagnostic", details);
}

function toolProvider(name: string): TraceStep["tool"] {
  if (name === "read_activities" || name === "update_activity" || name === "record_review_in_notion") return "notion";
  if (name === "get_weather" || name === "get_location_weather") return "openweather";
  if (name === "set_scope") return undefined;
  if (name === "notify_team" || name === "post_run_summary" || name === "post_team_update") return "slack";
  return "decision_engine";
}

function adhocResult(state: RunState): RunResponse["adhoc"] {
  const { place, resolution, forecast: f, assessment: a, notionPage, slackTs } = state.adhoc;
  if (!place || !f || !a) return null;
  return {
    place,
    date: f.date,
    time: f.time,
    provider_area: f.provider_area,
    location_resolution: resolution ?? "estimated by the agent",
    latitude: f.latitude,
    longitude: f.longitude,
    weather_source: f.source,
    condition: f.worst.condition,
    precipitation_mm_per_hour_max: f.worst.precipitation_mm_per_hour,
    wind_speed_m_per_s_max: f.worst.wind_speed_m_per_s,
    wind_gust_m_per_s_max: f.worst.wind_gust_m_per_s,
    temperature_c_min: f.temperature_c_min,
    temperature_c_max: f.worst.temperature_c,
    assessment_level: a.level,
    assessment: a.summary,
    notion_recorded: !!notionPage,
    slack_notified: !!slackTs,
  };
}
