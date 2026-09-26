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

Workflow for a review request:
1. Work out which date(s) the request covers, then call read_activities (with a date filter when the request names one).
2. For each relevant activity: get_weather, then evaluate_risk.
3. evaluate_risk is a deterministic rules engine with fixed thresholds. Its decision is final: never override, soften or second-guess it, and never invent thresholds.
4. For every FLAG or RESCHEDULE: call update_activity (explain the operational impact in plain language), then notify_team with a concrete required action. If the activity names an external stakeholder, the required action must say who contacts them and about what; stakeholder email is not automated yet.
5. PROCEED activities need no update or alert.
6. After all activities are handled, call post_run_summary once.
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
          const out = await runTool(block.name, block.input, { state, trace, weather });
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
  if (name === "read_activities" || name === "update_activity") return "notion";
  if (name === "get_weather") return "openweather";
  if (name === "notify_team" || name === "post_run_summary") return "slack";
  return "decision_engine";
}
