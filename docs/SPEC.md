# FieldFlow AI — Specification

> Hackathon: **Build with Swytchcode** — Track 5: AI Real-World Agent
> Submission: 26 Sep 2026, 15:30 IST, via Commudle
> Repository: https://github.com/tymepas/FieldFlow-AI

## 1. Product

FieldFlow AI is an **AI Real-World Operations Continuity Agent**.

It reads planned field activities, checks real-world weather against each activity's
risk profile, decides **PROCEED / FLAG / RESCHEDULE**, then updates the operational
record, notifies the internal team, and emails an affected external stakeholder when
required.

FieldFlow AI is **not** a weather app. Weather is an external signal; the product's
purpose is operational decision support and coordinated action.

- **Target user:** operations coordinator.
- **Core problem:** multiple field activities are planned across locations and times.
  Changing external conditions can make an activity risky or impractical. The agent
  reconciles planned operations against changing weather and coordinates the response.

## 2. Hackathon requirements (and how they are met)

| Requirement | How FieldFlow AI meets it |
|---|---|
| Real AI agent using an agentic framework | Single Claude agent loop via `@anthropic-ai/sdk` + Swytchcode `AnthropicProvider` |
| ≥ 3 Swytchcode APIs meaningfully chained | 4 integrations: Notion, OpenWeather, Slack, Gmail |
| Output of one tool influences the next | Notion activity → weather query location/time → decision → which writes/notifications happen |
| Public GitHub repo | https://github.com/tymepas/FieldFlow-AI |
| README | `README.md` |
| Architecture doc/diagram | `docs/ARCHITECTURE.md` |
| Setup instructions | `README.md` |
| Working demo | `POST /run` + demo script (`docs/DEMO-PLAN.md`) |

## 3. MVP scope

1. Read planned activities from **Notion**.
2. Retrieve weather for each relevant activity location/time via **OpenWeather**.
3. Apply **deterministic decision rules** (code, not LLM).
4. LLM reasons over structured context and **explains** the decision.
5. Update the Notion activity when the decision is FLAG or RESCHEDULE.
6. Notify the operations team through **Slack**.
7. If an external stakeholder is affected and the status changed:
   - read stakeholder context from **Gmail** when available;
   - send an update through **Gmail**.
8. Return a detailed step-by-step execution trace.

### Non-goals

RAG · vector DB · multi-agent swarm · mobile app · production auth · autonomous
real-calendar rescheduling · complex scheduling. Resend is optional and only after
the full MVP works.

### Stretch goal (only after MVP works end-to-end)

For RESCHEDULE decisions, inspect the forecast for a clearly better window later the
same day and include a suggested time in the decision detail, e.g.
*"Heavy rain at 14:00. Conditions improve by 17:00. Recommend moving to 17:00."*

## 4. Agent workflow

Input: one natural-language request, e.g.
*"Review tomorrow's field operations and handle anything affected by weather."*

For each relevant activity:

1. Read activity from Notion (fields in §5).
2. Call OpenWeather for the activity's location/time.
3. Evaluate weather against activity type.
4. Apply deterministic decision rules (§6).
5. If FLAG or RESCHEDULE → update Notion status and append reasoning to notes.
6. Notify Slack with activity, decision, reason.
7. If an external stakeholder is affected and status changed → check Gmail for
   stakeholder constraints → send stakeholder update via Gmail.
8. Continue with remaining activities.
9. Return overall counts, per-activity decisions, action results, full trace.

Single agent, single reasoning loop. No multi-agent architecture.

## 5. Data model (Notion activity)

| Field | Type |
|---|---|
| activity_id | string |
| activity_name | string |
| location | string |
| date | ISO date string |
| start_time | `HH:MM` |
| activity_type | `outdoor_inspection` \| `outdoor_installation` \| `indoor` |
| priority | `high` \| `medium` \| `low` |
| stakeholder | string |
| status | `planned` \| `proceed` \| `flagged` \| `rescheduled` |
| notes | string |

Seed data: `test-data/activities.json` — 5–6 activities, multiple types, priorities,
locations, at least one named external stakeholder.

## 6. Decision rules

Thresholds are **explicit code**. The LLM must not invent or change thresholds.
Numeric thresholds are set only after inspecting the real OpenWeather response schema
and confirming units (see `docs/DECISION-ENGINE.md`).

| Activity type | RESCHEDULE | FLAG | PROCEED |
|---|---|---|---|
| outdoor_inspection | heavy rain | high wind OR extreme heat | otherwise |
| outdoor_installation | heavy rain OR high wind | moderate rain | otherwise |
| indoor | — | — | always |

## 7. API contract

`POST /run` with body `{ "request": "<natural-language request>" }`.

Response (field names are fixed; see `docs/API-CONTRACT.md`):

```json
{
  "request": "string",
  "status": "completed",
  "summary": { "total": 6, "proceed": 3, "flag": 2, "reschedule": 1 },
  "steps": [
    { "id": "step-1", "type": "tool", "tool": "notion", "action": "read_activities", "status": "completed", "result": "6 activities loaded" },
    { "id": "step-2", "type": "tool", "tool": "openweather", "action": "forecast", "status": "completed", "result": "Gurgaon 14:00: heavy rain" },
    { "id": "step-3", "type": "decision", "status": "completed", "decision": "RESCHEDULE", "reason": "Outdoor inspection, heavy rain exceeds threshold" },
    { "id": "step-4", "type": "tool", "tool": "notion", "action": "update_activity", "status": "completed" },
    { "id": "step-5", "type": "tool", "tool": "slack", "action": "send_message", "status": "completed" }
  ]
}
```

A single JSON response is the baseline; SSE streaming only if it doesn't delay the MVP.

## 8. Technology

Node.js · TypeScript · Express · `@swytchcode/runtime` · `@anthropic-ai/sdk` ·
Swytchcode `AnthropicProvider` (documented integration pattern — no custom layer).

```
Frontend → POST /run → Backend → Agent reasoning loop → Swytchcode Runtime
                                                         → Notion / OpenWeather / Slack / Gmail
```

## 9. Swytchcode integration rules

- Initialise with `swy init` in the existing repo.
- For each integration: search/discover → inspect canonical tool ID → inspect real
  input/output schema → only then implement.
- Never guess canonical IDs, request fields, response shapes, or units.
- Authenticate via the current Swytchcode auth flow. Never commit credentials
  (`.env`, API keys, OAuth credentials, secret files, local credential state).

## 10. Build phases

1. Specification (this document)
2. Swytchcode init + integration discovery + schema inspection
3. Test data + deterministic decision engine (+ unit tests, unit verification)
4. Read-only agent loop: Notion read → OpenWeather → decision → console trace
5. Actions: Notion update → Slack; Gmail context → Gmail update
6. `POST /run` API
7. Repeatable local tests + curl example
8. Deterministic demo scenario

## 11. Escalation rule

On unavailable integration, auth issue, missing Notion database, incompatible schema,
or unexpected Swytchcode behaviour: **stop and report** what happened, the exact
command, the evidence, and what is needed. No workaround that changes the product
definition.

## 12. Git rules

No `git init`, no force-push, no history rewrite. After each milestone: `git status`,
inspect staged files, add specific files, commit, `git push origin main`.
