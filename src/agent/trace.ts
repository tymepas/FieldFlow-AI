import type { Decision } from "../types.ts";

/** One entry of the execution trace (docs/API-CONTRACT.md). Recorded by code, never by the model. */
export interface TraceStep {
  id: string;
  type: "tool" | "decision" | "agent";
  status: "completed" | "failed" | "skipped";
  tool?: "notion" | "openweather" | "mock_weather" | "slack" | "decision_engine" | "gmail";
  action?: string;
  result?: string;
  decision?: Decision;
  reason?: string;
  activity_id?: string;
  error?: string;
}

export class Trace {
  readonly steps: TraceStep[] = [];

  add(step: Omit<TraceStep, "id">): TraceStep {
    const full = { id: `step-${this.steps.length + 1}`, ...step };
    this.steps.push(full);
    const tag = full.type === "decision" ? `DECISION ${full.decision}` : `${full.tool ?? full.type}.${full.action ?? ""}`;
    console.log(`[trace] ${full.id} ${tag} ${full.status}${full.activity_id ? ` ${full.activity_id}` : ""}: ${full.result ?? full.reason ?? full.error ?? ""}`);
    return full;
  }
}
