import type { WeatherProvider } from "./provider.ts";
import { MockWeatherProvider } from "./mock.ts";
import { OpenWeatherProvider } from "./openweather.ts";

/** Real OpenWeather by default; WEATHER_PROVIDER=mock selects labelled test data explicitly. */
export function getWeatherProvider(): WeatherProvider {
  return process.env.WEATHER_PROVIDER === "mock" ? new MockWeatherProvider() : new OpenWeatherProvider();
}
