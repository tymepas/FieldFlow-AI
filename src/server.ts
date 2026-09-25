import "dotenv/config";
import express from "express";
import { runAgent } from "./agent/run.ts";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, weather_provider: process.env.WEATHER_PROVIDER === "mock" ? "mock" : "openweather" });
});

app.post("/run", async (req, res) => {
  const request = req.body?.request;
  if (typeof request !== "string" || !request.trim()) {
    res.status(400).json({ error: 'Body must be JSON: { "request": "<natural-language request>" }' });
    return;
  }
  try {
    const result = await runAgent(request.trim());
    res.status(result.status === "failed" ? 500 : 200).json(result);
  } catch (e) {
    res.status(500).json({ request, status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`FieldFlow AI listening on http://localhost:${port} (POST /run)`);
});
