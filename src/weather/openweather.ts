import { callTool } from "../swytch.ts";
import type { NormalizedWeather } from "../types.ts";
import type { AreaForecast, CurrentWeather, WeatherProvider } from "./provider.ts";
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

  async getAreaForecast(place: string, latitude: number, longitude: number, date: string, time?: string): Promise<AreaForecast> {
    const res = await callTool("openweather.2.5.forecast.list", { lat: latitude, lon: longitude, units: "metric", appid: this.apiKey });
    const offsetSec: number = res.city?.timezone ?? 0;
    const area = [res.city?.name, res.city?.country].filter(Boolean).join(", ") || "unnamed area";
    return summarizeForecast("openweather", place, latitude, longitude, area, res.list ?? [], offsetSec, date, time);
  }

  /** Current conditions via SwytchCode `openweather.2.5.weather.list` (metric units, verified live). */
  async getCurrentWeather(latitude: number, longitude: number): Promise<CurrentWeather> {
    const res = await callTool("openweather.2.5.weather.list", { lat: latitude, lon: longitude, units: "metric", appid: this.apiKey });
    return normalizeCurrent("openweather", latitude, longitude, res);
  }
}

/** Map an OpenWeather 2.5 current-weather payload to CurrentWeather. */
export function normalizeCurrent(source: CurrentWeather["source"], latitude: number, longitude: number, res: any): CurrentWeather {
  if (typeof res?.main?.temp !== "number") throw new Error("OpenWeather returned no current temperature for these coordinates.");
  return {
    source,
    latitude,
    longitude,
    provider_area: [res.name, res.sys?.country].filter(Boolean).join(", ") || "unnamed area",
    observed_at: typeof res.dt === "number" ? toLocalIso(res.dt, res.timezone ?? 0) : new Date().toISOString(),
    condition: res.weather?.[0]?.description ?? "unknown",
    temperature_c: res.main.temp,
    feels_like_c: typeof res.main.feels_like === "number" ? res.main.feels_like : null,
    humidity_pct: typeof res.main.humidity === "number" ? res.main.humidity : null,
    precipitation_mm_last_hour: (res.rain?.["1h"] ?? 0) + (res.snow?.["1h"] ?? 0),
    wind_speed_m_per_s: res.wind?.speed ?? 0,
    wind_gust_m_per_s: typeof res.wind?.gust === "number" ? res.wind.gust : null,
  };
}

/**
 * Reduce OpenWeather 2.5 forecast slots (3-hourly) to one local date — or the slot nearest a
 * local time — keeping worst-case values so the assessment errs on the side of caution.
 */
export function summarizeForecast(
  source: AreaForecast["source"],
  place: string,
  latitude: number,
  longitude: number,
  providerArea: string,
  slots: any[],
  offsetSec: number,
  date: string,
  time?: string,
): AreaForecast {
  const localDate = (dt: number) => new Date((dt + offsetSec) * 1000).toISOString().slice(0, 10);
  const onDate = slots.filter((s) => localDate(s.dt) === date);
  if (onDate.length === 0) {
    const range = slots.length ? `${localDate(slots[0].dt)} – ${localDate(slots[slots.length - 1].dt)}` : "none";
    throw new Error(`No forecast available for ${date} (forecast covers ${range}).`);
  }
  let chosen = onDate;
  if (time) {
    const target = Date.parse(`${date}T${time}:00Z`) / 1000 - offsetSec;
    chosen = [onDate.reduce((best, s) => (Math.abs(s.dt - target) < Math.abs(best.dt - target) ? s : best))];
  }
  const rain = chosen.map((s) => (s.rain?.["3h"] ?? 0) / 3);
  const gusts = chosen.map((s) => s.wind?.gust).filter((g): g is number => typeof g === "number");
  const temps = chosen.map((s) => s.main.temp as number);
  const conditions = [...new Set(chosen.map((s) => s.weather?.[0]?.description ?? "unknown"))];
  return {
    source,
    latitude,
    longitude,
    provider_area: providerArea,
    date,
    time: time ?? null,
    slots: chosen.length,
    worst: {
      source,
      location: place,
      forecast_time: time ? toLocalIso(chosen[0].dt, offsetSec) : date,
      condition: conditions.join(", "),
      precipitation_mm_per_hour: Math.max(...rain),
      wind_speed_m_per_s: Math.max(...chosen.map((s) => s.wind?.speed ?? 0)),
      wind_gust_m_per_s: gusts.length ? Math.max(...gusts) : null,
      temperature_c: Math.max(...temps),
    },
    temperature_c_min: Math.min(...temps),
  };
}

function toLocalIso(unixSec: number, offsetSec: number): string {
  const local = new Date((unixSec + offsetSec) * 1000).toISOString().slice(0, 19);
  const sign = offsetSec >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSec);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}
