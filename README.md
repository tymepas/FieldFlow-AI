# FieldFlow AI

> AI Real-World Operations Continuity Agent built for the **Build With SwytchCode: Gurgaon Edition** hackathon.

FieldFlow AI is an AI-powered operations agent designed to help teams respond to real-world conditions that may affect planned field activities.

Instead of simply reporting weather conditions, FieldFlow AI combines operational context, external conditions, and stakeholder information to determine what action should be taken.

The agent can decide whether an activity should:

- **PROCEED**
- **FLAG**
- **RESCHEDULE**

It can then update the operational record and communicate the required action to the operations team, naming any affected external stakeholder.

---

## 🚀 Problem

Field operations often depend on external conditions such as weather.

Teams may have several activities planned across different locations, and manually checking conditions, evaluating their impact, updating schedules, and informing stakeholders can be time-consuming.

A weather alert by itself is not enough.

The real question is:

> **"What should we actually do about the planned activity?"**

FieldFlow AI is designed to answer that question and take the next operational action.

---

## 💡 Solution

FieldFlow AI acts as an autonomous operations coordination agent.

Given a natural-language request such as:

> "Review tomorrow's field operations and handle anything that could be affected by changing weather."

the agent can:

1. Read planned activities from **Notion**
2. Retrieve relevant weather information using **OpenWeather**
3. Analyze the potential impact on each activity
4. Apply activity-specific operational rules
5. Decide whether the activity should **PROCEED, FLAG, or RESCHEDULE**
6. Update the relevant activity in **Notion**
7. Notify the internal team through **Slack**
8. Gmail is an optional extension for stakeholder context and external communication; it is not part of the current MVP.
9. Return an explainable summary of the decisions and actions taken

---

## 🧠 Why FieldFlow AI?

FieldFlow AI is not designed as a generic weather application.

Weather is only an external signal.

The agent focuses on the operational question:

> **"How does this external condition affect our planned work, and what should happen next?"**

This makes the workflow decision-oriented rather than information-oriented.

### Key capabilities

- Multi-activity operational analysis
- Activity-specific decision logic
- External condition awareness
- Context-aware decision making
- Automated operational updates
- Internal team communication
- Affected external stakeholders named in team alerts
- Explainable decision trail
- Multi-step agentic workflow

---

## 🔄 Agent Workflow

```text
                    User Request
                         │
                         ▼
              ┌─────────────────────┐
              │ Understand Request  │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ Read Activities     │
              │      Notion         │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ Get Weather Data    │
              │    OpenWeather      │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ Analyze Impact      │
              │ Activity + Context  │
              └──────────┬──────────┘
                         │
                         ▼
             ┌────────────────────────┐
             │ Operational Decision   │
             │                        │
             │ PROCEED                │
             │ FLAG                   │
             │ RESCHEDULE             │
             └───────────┬────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       Update Notion          Notify Slack
              │                     │
              └──────────┬──────────┘
                         │
                         ▼
                  Slack run summary
                         │
                         ▼
                  Final Summary
```

---

## 🛠️ How it's built

- **Node.js + TypeScript**, Express server exposing `POST /run` ([docs/API-CONTRACT.md](docs/API-CONTRACT.md)).
- **Claude agent**: one tool-use loop using `@anthropic-ai/sdk`. The model is `claude-opus-5` unless you set `ANTHROPIC_MODEL`. The model chooses the tool calls and writes the explanations; tools identify activities only by `activity_id`, so locations, times, weather, decisions and Notion status values come from code.
- **Deterministic decision engine**: thresholds are explicit constants in code; the LLM explains decisions but never makes or overrides them ([docs/DECISION-ENGINE.md](docs/DECISION-ENGINE.md)).
- **Swytchcode runtime** (`@swytchcode/runtime`) executes every external call ([docs/SWYTCHCODE-APIS.md](docs/SWYTCHCODE-APIS.md)):

| Integration | Swytchcode methods |
|---|---|
| Notion | `notion.children.get`, `notion.databas.get`, `notion.data_source.get`, `notion.query.create`, `notion.page.update`, `notion.page.create` (seeding) |
| OpenWeather | `openweather.2.5.forecast.list` (key passed as the `appid` input, see the API doc) |
| Slack | `slack.conversations.list.list`, `slack.chat.postmessage.create` |

- **Weather modes**: live OpenWeather by default; `WEATHER_PROVIDER=mock` uses clearly labelled simulated weather to demonstrate FLAG/RESCHEDULE.

---

## ⚙️ Setup

Prerequisites: Node.js and npm (tested with Node 24), the Swytchcode CLI (`swy`), an Anthropic API key, an OpenWeather API key (free plan works), a Notion workspace and a Slack workspace.

```bash
npm install
swy login
swy bootstrap                   # fetch the provider bundles declared in .swytchcode/tooling.json
swy auth connect notion
swy auth connect slack
swy auth connect openweather
swy auth status                 # notion, slack, openweather should be listed
```

**Notion:** create a page, and in it a database titled **Field Activities** with these columns:
`activity_id` (title), `activity_name`, `location`, `start_time`, `stakeholder`, `notes` (text), `date` (date),
`activity_type`, `priority`, `status` (select). Share it with the Swytchcode Notion connection and put the page id in
`NOTION_ROOT_PAGE_ID`.

**Slack:** create `#field-ops` (or set `SLACK_CHANNEL`) and run `/invite @swytchcode` in it.

**Environment:** copy `.env.example` to `.env` (gitignored) and set `ANTHROPIC_API_KEY` and `OPENWEATHER_API_KEY`.
Optional: `ANTHROPIC_MODEL`, `WEATHER_PROVIDER=mock`, `SLACK_CHANNEL`, `NOTION_ROOT_PAGE_ID`, `NOTION_TABLE_TITLE`, `PORT` (default 3000).

**Seed the demo activities** from `test-data/activities.json`:

```bash
npx tsx scripts/seed-notion.ts
```

---

## ▶️ Run

```bash
npm run typecheck
npm test
npm run dev                     # http://localhost:3000
```

```bash
curl -s -X POST http://localhost:3000/run -H "Content-Type: application/json" \
  -d '{"request":"Review tomorrow'"'"'s field operations and handle anything that could be affected by changing weather."}'
```

**Simulated-weather demo:** set `WEATHER_PROVIDER=mock` in `.env` (or in the shell) and restart `npm run dev`.
The same run then shows 1 RESCHEDULE, 2 FLAG and 3 PROCEED, with every weather step labelled simulated.

Useful scripts:

| Command | Purpose |
|---|---|
| `npx tsx scripts/run-agent.ts "<request>"` | Run the agent once from the terminal |
| `npx tsx scripts/show-activities.ts` | Print current Notion status and notes |
| `npx tsx scripts/seed-notion.ts --reset` | Restore all seeded activities to `planned` |
| `npx tsx scripts/notion-check.ts` | Verify Notion read + update round trip |
| `npx tsx scripts/slack-test.ts` | Post a Slack test message |
| `npx tsx scripts/weather-check.ts` | Live forecast + decision for each seed activity (no writes) |
