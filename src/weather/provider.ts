import type { NormalizedWeather } from "../types.ts";

/**
 * Weather source seam. The decision engine only ever sees NormalizedWeather,
 * so a provider can be swapped (mock ↔ OpenWeather) without touching the rules.
 */
export interface WeatherProvider {
  readonly name: NormalizedWeather["source"];
  /** Weather for a location at a local date (YYYY-MM-DD) and time (HH:MM). */
  getWeather(location: string, date: string, time: string): Promise<NormalizedWeather>;
}
