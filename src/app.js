'use strict';

const http = require('http');
const { randomUUID } = require('crypto');
const config = require('./config');
const log = require('./logger');
const { TokenStore } = require('./tokens');
const { SessionStore } = require('./sessions');
const { PowPool } = require('./pow-pool');
const { DeepSeekClient } = require('./deepseek');

const MODELS = [
  { id: 'deepseek-chat', thinking: false, description: 'Fast, non-thinking mode' },
  { id: 'deepseek-reasoner', thinking: true, description: 'Thinking / reasoning mode' },
  { id: 'deepseek-v4-flash', thinking: false, description: 'Alias of the fast model' },
  { id: 'deepseek-v4-pro', thinking: false, description: 'Alias of the fast model' },
];

function createApp(options = {}) {
  const tokens = options.tokens || new TokenStore(options.tokensFile || config.tokensFile);
  const sessions =
    options.sessions || new SessionStore(options.sessionsFile || config.sessionsFile);
  const pow = options.pow || new PowPool(options.powWorkers ?? config.powWorkers);
  const client = options.client || new DeepSeekClient({ tokens, sessions, pow });

  const server = http.createServer((req, res) => {
    handle(req, res, { tokens, sessions, pow, client }).catch((e) => {
      log.error('unhandled request error:', e && (e.stack || e.message));
      if (!res.headersSent) sendJson(res, 500, errorBody(e.message || 'Internal error'));
      else safeEnd(res);
    });
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  async function close() {
    const closed = new Promise((r) => server.once('close', r));
    server.close();
    server.closeAllConnections?.();
    await closed;
    await pow.close();
    sessions.close();
  }

  return { server, tokens, sessions, pow, client, close };
}

async function handle(req, res, deps) {
  const start = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  res.on('finish', () => {
    log.info(`${method} ${path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });

  if (method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, errorBody('Invalid PROXY_API_KEY', 'auth_error', 'invalid_api_key'));
    return;
  }

  if (path === '/' || path === '/health' || path === '/v1/health') {
    sendJson(res, 200, {
      ok: true,
      name: 'deepseek4free',
      version: config.version,
      uptime_seconds: Math.round(process.uptime()),
      tokens: deps.tokens.status(),
      sessions: deps.sessions.size,
      node: process.version,
    });
    return;
  }

  if (path === '/v1/models' && method === 'GET') {
    sendJson(res, 200, {
      object: 'list',
      data: MODELS.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'deepseek4free',
        description: m.description,
      })),
    });
    return;
  }

  if ((path === '/v1/tokens/status' || path === '/v1/tokens') && method === 'GET') {
    sendJson(res, 200, { ok: true, ...deps.tokens.status() });
    return;
  }

  if (path === '/v1/tokens/reload' && (method === 'POST' || method === 'GET')) {
    const result = deps.tokens.reload();
    const dropped = deps.sessions.resetAll();
    sendJson(res, 200, { ...result, tokens: result.tokens, sessions_cleared: dropped });
    return;
  }

  if (path === '/v1/chat/reset' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
    const session = url.searchParams.get('session');
    let cleared;
    if (session === '*') cleared = deps.sessions.resetAll();
    else cleared = deps.sessions.drop(session == null ? '' : session) ? 1 : 0;
    sendJson(res, 200, { ok: true, cleared, sessions: deps.sessions.size });
    return;
  }

  if (path === '/v1/tokens/check' && (method === 'POST' || method === 'GET')) {
    const pick = deps.tokens.pick();
    if (!pick)
      return sendJson(res, 503, errorBody('No tokens configured', 'upstream_error', 'no_tokens'));
    try {
      const token = await deps.client.resolveToken(pick);
      const sid = await deps.client.createSession(token);
      await deps.client.deleteSession(token, sid);
      deps.tokens.markGood(pick.index);
      sendJson(res, 200, { ok: true, token: pick.index + 1 });
    } catch (e) {
      if (e.auth) deps.tokens.markBad(pick.index, 'check failed');
      sendJson(
        res,
        e.auth ? 401 : 502,
        errorBody(e.message, 'upstream_error', e.auth ? 'token_invalid' : 'check_failed')
      );
    }
    return;
  }

  if ((path === '/v1/chat/completions' || path === '/chat/completions') && method === 'POST') {
    await handleChat(req, res, deps, url);
    return;
  }

  sendJson(res, 404, errorBody(`Unknown route: ${method} ${path}`, 'not_found', 'not_found'));
}

async function handleChat(req, res, deps, url) {
  let body;
  try {
    body = await readJson(req, 16 * 1024 * 1024);
  } catch (e) {
    sendJson(res, e.status || 400, errorBody(e.message, 'invalid_request_error', 'invalid_json'));
    return;
  }

  const messages = Array.isArray(body.messages)
    ? body.messages
    : typeof body.prompt === 'string' || Array.isArray(body.prompt)
      ? [{ role: 'user', content: body.prompt }]
      : null;
  if (!messages || !messages.length) {
    sendJson(
      res,
      400,
      errorBody('Field "messages" is required', 'invalid_request_error', 'missing_messages')
    );
    return;
  }

  const model = String(body.model || 'deepseek-chat');
  const sessionKey = String(
    body.session_key ||
      body.sessionKey ||
      body.conversation_id ||
      body.sessionId ||
      body.user ||
      req.headers['x-session-id'] ||
      ''
  ).slice(0, 200);
  const thinking = resolveThinking(model, body, url);
  const search = resolveSearch(body, url);
  const wantStream =
    body.stream === true || /text\/event-stream/i.test(String(req.headers.accept || ''));
  const includeReasoning = body.include_reasoning !== false && body.reasoning !== false;

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort(new Error('client disconnected'));
  });

  const call = (handlers) =>
    deps.client.complete({
      messages,
      sessionKey,
      thinking,
      search,
      signal: ac.signal,
      onText: handlers && handlers.onText,
      onThink: handlers && handlers.onThink,
    });

  if (!wantStream) {
    try {
      const result = await call();
      sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
              ...(result.reasoning && includeReasoning
                ? { reasoning_content: result.reasoning }
                : {}),
            },
            finish_reason: 'stop',
          },
        ],

        usage: normalizeUsage(result.usage),
        deepseek: { session_id: result.sessionId, message_id: result.messageId },
      });
    } catch (e) {
      log.warn(`completion failed: ${e.message}`);
      sendJson(
        res,
        errorStatus(e),
        errorBody(e.message, 'upstream_error', errorCode(e)),
        e.retryAfterMs
      );
    }
    return;
  }

  let started = false;
  const write = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const chunk = (delta, finishReason = null, extra = {}) => ({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });
  const ensureStarted = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write(chunk({ role: 'assistant', content: '' }));
  };

  try {
    const result = await call({
      onText: (d) => {
        ensureStarted();
        write(chunk({ content: d }));
      },
      onThink: (d) => {
        if (!includeReasoning) return;
        ensureStarted();
        write(chunk({ reasoning_content: d }));
      },
    });

    ensureStarted();
    write(chunk({}, 'stop'));
    const wantUsage = body.stream_options && body.stream_options.include_usage;
    if (wantUsage) {
      write({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: normalizeUsage(result.usage),
      });
    }
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    if (!started) {
      sendJson(
        res,
        errorStatus(e),
        errorBody(e.message, 'upstream_error', errorCode(e)),
        e.retryAfterMs
      );
      return;
    }
    log.warn(`stream failed mid-flight: ${e.message}`);
    write({ error: { message: e.message, type: 'upstream_error', code: errorCode(e) } });
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
    res.end();
  }
}

function resolveThinking(model, body, url) {
  const q = url.searchParams.get('thinking');
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;
  if (body && (body.thinking_enabled === true || body.thinking === true)) return true;
  if (body && (body.thinking_enabled === false || body.thinking === false)) return false;
  if (/reason|think|\br1\b/i.test(model)) return true;
  return config.thinking === 'on';
}

function resolveSearch(body, url) {
  const q = url.searchParams.get('search');
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;
  if (body && (body.search_enabled === true || body.search === true)) return true;
  if (body && (body.search_enabled === false || body.search === false)) return false;
  return config.searchEnabled;
}

function normalizeUsage(u) {
  const usage = u || {};
  return {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
  };
}

function errorStatus(e) {
  if (!e) return 502;
  if (e.cloudflare) return 503;
  if (e.status === 400) return 400;
  if (e.status === 429) return 429;
  if (e.status === 503) return 503;
  return 502;
}

function errorCode(e) {
  if (!e) return 'upstream_error';
  if (e.cloudflare) return 'cloudflare';
  if (e.auth) return 'token_invalid';
  if (e.status === 429) return 'rate_limited';
  if (e.status === 503) return 'no_tokens';
  return 'upstream_error';
}

function errorBody(message, type = 'upstream_error', code = 'upstream_error') {
  return { error: { message: String(message || 'Unknown error').slice(0, 800), type, code } };
}

function isAuthorized(req) {
  if (!config.proxyApiKey) return true;
  const raw = String(req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return raw === config.proxyApiKey;
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, retryAfterMs) {
  if (res.headersSent) {
    safeEnd(res);
    return;
  }
  const text = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 429) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil((retryAfterMs || 60_000) / 1000)));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function safeEnd(res) {
  try {
    res.end();
  } catch {}
}

module.exports = { createApp };
