import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function normalizeOrigin(value) {
  const text = String(value || '').trim();

  if (!text) return '';
  if (text === '*') return '*';
  if (text === 'null') return 'null';

  try {
    return new URL(text).origin;
  } catch {
    return text.replace(/\/+$/, '');
  }
}

const DEFAULT_ORIGINS = [
  'https://yoshikurikuri520-dev.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500'
];

const envOrigins = [
  process.env.ALLOWED_ORIGINS,
  process.env.ALLOWED_ORIGIN
]
  .filter(Boolean)
  .flatMap(value => String(value).split(','));

const allowedOrigins = [
  ...new Set(
    [...DEFAULT_ORIGINS, ...envOrigins]
      .map(normalizeOrigin)
      .filter(Boolean)
  )
];

function isOriginAllowed(origin) {
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);

  if (normalized === 'null') return true;
  if (allowedOrigins.includes('*')) return true;

  return allowedOrigins.includes(normalized);
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    console.warn('🚫 CORS blocked:', {
      receivedOrigin: origin,
      normalizedOrigin: normalizeOrigin(origin),
      allowedOrigins
    });

    return callback(new Error(`CORS blocked: ${origin}`));
  },

  methods: ['GET', 'POST', 'OPTIONS'],

  allowedHeaders: [
    'Content-Type',
    'Accept',
    'Authorization',
    'X-Requested-With'
  ],

  exposedHeaders: [
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'Retry-After'
  ],

  credentials: false,
  optionsSuccessStatus: 204,
  maxAge: 86400
};

if (!OPENAI_API_KEY) {
  console.warn(
    '⚠️ OPENAI_API_KEY が未設定です。/api/chat は利用できません。'
  );
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || 'missing-key'
});

app.disable('x-powered-by');
app.set('etag', false);

app.use(cors(corsOptions));

app.use((_req, res, next) => {
  res.vary('Origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      ok: false,
      error: 'Too many requests',
      message:
        'APIへのアクセスが多すぎます。少し時間を空けてから再度お試しください。'
    });
  }
}));

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'YoshikunGPT API',
    message: 'API server is running',
    model: MODEL,
    health: '/health',
    apiHealth: '/api/health',
    chat: '/api/chat'
  });
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'YoshikunGPT API',
    model: MODEL,
    origin: req.headers.origin || null
  });
});

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'YoshikunGPT API',
    openaiConfigured: Boolean(OPENAI_API_KEY),
    model: MODEL,
    receivedOrigin: req.headers.origin || null,
    normalizedOrigin: normalizeOrigin(req.headers.origin || ''),
    corsAllowed: isOriginAllowed(req.headers.origin),
    allowedOrigins
  });
});

app.post('/api/chat', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'OPENAI_API_KEY is not configured',
        message:
          'Render の Environment に OPENAI_API_KEY を設定してください。'
      });
    }

    const {
      message,
      history = [],
      persona = {},
      memory = '',
      attachment = null
    } = req.body || {};

    const cleanMessage = String(message || '').trim();

    if (!cleanMessage) {
      return res.status(400).json({
        ok: false,
        error: 'message is required'
      });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .slice(-14)
          .filter(
            item =>
              item &&
              ['user', 'assistant'].includes(item.role)
          )
          .map(item => ({
            role: item.role,
            content: String(item.content || '').slice(0, 12000)
          }))
      : [];

    const personaName = String(
      persona?.name || 'YoshikunGPT'
    ).slice(0, 100);

    const personaPrefix = String(
      persona?.prefix || ''
    ).slice(0, 1000);

    const memoryText = String(memory || '').slice(0, 4000);

    const attachmentText = attachment?.text
      ? `

添付テキスト「${String(
          attachment.name || 'file'
        ).slice(0, 200)}」:
${String(attachment.text).slice(0, 20000)}`
      : '';

    const instructions = [
      `あなたは「${personaName}」として日本語で自然に会話するAIアシスタントです。`,
      personaPrefix
        ? `人格・話し方の設定:\n${personaPrefix}`
        : '',
      '質問には具体的かつ分かりやすく答えてください。',
      '分からないことを断定しないでください。',
      'ユーザーとの自然な会話を重視してください。',
      memoryText
        ? `ユーザーが端末に保存したメモリ:\n${memoryText}`
        : ''
    ]
      .filter(Boolean)
      .join('\n\n');

    const input = [
      ...safeHistory,
      {
        role: 'user',
        content: cleanMessage + attachmentText
      }
    ];

    const response = await openai.responses.create({
      model: MODEL,
      instructions,
      input,
      max_output_tokens: 1800
    });

    const reply = String(response.output_text || '').trim();

    if (!reply) {
      return res.status(502).json({
        ok: false,
        error: 'OpenAI returned an empty response'
      });
    }

    return res.json({
      ok: true,
      reply,
      model: MODEL
    });

  } catch (error) {
    console.error('/api/chat error:', error);

    const status = Number(error?.status) || 500;
    const safeStatus =
      status >= 400 && status < 600 ? status : 500;

    let message =
      'OpenAI APIとの通信に失敗しました。';

    if (safeStatus === 400) {
      message =
        'OpenAI APIへ送信した内容に問題があります。Renderのログを確認してください。';
    } else if (safeStatus === 401) {
      message =
        'OpenAI APIキーが無効です。Render の OPENAI_API_KEY を確認してください。';
    } else if (safeStatus === 403) {
      message =
        'OpenAI APIへのアクセスが拒否されました。APIキーやプロジェクト設定を確認してください。';
    } else if (safeStatus === 404) {
      message =
        `OpenAIモデル「${MODEL}」が利用できない可能性があります。OPENAI_MODELを確認してください。`;
    } else if (safeStatus === 429) {
      message =
        'OpenAI APIの利用上限またはレート制限に達しました。Billing / Usageを確認してください。';
    }

    return res.status(safeStatus).json({
      ok: false,
      error: message,
      status: safeStatus,
      detail:
        process.env.NODE_ENV === 'production'
          ? undefined
          : String(error?.message || '')
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not Found',
    path: req.originalUrl
  });
});

app.use((err, req, res, _next) => {
  console.error('server error:', err);

  const message = String(err?.message || '');
  const isCorsError =
    message.startsWith('CORS blocked:');

  if (isCorsError) {
    return res.status(403).json({
      ok: false,
      error: 'CORS blocked',
      message,
      receivedOrigin: req.headers.origin || null,
      normalizedOrigin: normalizeOrigin(
        req.headers.origin || ''
      ),
      allowedOrigins
    });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'Request body is too large'
    });
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid JSON'
    });
  }

  return res.status(500).json({
    ok: false,
    error: 'Server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('======================================');
  console.log('✅ YoshikunGPT API started');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🤖 Model: ${MODEL}`);
  console.log(
    `🔑 OpenAI configured: ${Boolean(OPENAI_API_KEY)}`
  );
  console.log('🌍 CORS allowed origins:');
  allowedOrigins.forEach(origin => {
    console.log(`   - ${origin}`);
  });
  console.log('======================================');
  console.log('');
});
