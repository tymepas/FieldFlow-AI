import { callTool } from "../swytch.ts";
import type { NormalizedWeather } from "../types.ts";
import type { WeatherProvider } from "./provider.ts";
import { resolveLocation } from "./locations.ts";

/**
 * Real weather via Swytchcode `openweather.2.5.forecast.list` (5 day / 3 hour, free plan).
 *
 * Units, verified live by requesting the same slot with units=metric/standard/imperial:
 *   main.temp  °C   (standard − metric = 273.15; imperial = °F conversion)
 *   wind.*     m/s  (imperial ÷ metric = 2.238 ≈ mph per m/s; standard = metric)
 *   rain.3h    mm accumulated over the 3-hour slot (identical across unit systems)
 *   dt         unix seconds, UTC; city.timezone = offset in seconds
 *
 * Auth workaround: the CLI injects the managed OpenWeather key as an Authorization
 * header, but OpenWeather only reads the `appid` query param (see docs/SWYTCHCODE-APIS.md).
 * The key is therefore passed as the `appid` input from the gitignored .env.
 */
export class OpenWeatherProvider implements WeatherProvider {
  readonly name = "openweather" as const;

  constructor(private readonly apiKey = process.env.OPENWEATHER_API_KEY) {
    if (!apiKey) throw new Error("OPENWEATHER_API_KEY is not set (see .env.example)");
  }

  async getWeather(location: string, date: string, time: string): Promise<NormalizedWeather> {
    const { lat, lon, utc_offset } = resolveLocation(location);
    const res = await callTool("openweather.2.5.forecast.list", {
      lat,
      lon,
      units: "metric",
      appid: this.apiKey,
    });

    const target = Date.parse(`${date}T${time}:00${utc_offset}`) / 1000;
    const slots: any[] = res.list ?? [];
    if (slots.length === 0) throw new Error(`OpenWeather returned no forecast slots for ${location}`);
    const first = slots[0].dt;
    const last = slots[slots.length - 1].dt;
    if (target < first - 3 * 3600 || target > last + 3 * 3600) {
      throw new Error(`${location} ${date} ${time} is outside the forecast window (${slots[0].dt_txt} – ${slots[slots.length - 1].dt_txt} UTC)`);
    }
    const slot = slots.reduce((best, s) => (Math.abs(s.dt - target) < Math.abs(best.dt - target) ? s : best));

    const offsetSec: number = res.city?.timezone ?? 0;
    return {
      source: "openweather",
      location,
      forecast_time: toLocalIso(slot.dt, offsetSec),
      condition: slot.weather?.[0]?.description ?? "unknown",
      precipitation_mm_per_hour: (slot.rain?.["3h"] ?? 0) / 3,
      wind_speed_m_per_s: slot.wind?.speed ?? 0,
      wind_gust_m_per_s: slot.wind?.gust ?? null,
      temperature_c: slot.main.temp,
    };
  }
}

function toLocalIso(unixSec: number, offsetSec: number): string {
  const local = new Date((unixSec + offsetSec) * 1000).toISOString().slice(0, 19);
  const sign = offsetSec >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSec);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}
