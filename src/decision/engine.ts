import type { Activity, DecisionResult, NormalizedWeather } from "../types.ts";

/**
 * Operational thresholds. These are the ONLY place thresholds live; the LLM
 * never sets or changes them. Units match NormalizedWeather field names.
 * Sources are documented in docs/DECISION-ENGINE.md.
 */
export const THRESHOLDS = {
  /** Moderate rain lower bound (mm/h). Meteorological "moderate": 2.5–7.6 mm/h. */
  moderate_rain_mm_per_hour: 2.5,
  /** Heavy rain lower bound (mm/h). Meteorological "heavy": > 7.6 mm/h. */
  heavy_rain_mm_per_hour: 7.6,
  /** High sustained wind (m/s). Beaufort 6 "strong breeze" starts at 10.8 m/s. */
  high_wind_m_per_s: 10.8,
  /** High gust (m/s). Beaufort 8 "gale" starts at 17.2 m/s. */
  high_gust_m_per_s: 17.2,
  /** Extreme heat (°C). IMD heatwave criterion for the plains: max temp ≥ 40 °C. */
  extreme_heat_c: 40,
} as const;

interface Signals {
  heavy_rain: boolean;
  moderate_rain: boolean;
  high_wind: boolean;
  extreme_heat: boolean;
}

export function readSignals(w: NormalizedWeather): Signals {
  const rain = w.precipitation_mm_per_hour;
  return {
    heavy_rain: rain >= THRESHOLDS.heavy_rain_mm_per_hour,
    moderate_rain: rain >= THRESHOLDS.moderate_rain_mm_per_hour && rain < THRESHOLDS.heavy_rain_mm_per_hour,
    high_wind:
      w.wind_speed_m_per_s >= THRESHOLDS.high_wind_m_per_s ||
      (w.wind_gust_m_per_s !== null && w.wind_gust_m_per_s >= THRESHOLDS.high_gust_m_per_s),
    extreme_heat: w.temperature_c >= THRESHOLDS.extreme_heat_c,
  };
}

function describe(signal: keyof Signals, w: NormalizedWeather): string {
  switch (signal) {
    case "heavy_rain":
      return `heavy rain ${w.precipitation_mm_per_hour.toFixed(1)} mm/h (≥ ${THRESHOLDS.heavy_rain_mm_per_hour})`;
    case "moderate_rain":
      return `moderate rain ${w.precipitation_mm_per_hour.toFixed(1)} mm/h (≥ ${THRESHOLDS.moderate_rain_mm_per_hour})`;
    case "high_wind": {
      const gust = w.wind_gust_m_per_s === null ? "" : `, gusts ${w.wind_gust_m_per_s.toFixed(1)} m/s`;
      return `high wind ${w.wind_speed_m_per_s.toFixed(1)} m/s${gust} (≥ ${THRESHOLDS.high_wind_m_per_s} sustained / ${THRESHOLDS.high_gust_m_per_s} gust)`;
    }
    case "extreme_heat":
      return `extreme heat ${w.temperature_c.toFixed(1)} °C (≥ ${THRESHOLDS.extreme_heat_c})`;
  }
}

export type AdvisoryLevel = "low" | "caution" | "significant";

export interface ConditionsAssessment {
  level: AdvisoryLevel;
  /** Rule ids that fired, e.g. ["heavy_rain"]. */
  triggered: string[];
  /** Plain-language finding that quotes measured values and thresholds. */
  summary: string;
}

/**
 * Ad-hoc (untracked) requests have no activity type, so no PROCEED/FLAG/RESCHEDULE rule
 * applies. Instead the same thresholds grade the conditions: heavy rain or high wind is
 * significant, moderate rain or extreme heat calls for caution, anything else is low risk.
 */
export function assessConditions(weather: NormalizedWeather): ConditionsAssessment {
  const signals = readSignals(weather);
  const significant = (["heavy_rain", "high_wind"] as const).filter((s) => signals[s]);
  const caution = (["moderate_rain", "extreme_heat"] as const).filter((s) => signals[s]);
  if (significant.length > 0) {
    const all = [...significant, ...caution];
    return { level: "significant", triggered: all, summary: `Significant weather risk: ${all.map((s) => describe(s, weather)).join("; ")}.` };
  }
  if (caution.length > 0) {
    return { level: "caution", triggered: caution, summary: `Some weather risk: ${caution.map((s) => describe(s, weather)).join("; ")}.` };
  }
  return {
    level: "low",
    triggered: [],
    summary: `No significant weather risk (${weather.condition}, ${weather.precipitation_mm_per_hour.toFixed(1)} mm/h rain, ${weather.wind_speed_m_per_s.toFixed(1)} m/s wind, up to ${weather.temperature_c.toFixed(1)} °C).`,
  };
}

const LABEL: Record<Activity["activity_type"], string> = {
  outdoor_inspection: "Outdoor inspection",
  outdoor_installation: "Outdoor installation",
  indoor: "Indoor activity",
};

/** Rule table: which signals cause RESCHEDULE / FLAG for each activity type. */
const RULES: Record<Activity["activity_type"], { reschedule: (keyof Signals)[]; flag: (keyof Signals)[] }> = {
  outdoor_inspection: { reschedule: ["heavy_rain"], flag: ["high_wind", "extreme_heat"] },
  outdoor_installation: { reschedule: ["heavy_rain", "high_wind"], flag: ["moderate_rain"] },
  indoor: { reschedule: [], flag: [] },
};

export function decide(activity: Activity, weather: NormalizedWeather): DecisionResult {
  const signals = readSignals(weather);
  const rules = RULES[activity.activity_type];
  const label = LABEL[activity.activity_type];

  const reschedule = rules.reschedule.filter((s) => signals[s]);
  if (reschedule.length > 0) {
    return {
      decision: "RESCHEDULE",
      reason: `${label}: ${reschedule.map((s) => describe(s, weather)).join("; ")} exceeds the reschedule threshold.`,
      triggered: reschedule,
      new_status: "rescheduled",
    };
  }

  const flag = rules.flag.filter((s) => signals[s]);
  if (flag.length > 0) {
    return {
      decision: "FLAG",
      reason: `${label}: ${flag.map((s) => describe(s, weather)).join("; ")} exceeds the flag threshold.`,
      triggered: flag,
      new_status: "flagged",
    };
  }

  return {
    decision: "PROCEED",
    reason:
      activity.activity_type === "indoor"
        ? `${label}: weather does not materially affect indoor work.`
        : `${label}: conditions within limits (${weather.condition}, ${weather.precipitation_mm_per_hour.toFixed(1)} mm/h rain, ${weather.wind_speed_m_per_s.toFixed(1)} m/s wind, ${weather.temperature_c.toFixed(1)} °C).`,
    triggered: [],
    new_status: "proceed",
  };
}
