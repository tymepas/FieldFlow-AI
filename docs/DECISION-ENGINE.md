# Decision Engine

Code: [`src/decision/engine.ts`](../src/decision/engine.ts) · Tests: [`test/engine.test.ts`](../test/engine.test.ts)

The decision engine is pure, deterministic code. The LLM never sets or changes a threshold and
never decides whether rain is "heavy"; it only reads the engine's result and explains it.

## Input seam

```
WeatherProvider.getWeather(location, date, time)
        ↓
NormalizedWeather   (units are in the field names)
        ↓
decide(activity, weather) → { decision, reason, triggered[], new_status }
```

`NormalizedWeather` (`src/types.ts`):

| Field | Unit |
|---|---|
| `precipitation_mm_per_hour` | mm/h |
| `wind_speed_m_per_s` | m/s (sustained) |
| `wind_gust_m_per_s` | m/s, or `null` if not reported |
| `temperature_c` | °C |
| `condition`, `forecast_time`, `source` | text / ISO time / `"openweather"` \| `"mock"` |

The engine does not know any provider's response format. A provider is responsible for converting
its own units into these fields.

## Thresholds

| Signal | Rule | Source |
|---|---|---|
| moderate rain | 2.5 ≤ rain < 7.6 mm/h | Standard rainfall-intensity classes (light < 2.5, moderate 2.5–7.6, heavy > 7.6 mm/h), e.g. AMS Glossary of Meteorology |
| heavy rain | rain ≥ 7.6 mm/h | as above |
| high wind | sustained ≥ 10.8 m/s **or** gust ≥ 17.2 m/s | Beaufort 6 "strong breeze" starts at 10.8 m/s; Beaufort 8 "gale" starts at 17.2 m/s |
| extreme heat | temp ≥ 40 °C | IMD heatwave criterion for the plains (max temperature ≥ 40 °C) |

## Rules

| Activity type | RESCHEDULE | FLAG | PROCEED |
|---|---|---|---|
| `outdoor_inspection` | heavy rain | high wind OR extreme heat | otherwise |
| `outdoor_installation` | heavy rain OR high wind | moderate rain | otherwise |
| `indoor` | — | — | always |

RESCHEDULE takes precedence over FLAG. The resulting status is `rescheduled`, `flagged` or `proceed`.
The `reason` quotes the measured value and the threshold, e.g.
`Outdoor installation: heavy rain 11.2 mm/h (≥ 7.6) exceeds the reschedule threshold.`

## Tests

`npm test` covers every branch for each activity type, gust-only wind, precedence, values just below
thresholds, and the seeded demo scenario (`test/scenario.test.ts`: 3 PROCEED, 2 FLAG, 1 RESCHEDULE
with mock weather).
