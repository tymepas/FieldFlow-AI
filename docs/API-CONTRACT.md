# API Contract

Server: [`src/server.ts`](../src/server.ts) · Agent: [`src/agent/run.ts`](../src/agent/run.ts)

## `POST /run`

Request:

```json
{ "request": "Review tomorrow's field operations and handle anything that could be affected by changing weather." }
```

A missing or empty `request` returns `400 { "error": "..." }`.

Response (`200`, or `500` when `status` is `"failed"`):

```json
{
  "request": "Review tomorrow's field operations ...",
  "status": "completed",
  "summary": { "total": 6, "proceed": 3, "flag": 2, "reschedule": 1 },
  "steps": [
    { "id": "step-2", "type": "tool", "tool": "notion", "action": "read_activities", "status": "completed",
      "result": "6 activities loaded for 2026-09-26 (6 in database)" },
    { "id": "step-4", "type": "tool", "tool": "openweather", "action": "forecast", "status": "completed",
      "activity_id": "FA-101", "result": "Gurgaon 14:00: broken clouds, rain 0.0 mm/h, wind 5.8 m/s, gusts 5.6 m/s, 28.6 °C" },
    { "id": "step-11", "type": "decision", "tool": "decision_engine", "status": "completed", "activity_id": "FA-101",
      "decision": "RESCHEDULE", "reason": "Outdoor installation: heavy rain 11.2 mm/h (≥ 7.6) exceeds the reschedule threshold." },
    { "id": "step-18", "type": "tool", "tool": "notion", "action": "update_activity", "status": "completed",
      "activity_id": "FA-101", "result": "status planned → rescheduled; reasoning appended to notes" },
    { "id": "step-22", "type": "tool", "tool": "slack", "action": "send_message", "status": "completed",
      "activity_id": "FA-101", "result": "RESCHEDULE alert posted to #field-ops (ts 1790343052.135579)" }
  ],
  "activities": [
    { "activity_id": "FA-101", "activity_name": "Rooftop solar panel installation", "decision": "RESCHEDULE",
      "reason": "...", "weather_source": "openweather", "notion_updated": true, "slack_notified": true }
  ],
  "agent_summary": "Review complete for tomorrow ...",
  "weather_provider": "openweather",
  "model": "claude-opus-5"
}
```

## Fields

The original contract fields (`request`, `status`, `summary{total,proceed,flag,reschedule}`, `steps[]{id,type,tool,action,status,result,decision,reason}`) are unchanged. Additions:

| Field | Meaning |
|---|---|
| `status` values | `completed`; `completed_with_errors` (a tool call failed but the run finished); `failed` (the agent loop itself failed) |
| `steps[].type` | `tool`, `decision`, plus `agent` (the model's own text between tool calls, in `result`) |
| `steps[].tool` | `notion`, `openweather`, `mock_weather` (simulated weather, actions `forecast_simulated` / `area_forecast_simulated`), `slack`, `decision_engine`, `gmail` (only after an explicit email request) |
| `steps[].action` | `read_activities`, `forecast`, `forecast_simulated`, `area_forecast` (ad-hoc place), `update_activity`, `create_review_page` (ad-hoc Notion review page), `send_message`, `send_summary`, `send_email`; on `agent` steps, `set_scope` (the declared scope: `schedule_review`, `specific_activities`, `adhoc` or `not_tracked`) |
| `steps[].activity_id` | Activity a step belongs to |
| `steps[].error` | Error message on a `failed` step (API keys are redacted) |
| `activities[]` | Per-activity decision, reason, weather source and which actions ran |
| `agent_summary` | The agent's final message to the coordinator |
| `weather_provider` | `openweather` or `mock` |
| `model` | Claude model used |
| `run_id` | Id of this completed run, used by `POST /email-result` |
| `scope` | `{ mode, description }` the agent declared, or `null`. For a valid but incomplete request (`not_tracked`), it also carries `missing_information` (e.g. `"destination"`, `"current location"`) and `clarification` (the message asking for it). The UI shows a location-sharing button when `missing_information` is `"current location"`. |
| `adhoc` | For ad-hoc requests (the user's own event/place, not a tracked activity): place, date, provider area, coordinates and `location_resolution` (FieldFlow place directory, or "estimated by the agent"), worst-case weather, assessment level (`low` / `caution` / `significant`, same thresholds), and whether a Notion review page / Slack update was made. `null` otherwise |

Steps are recorded by the tool handlers in code, not reported by the model, so the trace reflects what
actually executed.

## Example

```bash
curl -s -X POST http://localhost:3000/run -H "Content-Type: application/json" \
  -d '{"request":"Review tomorrow'"'"'s field operations and handle anything that could be affected by changing weather."}'
```

## `POST /email-result`

Emails a completed run's result to the connected Gmail account (SwytchCode `gmail.user.profile.get` for the address, `gmail.user.send.create1` to send). The agent is not re-run; the email is built from the stored result.

Request: `{ "run_id": "<run_id from /run>" }`

| Response | Meaning |
|---|---|
| `200 { status: "sent", step }` | Sent; `step` is the `gmail` trace step |
| `409 { status: "already_sent" }` | Already emailed; nothing sent (duplicate protection) |
| `409 { status: "sending" }` | A send for this run is in progress |
| `502 { status: "failed", error, detail, step }` | Gmail failed; the same request may be retried |
| `404` / `400` | Unknown or expired run, failed run, or bad body |

Results are held in server memory (last 50 runs).

## `POST /current-weather`

Current weather for coordinates the **browser** shared after the user granted its location-permission prompt (`navigator.geolocation.getCurrentPosition`). The agent is not run and the coordinates are not stored. Weather comes from SwytchCode `openweather.2.5.weather.list` (metric units).

Request:

```json
{ "latitude": 28.7063083, "longitude": 77.1087892, "accuracy_m": 42 }
```

| Field | Rules |
|---|---|
| `latitude` | Required, number, −90..90 |
| `longitude` | Required, number, −180..180 |
| `accuracy_m` | Optional: the browser's accuracy radius in metres. A missing, negative or non-numeric value becomes `null`. The field name is `accuracy_m`; a field named `accuracy` is ignored. |

**200** (`status: "completed"`). The field names are exact; the values are illustrative.

```json
{
  "status": "completed",
  "location": { "latitude": 28.7063083, "longitude": 77.1087892, "accuracy_m": 42, "source": "browser geolocation (user permission)" },
  "weather": {
    "source": "openweather", "latitude": 28.7063083, "longitude": 77.1087892,
    "provider_area": "Pitampura, IN", "observed_at": "2026-09-26T14:08:18+05:30",
    "condition": "broken clouds", "temperature_c": 23.4, "feels_like_c": 23.5, "humidity_pct": 64,
    "precipitation_mm_last_hour": 0, "wind_speed_m_per_s": 5.9, "wind_gust_m_per_s": 9.3
  },
  "assessment": { "level": "low", "triggered": [], "summary": "No significant weather risk (…)." },
  "steps": [
    { "id": "step-1", "type": "tool", "action": "browser_location", "status": "completed", "result": "Location shared by the browser after user permission: …" },
    { "id": "step-2", "type": "tool", "tool": "openweather", "action": "current_weather", "status": "completed", "result": "Current weather [Pitampura, IN]: …" },
    { "id": "step-3", "type": "decision", "tool": "decision_engine", "status": "completed", "reason": "Current-conditions assessment (low): …" }
  ]
}
```

- `provider_area` is the area name OpenWeather reports for the coordinates.
- `precipitation_mm_last_hour` is rain plus snow over the last hour, or 0 when none is reported.
- `feels_like_c`, `humidity_pct` and `wind_gust_m_per_s` may be `null`.
- `assessment.level` is `low`, `caution` or `significant`, from the same fixed thresholds as everything else.
- With `WEATHER_PROVIDER=mock`, `weather.source` is `"mock"` and the weather step is `tool: "mock_weather"`, `action: "current_weather_simulated"`.

**400** (`status: "bad_request"`), returned before any weather call:

| Case | `error` |
|---|---|
| `latitude` or `longitude` missing or `null` | `latitude and longitude are required (from the browser's location permission).` |
| Not numeric, or out of range | `latitude/longitude are out of range.` |

**502** (`status: "failed"`): the weather lookup failed. The response has `location` (as above), `weather: null`, `assessment: null`, `steps` whose last entry is the `current_weather` step with `status: "failed"` and an `error`, and `error: "Current weather could not be retrieved."`

Permission denied, unavailable, timeout or an unsupported browser are handled in the browser (`frontend/location.js`) and never reach this endpoint.

`GET /health` returns `{ "ok": true, "weather_provider": "openweather" | "mock" }`.
