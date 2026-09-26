import type { NormalizedWeather } from "../types.ts";

/** Forecast for an ad-hoc place (not a tracked activity) on one local date. */
export interface AreaForecast {
  source: NormalizedWeather["source"];
  latitude: number;
  longitude: number;
  /** Area name the weather provider itself reports for these coordinates. */
  provider_area: string;
  date: string;
  /** Local HH:MM if the request named a time, else null (whole-day forecast). */
  time: string | null;
  /** Number of forecast slots summarised. */
  slots: number;
  /** Worst-case values across those slots, in NormalizedWeather units. */
  worst: NormalizedWeather;
  temperature_c_min: number;
}

/**
 * Weather source seam. The decision engine only ever sees NormalizedWeather,
 * so a provider can be swapped (mock ↔ OpenWeather) without touching the rules.
 */
export interface WeatherProvider {
  readonly name: NormalizedWeather["source"];
  /** Weather for a tracked location at a local date (YYYY-MM-DD) and time (HH:MM). */
  getWeather(location: string, date: string, time: string): Promise<NormalizedWeather>;
  /** Forecast for arbitrary coordinates on a local date, optionally at a local time. */
  getAreaForecast(place: string, latitude: number, longitude: number, date: string, time?: string): Promise<AreaForecast>;
}
