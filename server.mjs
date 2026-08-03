import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || "gpt-5-mini";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY が設定されていません。");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(",").map(v => v.trim())
    : true
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_PER_MINUTE || 30),
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, "public")));

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map(item => ({
    role: item?.role === "ai" ? "assistant" : "user",
    content: String(item?.text || "").slice(0, 4000)
  })).filter(item => item.content);
}

function collectSources(response) {
  const sources = [];
  const add = (title, url) => {
    if (!url || sources.some(s => s.url === url)) return;
    sources.push({ title: title || url, url });
  };

  for (const item of response.output || []) {
    for (const content of item.content || []) {
      for (const ann of content.annotations || []) {
        const citation = ann.url_citation || ann;
        if (citation?.url) add(citation.title, citation.url);
      }
    }
    const actionSources = item?.action?.sources || [];
    for (const source of actionSources) add(source.title, source.url);
  }
  return sources.slice(0, 10);
}

app.post("/api/search", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "query は必須です。" });
    if (query.length > 8000) return res.status(400).json({ error: "query が長すぎます。" });

    const history = normalizeHistory(req.body?.history);
    const input = [
      {
        role: "system",
        content:
          "あなたは日本語の調査アシスタントです。必要に応じてWeb検索を使い、質問へ直接答えてください。" +
          "最新情報は検索で確認し、推測と確認済み事実を区別してください。" +
          "医療・法律・金融など重要分野では断定を避け、一次情報や公的情報を優先してください。"
      },
      ...history,
      { role: "user", content: query }
    ];

    const response = await openai.responses.create({
      model,
      input,
      tools: [{ type: "web_search" }],
      tool_choice: "auto"
    });

    const answer = response.output_text?.trim();
    if (!answer) throw new Error("AIから本文を取得できませんでした。");

    res.json({
      answer,
      sources: collectSources(response)
    });
  } catch (error) {
    console.error(error);
    const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
    res.status(status).json({
      error: status === 500
        ? "検索・生成処理に失敗しました。サーバー設定を確認してください。"
        : String(error?.message || "APIエラー")
    });
  }
});

app.post("/api/search", async (req, res) => {
  // Web検索とAI回答
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`YoshikunGPT server: http://localhost:${port}`);
});