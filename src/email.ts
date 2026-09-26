import type { RunResponse } from "./agent/run.ts";

/** Plain-text email built only from a completed run's actual result — nothing is re-run or invented. */
export function composeResultEmail(r: RunResponse): { subject: string; text: string } {
  const steps = r.steps.filter((s) => s.status === "completed");
  const notionWrites = steps.filter((s) => s.tool === "notion" && s.action !== "read_activities").length;
  const slackPosts = steps.filter((s) => s.tool === "slack").length;
  const simulated = r.weather_provider === "mock" || r.adhoc?.weather_source === "mock";
  const lines: string[] = ["FieldFlow AI — operations result", "", `Request: ${r.request}`, `Status: ${r.status}`];
  let subject: string;

  if (r.adhoc) {
    const a = r.adhoc;
    const gust = a.wind_gust_m_per_s_max === null ? "" : `, gusts up to ${a.wind_gust_m_per_s_max.toFixed(1)} m/s`;
    subject = `FieldFlow: ${a.place} ${a.date} — ${a.assessment_level} weather risk`;
    lines.push(
      "",
      "AD-HOC WEATHER REVIEW",
      `Place: ${a.place} (weather area: ${a.provider_area}; coordinates ${a.location_resolution})`,
      `Date: ${a.time ? `${a.date} ${a.time}` : `${a.date} (whole day)`}`,
      `Weather: ${a.condition}; rain up to ${a.precipitation_mm_per_hour_max.toFixed(1)} mm/h, wind up to ${a.wind_speed_m_per_s_max.toFixed(1)} m/s${gust}, ${a.temperature_c_min.toFixed(1)}–${a.temperature_c_max.toFixed(1)} °C`,
      `Assessment: ${a.assessment_level.toUpperCase()} — ${a.assessment}`,
    );
  } else if (r.summary.total > 0) {
    const attention = r.summary.flag + r.summary.reschedule;
    subject = `FieldFlow: ${attention === 0 ? "all activities clear" : `${attention} activit${attention === 1 ? "y needs" : "ies need"} attention`}`;
    lines.push(
      "",
      "OPERATIONS REVIEW",
      `${r.summary.total} activities: ${r.summary.proceed} proceed, ${r.summary.flag} flagged, ${r.summary.reschedule} rescheduled`,
      "",
      ...r.activities.map((a) => `- ${a.decision} · ${a.activity_id} ${a.activity_name}: ${a.reason}`),
    );
  } else {
    subject = "FieldFlow: request result";
  }

  lines.push(
    "",
    "ACTIONS TAKEN",
    `Notion: ${notionWrites ? `${notionWrites} update${notionWrites === 1 ? "" : "s"}` : "no changes"}`,
    `Slack: ${slackPosts ? `${slackPosts} message${slackPosts === 1 ? "" : "s"} posted` : "no messages"}`,
  );
  if (simulated) lines.push("", "Note: weather in this run was SIMULATED (demo scenario), not a live forecast.");
  if (r.agent_summary) lines.push("", "AGENT SUMMARY", r.agent_summary);
  lines.push("", `FieldFlow execution: ${r.steps.length} recorded steps · model ${r.model} · run ${r.run_id}`);
  return { subject, text: lines.join("\n") };
}

type EmailState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; message_id: string; sent_at: string }
  | { status: "failed"; error: string };

/** Completed runs kept in memory so a result can be emailed later without re-running the agent. */
export class ResultStore {
  private runs = new Map<string, { result: RunResponse; email: EmailState }>();
  constructor(private readonly max = 50) {}

  put(result: RunResponse): void {
    this.runs.set(result.run_id, { result, email: { status: "idle" } });
    while (this.runs.size > this.max) this.runs.delete(this.runs.keys().next().value!);
  }

  get(runId: string) {
    return this.runs.get(runId);
  }
}

export interface MailDeps {
  getAddress: () => Promise<string>;
  send: (to: string, subject: string, text: string) => Promise<string>;
  redact?: (s: string) => string;
}

/**
 * Email a stored result to the connected Gmail account, once. A second request after a
 * successful send is refused (no duplicates); a request while one is in flight is refused;
 * after a failure the same request may be retried.
 */
export async function emailStoredResult(store: ResultStore, runId: string, deps: MailDeps): Promise<{ http: number; body: Record<string, unknown> }> {
  const entry = store.get(runId);
  if (!entry) return { http: 404, body: { status: "not_found", error: "Unknown or expired run_id. Run the review again." } };
  if (entry.result.status === "failed") return { http: 400, body: { status: "not_emailable", error: "This run failed; there is no completed result to email." } };
  if (entry.email.status === "sending") return { http: 409, body: { status: "sending", error: "An email for this result is already being sent." } };
  if (entry.email.status === "sent") {
    return { http: 409, body: { status: "already_sent", message: "This result was already emailed.", sent_at: entry.email.sent_at } };
  }

  entry.email = { status: "sending" };
  try {
    const { subject, text } = composeResultEmail(entry.result);
    const to = await deps.getAddress();
    const messageId = await deps.send(to, subject, text);
    const sent_at = new Date().toISOString();
    entry.email = { status: "sent", message_id: messageId, sent_at };
    const step = { id: `step-${entry.result.steps.length + 1}`, type: "tool", tool: "gmail", action: "send_email", status: "completed", result: `Result emailed to the connected Gmail account (message ${messageId})` };
    entry.result.steps.push(step as RunResponse["steps"][number]);
    return { http: 200, body: { status: "sent", message: "Result emailed to your connected Gmail account.", sent_at, step } };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const error = deps.redact ? deps.redact(raw) : raw;
    entry.email = { status: "failed", error };
    const step = { id: `step-${entry.result.steps.length + 1}`, type: "tool", tool: "gmail", action: "send_email", status: "failed", error };
    return { http: 502, body: { status: "failed", error: "Email could not be sent.", detail: error, step } };
  }
}
