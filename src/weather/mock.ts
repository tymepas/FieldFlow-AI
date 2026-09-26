import type { NormalizedWeather } from "../types.ts";
import type { AreaForecast, WeatherProvider } from "./provider.ts";
import { resolveLocation } from "./locations.ts";

type Scenario = Omit<NormalizedWeather, "source" | "location" | "forecast_time">;

/**
 * TEST DATA — not real weather. Fixed per-location scenarios used while the
 * OpenWeather integration is blocked, chosen so the seed activities exercise
 * every decision path. Every result is labelled source: "mock".
 */
const SCENARIOS: Record<string, Scenario> = {
  gurgaon: { condition: "heavy intensity rain", precipitation_mm_per_hour: 11.2, wind_speed_m_per_s: 6.1, wind_gust_m_per_s: 9.8, temperature_c: 27.4 },
  noida: { condition: "scattered clouds, strong wind", precipitation_mm_per_hour: 0, wind_speed_m_per_s: 12.4, wind_gust_m_per_s: 18.1, temperature_c: 31.0 },
  faridabad: { condition: "moderate rain", precipitation_mm_per_hour: 4.1, wind_speed_m_per_s: 5.2, wind_gust_m_per_s: 8.0, temperature_c: 28.3 },
  "new delhi": { condition: "clear sky", precipitation_mm_per_hour: 0, wind_speed_m_per_s: 2.8, wind_gust_m_per_s: null, temperature_c: 33.5 },
  jaipur: { condition: "few clouds", precipitation_mm_per_hour: 0, wind_speed_m_per_s: 4.0, wind_gust_m_per_s: 6.2, temperature_c: 34.1 },
  mumbai: { condition: "heavy intensity rain", precipitation_mm_per_hour: 9.0, wind_speed_m_per_s: 7.5, wind_gust_m_per_s: 11.0, temperature_c: 26.9 },
};

export class MockWeatherProvider implements WeatherProvider {
  readonly name = "mock" as const;

  async getWeather(location: string, date: string, time: string): Promise<NormalizedWeather> {
    const loc = resolveLocation(location);
    const scenario = SCENARIOS[location.trim().toLowerCase()];
    if (!scenario) throw new Error(`[MOCK WEATHER] no scenario for "${location}"`);
    console.warn(`[MOCK WEATHER] ${location} ${date} ${time}: using test data, not a real forecast`);
    return {
      source: "mock",
      location,
      forecast_time: `${date}T${time}:00${loc.utc_offset}`,
      ...scenario,
    };
  }

  /** TEST DATA for ad-hoc places: one fixed moderate-rain scenario, always labelled mock. */
  async getAreaForecast(place: string, latitude: number, longitude: number, date: string, time?: string): Promise<AreaForecast> {
    console.warn(`[MOCK WEATHER] ${place} ${date}: using test data, not a real forecast`);
    return {
      source: "mock",
      latitude,
      longitude,
      provider_area: "simulated area",
      date,
      time: time ?? null,
      slots: time ? 1 : 8,
      worst: {
        source: "mock",
        location: place,
        forecast_time: date,
        condition: "moderate rain",
        precipitation_mm_per_hour: 3.4,
        wind_speed_m_per_s: 6.2,
        wind_gust_m_per_s: 9.1,
        temperature_c: 29.5,
      },
      temperature_c_min: 24.0,
    };
  }
}
