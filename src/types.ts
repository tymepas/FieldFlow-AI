export type ActivityType = "outdoor_inspection" | "outdoor_installation" | "indoor";
export type Priority = "high" | "medium" | "low";
export type ActivityStatus = "planned" | "proceed" | "flagged" | "rescheduled";
export type Decision = "PROCEED" | "FLAG" | "RESCHEDULE";

export interface Activity {
  activity_id: string;
  activity_name: string;
  location: string;
  date: string; // ISO date, YYYY-MM-DD
  start_time: string; // HH:MM, local time at the activity location
  activity_type: ActivityType;
  priority: Priority;
  stakeholder: string;
  status: ActivityStatus;
  notes: string;
  /** Notion page id, present when the activity was loaded from Notion. */
  page_id?: string;
}

/**
 * Provider-independent weather snapshot for one activity slot.
 * Every numeric field carries its unit in the name so the decision engine
 * never depends on a provider's response format or unit system.
 */
export interface NormalizedWeather {
  source: "openweather" | "mock";
  location: string;
  /** ISO timestamp of the forecast slot used. */
  forecast_time: string;
  condition: string;
  precipitation_mm_per_hour: number;
  wind_speed_m_per_s: number;
  wind_gust_m_per_s: number | null;
  temperature_c: number;
}

export interface DecisionResult {
  decision: Decision;
  /** Human-readable reason built from the rules that fired. */
  reason: string;
  /** Machine-readable rule ids that fired, e.g. ["heavy_rain"]. */
  triggered: string[];
  new_status: ActivityStatus;
}
