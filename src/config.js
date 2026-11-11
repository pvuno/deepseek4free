'use strict';

const path = require('path');

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

const ROOT = path.resolve(__dirname, '..');

const config = {
  root: ROOT,
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 9270),

  tokensFile: path.resolve(ROOT, process.env.TOKENS_FILE || 'tokens.txt'),
  sessionsFile: path.resolve(ROOT, process.env.SESSIONS_FILE || 'data/sessions.json'),

  proxyApiKey: String(process.env.PROXY_API_KEY || '').trim(),

  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com',

  profile: String(process.env.DEEPSEEK_PROFILE || 'android').toLowerCase(),
  clientVersion: process.env.DEEPSEEK_CLIENT_VERSION || '2.0.4',
  clientPlatform: process.env.DEEPSEEK_CLIENT_PLATFORM || 'android',
  clientLocale: process.env.DEEPSEEK_CLIENT_LOCALE || 'zh_CN',
  androidApiLevel: process.env.DEEPSEEK_ANDROID_API_LEVEL || '35',
  webAppVersion: process.env.DEEPSEEK_WEB_APP_VERSION || '20241129.1',
  webClientVersion: process.env.DEEPSEEK_WEB_CLIENT_VERSION || '1.0.0-always',
  userAgent:
    process.env.DEEPSEEK_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',

  cookiesFile: path.resolve(ROOT, process.env.COOKIES_FILE || 'data/cookies.json'),
  cfClearance: String(process.env.CF_CLEARANCE || '').trim(),

  searchEnabled: bool(process.env.SEARCH_ENABLED, false),

  loginEmail: process.env.DEEPSEEK_EMAIL || '',
  loginPassword: process.env.DEEPSEEK_PASSWORD || '',

  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 120_000),
  idleTimeoutMs: int(process.env.IDLE_TIMEOUT_MS, 60_000),
  maxRetries: int(process.env.MAX_RETRIES, 3),
  tokenCooldownMs: int(process.env.TOKEN_COOLDOWN_MS, 10 * 60_000),
  sessionTtlMs: int(process.env.SESSION_TTL_MS, 6 * 60 * 60_000),
  autoContinue: bool(process.env.AUTO_CONTINUE, true),
  maxContinueRounds: int(process.env.MAX_CONTINUE_ROUNDS, 4),

  minRequestIntervalMs: int(process.env.MIN_REQUEST_INTERVAL_MS, 1500),
  requestJitterMs: int(process.env.REQUEST_JITTER_MS, 500),
  rateLimitCooldownMs: int(process.env.RATE_LIMIT_COOLDOWN_MS, 60_000),

  thinking: String(process.env.THINKING || 'off').toLowerCase(),

  powWorkers: int(process.env.POW_WORKERS, 1),

  logLevel: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
  version: require('../package.json').version,
};

if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.proxyApiKey) {
  throw new Error(
    'Refusing to listen on a non-local HOST without PROXY_API_KEY. ' +
      'Set PROXY_API_KEY or keep HOST=127.0.0.1.'
  );
}

module.exports = config;
