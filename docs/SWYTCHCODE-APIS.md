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

### OpenWeather — ❌ 401 through managed auth
- Validation requires `appid` even though auth is managed (`api_key`).
- Dry-run shows the CLI injects the managed key as an **`Authorization` header** and sends
  `appid` literally in the query string:
  `GET https://api.openweathermap.org/data/4.0/onecall/timeline/1h?appid=<input>&lat=…&lon=…&units=metric`
- OpenWeather authenticates via the `appid` query parameter, so the live call returns
  **401** (`authorization failed for OpenWeather (401)`).
- Units/fields cannot be verified until a live call succeeds.

## Status

| Check | Result |
|---|---|
| Notion read | ✅ |
| Slack read (auth.test, conversations.list) | ✅ |
| OpenWeather read | ❌ 401 — key not delivered as `appid` |
| Gmail | ⏸ not connected (deferred by decision) |
