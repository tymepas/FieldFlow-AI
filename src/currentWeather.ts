import { assessConditions, type ConditionsAssessment } from "./decision/engine.ts";
import type { CurrentWeather, WeatherProvider } from "./weather/provider.ts";
import type { TraceStep } from "./agent/trace.ts";

/**
 * Weather at the user's current location. The coordinates come only from the browser's
 * Geolocation API after the user grants permission; they are used for this one lookup and
 * are not stored or logged.
 */
export interface Coordinates {
  latitude: number;
  longitude: number;
  /** Browser-reported accuracy radius in metres, if available. */
  accuracy_m: number | null;
}

export function parseCoordinates(body: unknown): { ok: true; coords: Coordinates } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.latitude === undefined || b.longitude === undefined || b.latitude === null || b.longitude === null) {
    return { ok: false, error: "latitude and longitude are required (from the browser's location permission)." };
  }
  const latitude = Number(b.latitude), longitude = Number(b.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, error: "latitude/longitude are out of range." };
  }
  const acc = Number(b.accuracy_m);
  return { ok: true, coords: { latitude, longitude, accuracy_m: Number.isFinite(acc) && acc >= 0 ? acc : null } };
}

export interface CurrentWeatherResponse {
  status: "completed" | "failed";
  location: Coordinates & { source: "browser geolocation (user permission)" };
  weather: CurrentWeather | null;
  assessment: ConditionsAssessment | null;
  steps: TraceStep[];
  error?: string;
}

export async function currentWeatherResult(body: unknown, weather: WeatherProvider): Promise<{ http: number; body: CurrentWeatherResponse | { status: "bad_request"; error: string } }> {
  const parsed = parseCoordinates(body);
  if (!parsed.ok) return { http: 400, body: { status: "bad_request", error: parsed.error } };
  const { coords } = parsed;
  const acc = coords.accuracy_m === null ? "" : ` (±${Math.round(coords.accuracy_m)} m)`;
  const steps: TraceStep[] = [
    { id: "step-1", type: "tool", status: "completed", action: "browser_location", result: `Location shared by the browser after user permission: ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}${acc}` },
  ];
  const location = { ...coords, source: "browser geolocation (user permission)" as const };
  try {
    const w = await weather.getCurrentWeather(coords.latitude, coords.longitude);
    const assessment = assessConditions({
      source: w.source,
      location: "current location",
      forecast_time: w.observed_at,
      condition: w.condition,
      precipitation_mm_per_hour: w.precipitation_mm_last_hour,
      wind_speed_m_per_s: w.wind_speed_m_per_s,
      wind_gust_m_per_s: w.wind_gust_m_per_s,
      temperature_c: w.temperature_c,
    });
    const gust = w.wind_gust_m_per_s === null ? "" : `, gusts ${w.wind_gust_m_per_s.toFixed(1)} m/s`;
    steps.push(
      {
        id: "step-2", type: "tool", tool: w.source === "mock" ? "mock_weather" : "openweather",
        action: w.source === "mock" ? "current_weather_simulated" : "current_weather", status: "completed",
        result: `Current weather [${w.provider_area}]: ${w.condition}, ${w.temperature_c.toFixed(1)} °C, rain ${w.precipitation_mm_last_hour.toFixed(1)} mm (last hour), wind ${w.wind_speed_m_per_s.toFixed(1)} m/s${gust}${w.source === "mock" ? " [SIMULATED]" : ""}`,
      },
      { id: "step-3", type: "decision", tool: "decision_engine", status: "completed", reason: `Current-conditions assessment (${assessment.level}): ${assessment.summary}` },
    );
    return { http: 200, body: { status: "completed", location, weather: w, assessment, steps } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    steps.push({ id: "step-2", type: "tool", tool: "openweather", action: "current_weather", status: "failed", error });
    return { http: 502, body: { status: "failed", location, weather: null, assessment: null, steps, error: "Current weather could not be retrieved." } };
  }
}
