import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY が未設定です。/api/chat は利用できません。');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing-key' });
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin(origin, callback) {
    if (allowedOrigins.includes('*') || !origin || origin === 'null' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: origin not allowed'));
  }
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'YoshikunGPT API', model: MODEL });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });
    }

    const { message, history = [], persona = {}, memory = '', attachment = null } = req.body || {};
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) return res.status(400).json({ error: 'message is required' });

    const safeHistory = Array.isArray(history)
      ? history.slice(-14).filter(x => x && ['user', 'assistant'].includes(x.role)).map(x => ({
          role: x.role,
          content: String(x.content || '').slice(0, 12000)
        }))
      : [];

    const personaName = String(persona?.name || 'YoshikunGPT').slice(0, 100);
    const personaPrefix = String(persona?.prefix || '').slice(0, 500);
    const memoryText = String(memory || '').slice(0, 4000);
    const attachmentText = attachment?.text
      ? `\n\n添付テキスト「${String(attachment.name || 'file').slice(0, 200)}」:\n${String(attachment.text).slice(0, 20000)}`
      : '';

    const instructions = [
      `あなたは「${personaName}」として日本語で自然に会話するAIアシスタントです。`,
      personaPrefix ? `人格の雰囲気: ${personaPrefix}` : '',
      '質問には具体的かつ分かりやすく答えてください。分からないことを断定しないでください。',
      memoryText ? `ユーザーが端末に保存したメモリ:\n${memoryText}` : ''
    ].filter(Boolean).join('\n');

    const input = [
      ...safeHistory,
      { role: 'user', content: cleanMessage + attachmentText }
    ];

    const response = await openai.responses.create({
      model: MODEL,
      instructions,
      input,
      max_output_tokens: 1800
    });

    const reply = response.output_text?.trim();
    if (!reply) return res.status(502).json({ error: 'OpenAI returned an empty response' });
    res.json({ reply, model: MODEL });
  } catch (error) {
    console.error('/api/chat error:', error);
    const status = Number(error?.status) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    const message = safeStatus === 429
      ? 'OpenAI APIの利用上限またはレート制限に達しました。Billing / Usageを確認してください。'
      : safeStatus === 401
        ? 'OpenAI APIキーが無効です。環境変数 OPENAI_API_KEY を確認してください。'
        : 'OpenAI APIとの通信に失敗しました。';
    res.status(safeStatus).json({ error: message });
  }
});

app.use((err, _req, res, _next) => {
  console.error('server error:', err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ YoshikunGPT API server: http://localhost:${PORT}`);
  console.log(`🤖 model: ${MODEL}`);
});
