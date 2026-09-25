# Swytchcode APIs

All tools below were discovered with the installed CLI (`swytchcode version 2.23.3`)
via `swy search`, `swy get`, `swy list methods` and `swy info`. Nothing here is guessed;
schemas are summarised from `swy info <canonical_id>`.

Enabled in `.swytchcode/tooling.json` (verify with `swy list tooling`).

| Integration | Provider bundle | Auth (`swy info`) |
|---|---|---|
| Notion | `Notion.notion@2.0.0` | `oauth2` (managed) |
| OpenWeather | `OpenWeather.openweather@4.0.0` | `api_key` (managed) |
| Slack | `Slack.slack@1.7.0` | `oauth2` (managed) |
| Gmail | `Gmail.gmail@v1` | `oauth2` (managed) |

Managed auth means credentials are connected once with `swy auth connect <provider>`
and injected by the CLI/runtime at exec time. Application code never reads or sets
these credentials.

## Notion

### `notion.query.create` — read activities
- `POST /v1/data_sources/{data_source_id}/query`
- Inputs: `data_source_id` (path, **required**), `filter_properties` (query, optional),
  `Notion-Version` (header, default `2025-09-03`), `body` (optional): `filter`, `sorts[]`
  (`property`, `direction`), `page_size`, `start_cursor`, `archived`, `in_trash`.
- Output schema: `{ value: any }` — the page/property shape is **not** described by the
  bundle and must be confirmed from a real response before parsing.

### `notion.page.update` — update activity status/notes
- `PATCH /v1/pages/{page_id}`
- Inputs: `page_id` (path, **required**), `body.properties` (`map[STRING]ANY`), plus
  `archived`, `in_trash`, `icon`, `cover`.
- Output schema: `{ value: any }`.

## OpenWeather

### `openweather_one_call_4_0.1h.list` — hourly forecast
- `GET /timeline/1h` — "Up to 20 records per page; historical data plus 48-hour forecast."
- Inputs: `lat` (float, −90..90, **required**), `lon` (float, −180..180, **required**),
  `start` (int64, optional), `units` (`standard` | `metric` | `imperial`,
  default `standard`), `lang` (optional), `appid` (**required**, supplied by managed auth).
- Output: `lat`, `lon`, `timezone`, `timezone_offset`, `next`, `prev`, and `data[]` with
  `dt`, `temp`, `feels_like`, `humidity`, `pop`, `rain.1h`, `snow.1h`, `wind_speed`,
  `wind_gust`, `wind_deg`, `clouds`, `visibility`, `uvi`, `weather[] {id, main, description}`, `alerts[]`.
- **Location input is coordinates only.** No geocoding method exists in this bundle.
- **Units:** the bundle declares the `units` enum but does not state per-field units.
  Units will be confirmed from a real response before thresholds are finalised.

## Slack

### `slack.chat.postmessage.create` — ops notification
- `POST /chat.postMessage`
- Body (**required**): `channel` (**required**), `text`, `blocks`, `mrkdwn`, `thread_ts`, …
- Output: `channel`, `message { … }`, …

## Gmail

### `gmail.user.messages.get` — search stakeholder context
- `GET /gmail/v1/users/{userId}/messages` (list). Inputs: `userId` (default `me`), `q`,
  `maxResults`, `labelIds`, `pageToken`, `includeSpamTrash`.

### `gmail.user.messages.get1` — read one message
- `GET /gmail/v1/users/{userId}/messages/{id}`. Inputs: `userId`, `id`, `format`.

### `gmail.user.send.create1` — send stakeholder update
- `POST /gmail/v1/users/{userId}/messages/send`. Body: `raw` (RFC 2822, base64url).

Note: `gmail.user.send.create` is **drafts/send**, not message send, and is not used.

## Verified behaviour (live calls, 2026-09-25, CLI 2.23.3)

### Response envelope
`swy exec <id> --json` returns `{ "data": <provider JSON>, "request": {method,url}, "status_code": <int> }`.
Errors go to stderr as `{ "error", "category", ... }` with a non-zero exit code.

### Notion — ✅ working (oauth2 connected)
- `notion.search.create` with `--body {"query":"FieldFlow AI Operations"}` → 200. Found page
  **FieldFlow AI Operations**, id `3e623caa-e128-81bf-aed0-ca92e92c83ec`, parent = workspace.
- `notion.children.get` (`GET /v1/blocks/{block_id}/children`) → 200, 17 blocks
  (headings/paragraphs/bullets). **No database exists on the page yet.**
- The bundle has **no `POST /v1/databases`** method. `notion.data_source.create`
  (`POST /v1/data_sources`) adds a data source to an *existing* database, so a new
  database cannot be created under a page through this bundle.

### Slack — ✅ working (oauth2 connected, bot token)
- `slack.auth.test.list` → `ok:true`, team `FieldFlow-AI`, user `swytchcode`, bot `B0C4DR86746`.
  - Quirk: validation requires a `token` input even though `Inputs: []`; any value is sent as a
    harmless `Token` header. The real credential is injected as `Authorization`.
- `slack.conversations.list.list`: do **not** pass `token` (it becomes a query param and
  overrides auth → `invalid_auth`). With `types=public_channel` → `ok:true`:
  `#all-fieldflow-ai` (C0C49GY0UKD), `#new-channel`, `#social`; bot is a member of none.
  `types=private_channel` → `missing_scope groups:read` (not needed).
- `slack.chat.postmessage.create`: no `token` input; auth injected as `Authorization`.

### OpenWeather — ❌ blocked (investigation, 2026-09-25)
Two bundles are installed: `OpenWeather.openweather@4.0.0` (One Call 4.0 only) and
`OpenWeather.openweather@2.0.0` (adds the free-plan 2.5 API). `tooling.json` now pins 2.0.0.

| Method | Endpoint | Plan (per `swy info` / OpenWeather) |
|---|---|---|
| `openweather_one_call_4_0.1h.list` | `GET /data/4.0/onecall/timeline/1h` | One Call by Call subscription |
| `openweather.2.5.forecast.list` | `GET /data/2.5/forecast` (5 day / 3 h) | "Available on the free plan" |

`openweather.2.5.forecast.list` inputs: `lat`, `lon` (required), `cnt` (1–40), `units`
(`standard`|`metric`|`imperial`), `lang`, `appid` (required). Output: `city{coord,timezone,…}`,
`list[]{dt, dt_txt, main{temp,feels_like,humidity,…}, weather[]{id,main,description}, wind{speed,gust,deg},
rain{3h}, snow{3h}, pop, visibility, clouds{all}}`.

**Findings**
1. Both methods fail CLI validation without an `appid` input, although auth is managed (`api_key`).
2. Dry-run shows the managed key is injected as an `Authorization` header; `appid` is sent verbatim
   in the query string (`…?appid=<input>&lat=…`).
3. The CLI replaces the provider body with its own message
   (`authorization failed for OpenWeather (401) - the connection may be revoked`); `--raw` and
   `--verbose` do not reveal it. `swy audit network` records only status/bytes.
4. Provider bodies, fetched directly with **no credential** for comparison:
   - 4.0 timeline (fake or missing appid): `{"cod":401,"message":"Please note that using One Call 4.0
     requires a separate subscription to the One Call by Call plan…"}` — OpenWeather returns this same
     text for a missing key, so it cannot distinguish "no key" from "no subscription".
   - 2.5 (fake appid): `{"cod":401,"message":"Invalid API key…"}`.
5. The free 2.5 method through SwytchCode also returns 401.

6. The raw key was confirmed working directly against `/data/2.5/weather` and `/data/2.5/forecast` (200),
   while the same SwytchCode call still returns 401. Key and plan are therefore fine.
7. No config controls where the credential goes: `tooling.json` has no auth fields
   (`integrations.OpenWeather.openweather = {"version":"2.0.0"}`, tool entries hold only
   `desc/inputs/output/integration/method_hash/summary/type`); `swy info` shows only
   `Auth: {provider_slug, type: "api_key"}`; there is no `swy auth show`; every method in both
   OpenWeather bundles declares `SECURITY: []`; the only non-empty `SECURITY` blocks in any installed
   bundle are OAuth2 scopes. Credentials live in the CLI-managed `~/.swytchcode/credentials.db`.

**Conclusion.** The stored key never reaches OpenWeather: OpenWeather authenticates with the
`appid` query parameter only, and the CLI puts the managed key in an `Authorization` header. This is
independent of plan, because the free 2.5 endpoint fails the same way. Separately, One Call 4.0 needs a
paid "One Call by Call" subscription, so `openweather.2.5.forecast.list` is the right method once auth
works. Key validity and units cannot be verified until a call succeeds. Weather uses the
`MockWeatherProvider` in the meantime.

## Status

| Check | Result |
|---|---|
| Notion read | ✅ |
| Slack read (auth.test, conversations.list) | ✅ |
| OpenWeather read | ❌ 401 — managed key sent as header, not `appid`; mock weather in use |
| Gmail | ⏸ not connected (deferred by decision) |
