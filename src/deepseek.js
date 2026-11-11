'use strict';

const fs = require('fs');
const config = require('./config');
const log = require('./logger');
const { DeepSeekStreamParser, pumpSSE } = require('./sse');
const { buildPowHeader } = require('./pow');

const PATHS = {
  login: '/api/v0/users/login',
  createSession: '/api/v0/chat_session/create',
  deleteSession: '/api/v0/chat_session/delete',
  createPow: '/api/v0/chat/create_pow_challenge',
  completion: '/api/v0/chat/completion',
  continue: '/api/v0/chat/continue',
};

const TARGETS = {
  completion: '/api/v0/chat/completion',
  continue: '/api/v0/chat/continue',
};

const AUTH_CODES = new Set([40001, 40002, 40003]);
const AUTH_RE =
  /token|unauthorized|expired|not login|login required|invalid jwt|session expired|登录|未登录|认证|凭证|会话过期|令牌/i;

class DeepSeekError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DeepSeekError';
    Object.assign(this, opts);
  }
}

function isAuthFailure({ status, code, bizCode, message }) {
  if (status === 401 || status === 403) return true;
  if (AUTH_CODES.has(Number(code)) || AUTH_CODES.has(Number(bizCode))) return true;
  return AUTH_RE.test(String(message || ''));
}

function isRetryable(e) {
  if (!e) return false;
  if (e.auth || e.cloudflare) return false;
  if (e.retryable || e.pow) return true;
  if (e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500) return true;
  return /pow|timeout|timed out|empty|fetch failed|network|ECONN|socket/i.test(e.message || '');
}

function isCloudflareChallenge(text) {
  return /Just a moment|cf-browser-verification|cf_chl_|Attention Required|Enable JavaScript and cookies to continue|Checking your browser/i.test(
    String(text || '')
  );
}

function cloudflareError() {
  return new DeepSeekError(
    'Cloudflare challenge: save a cf_clearance cookie to data/cookies.json (see README) or set CF_CLEARANCE',
    { status: 503, cloudflare: true, retryable: false }
  );
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === 'string' ? p : p && (p.text || p.content) ? p.text || p.content : ''
      )
      .join('');
  }
  return '';
}

const MAX_PROMPT_CHARS = 140_000;

function truncatePrompt(text) {
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, 20_000)}\n\n[... middle of the conversation trimmed ...]\n\n${text.slice(-(MAX_PROMPT_CHARS - 20_100))}`;
}

function buildPrompt(messages, fresh) {
  const list = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && typeof m === 'object' && m.role
  );
  const lastUser = [...list].reverse().find((m) => m.role === 'user');
  const lastText = truncatePrompt(contentToText(lastUser && lastUser.content).trim());

  if (!fresh) return lastText;

  const parts = [];
  for (const m of list) {
    const text = contentToText(m.content).trim();
    if (!text) continue;
    if (m.role === 'system') parts.push(`[SYSTEM INSTRUCTIONS]\n${text}`);
    else if (m.role === 'assistant') parts.push(`Assistant: ${text}`);
    else if (m.role === 'user') parts.push(text);
  }
  const out = parts.join('\n\n').trim();
  return truncatePrompt(out || lastText);
}

class DeepSeekClient {
  constructor({ tokens, sessions, pow }) {
    this.tokens = tokens;
    this.sessions = sessions;
    this.pow = pow;
    this._cookies = null;
    this.tokenLocks = new Map();
    this.tokenLastAt = new Map();
  }

  loadCookies() {
    const now = Date.now();
    if (this._cookies && now - this._cookies.at < 30_000) return this._cookies;

    const cookies = {};
    let userAgent = '';
    if (config.cfClearance) cookies.cf_clearance = config.cfClearance;

    let mtimeMs = 0;
    try {
      const st = fs.statSync(config.cookiesFile);
      mtimeMs = st.mtimeMs;
      if (!this._cookies || this._cookies.mtimeMs !== mtimeMs) {
        const json = JSON.parse(fs.readFileSync(config.cookiesFile, 'utf8'));
        const raw = (json && json.cookies) || json || {};
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) cookies[k] = v;
        if (json && typeof json.user_agent === 'string') userAgent = json.user_agent;
      } else {
        return this._cookies;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn(`cookies: cannot read ${config.cookiesFile}: ${e.message}`);
    }

    this._cookies = {
      at: now,
      mtimeMs,
      userAgent,
      header: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    };
    return this._cookies;
  }

  headers(token) {
    const ck = this.loadCookies();
    let h;
    if (config.profile === 'web') {
      h = {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        origin: 'https://chat.deepseek.com',
        referer: 'https://chat.deepseek.com/',
        'User-Agent': config.userAgent,
        'x-app-version': config.webAppVersion,
        'x-client-locale': config.clientLocale,
        'x-client-platform': 'web',
        'x-client-version': config.webClientVersion,
      };
    } else {
      h = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'accept-charset': 'UTF-8',
        'User-Agent': `DeepSeek/${config.clientVersion} Android/${config.androidApiLevel}`,
        'x-client-platform': config.clientPlatform,
        'x-client-version': config.clientVersion,
        'x-client-locale': config.clientLocale,
      };
    }
    if (ck.userAgent) h['User-Agent'] = ck.userAgent;
    if (ck.header) h.Cookie = ck.header;
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  abortScope(signal, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      try {
        ac.abort(new Error('upstream timeout'));
      } catch {}
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      try {
        ac.abort((signal && signal.reason) || new Error('aborted'));
      } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: ac.signal,
      abort(reason) {
        try {
          ac.abort(reason || new Error('aborted'));
        } catch {}
      },
      done() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      },
    };
  }

  async withTokenLock(index, signal, fn) {
    const prev = this.tokenLocks.get(index) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.tokenLocks.set(
      index,
      prev.catch(() => {}).then(() => gate)
    );
    await prev.catch(() => {});
    try {
      const last = this.tokenLastAt.get(index) || 0;
      const jitter = Math.floor(Math.random() * Math.max(0, config.requestJitterMs));
      const wait = last + config.minRequestIntervalMs + jitter - Date.now();
      if (wait > 0) await sleep(wait, signal);
      this.tokenLastAt.set(index, Date.now());
      return await fn();
    } finally {
      release();
    }
  }

  async request(path, body, { token, signal, timeoutMs = config.requestTimeoutMs } = {}) {
    const scope = this.abortScope(signal, timeoutMs);
    try {
      const res = await fetch(config.baseUrl + path, {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify(body),
        signal: scope.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!json && isCloudflareChallenge(text)) throw cloudflareError();
      if (!res.ok) {
        const msg =
          (json && (json.msg || (json.error && json.error.message))) ||
          text.slice(0, 200) ||
          res.statusText;
        const err = new DeepSeekError(`DeepSeek HTTP ${res.status}: ${msg}`, {
          status: res.status,
          code: json && json.code,
          bizCode: json && json.data && json.data.biz_code,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          body: text.slice(0, 500),
        });
        err.auth = isAuthFailure(err);
        throw err;
      }
      if (!json)
        throw new DeepSeekError('DeepSeek returned a non-JSON response', {
          retryable: true,
          body: text.slice(0, 300),
        });
      const code = Number(json.code || 0);
      const bizCode = Number((json.data && json.data.biz_code) || 0);
      if (code !== 0 || bizCode !== 0) {
        const msg = (json.data && json.data.biz_msg) || json.msg || `code ${code}/${bizCode}`;
        const err = new DeepSeekError(`DeepSeek: ${msg}`, {
          status: res.status,
          code,
          bizCode,
          body: text.slice(0, 300),
        });
        err.auth = isAuthFailure(err);
        throw err;
      }
      return (json.data && json.data.biz_data) || json.data || json;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new DeepSeekError('DeepSeek request aborted or timed out', { retryable: true });
      }
      throw e;
    } finally {
      scope.done();
    }
  }

  async login(entry) {
    const body = {
      password: entry.password,
      device_id: 'deepseek4free',
      os: 'android',
    };
    if (entry.email) body.email = entry.email;
    const data = await this.request(PATHS.login, body, { timeoutMs: 30_000 });
    const token = data && data.user && data.user.token;
    if (!token) throw new DeepSeekError('login: no token in response', { auth: true });
    return token;
  }

  async resolveToken(pick) {
    if (!pick)
      throw new DeepSeekError('No DeepSeek tokens configured', { status: 503, retryable: false });
    const e = pick.entry;
    if (e.kind === 'token' && e.token) return e.token;
    if (e.kind === 'credentials' && e.email && e.password) {
      const token = await this.login(e);
      this.tokens.resolve(pick.index, token);
      log.info(`tokens: #${pick.index + 1} logged in`);
      return token;
    }
    throw new DeepSeekError('Invalid token entry', { retryable: false });
  }

  async createSession(token, signal) {
    const data = await this.request(
      PATHS.createSession,
      { agent: 'chat' },
      { token, signal, timeoutMs: 30_000 }
    );
    const id = (data && data.id) || (data && data.chat_session && data.chat_session.id);
    if (!id) throw new DeepSeekError('create session: no id in response', { retryable: true });
    return String(id);
  }

  async deleteSession(token, sessionId) {
    try {
      await this.request(
        PATHS.deleteSession,
        { chat_session_id: sessionId },
        { token, timeoutMs: 15_000 }
      );
    } catch (e) {
      log.debug(`session delete failed: ${e.message}`);
    }
  }

  async getPow(token, targetPath, signal) {
    const data = await this.request(
      PATHS.createPow,
      { target_path: targetPath },
      { token, signal, timeoutMs: 30_000 }
    );
    const ch = data && data.challenge;
    if (!ch || !ch.challenge)
      throw new DeepSeekError('pow: empty challenge', { pow: true, retryable: true });
    const answer = await this.pow.solve(ch);
    return buildPowHeader(ch, answer);
  }

  async postStream(path, body, token, powHeader, signal) {
    const scope = this.abortScope(signal, config.requestTimeoutMs);
    try {
      const res = await fetch(config.baseUrl + path, {
        method: 'POST',
        headers: { ...this.headers(token), 'x-ds-pow-response': powHeader },
        body: JSON.stringify(body),
        signal: scope.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isCloudflareChallenge(text)) {
          scope.done();
          throw cloudflareError();
        }
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        const msg =
          (json && (json.msg || (json.error && json.error.message))) ||
          text.slice(0, 200) ||
          res.statusText;
        const err = new DeepSeekError(`DeepSeek HTTP ${res.status}: ${msg}`, {
          status: res.status,
          code: json && json.code,
          bizCode: json && json.data && json.data.biz_code,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          body: text.slice(0, 500),
        });
        err.auth = isAuthFailure(err);
        scope.done();
        throw err;
      }
      const ct = String(res.headers.get('content-type') || '');
      if (/text\/html/i.test(ct)) {
        const text = await res.text().catch(() => '');
        scope.done();
        if (isCloudflareChallenge(text)) throw cloudflareError();
        throw new DeepSeekError('DeepSeek returned HTML instead of a stream', { retryable: true });
      }
      if (/application\/json/i.test(ct)) {
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        const msg = (json && (json.msg || (json.data && json.data.biz_msg))) || text.slice(0, 200);
        const code = json && json.code;
        const bizCode = json && json.data && json.data.biz_code;
        const err = new DeepSeekError(`DeepSeek: ${msg || 'JSON error'}`, {
          status: res.status,
          code,
          bizCode,
          retryable: true,
          body: text.slice(0, 300),
        });
        err.auth = isAuthFailure(err);
        scope.done();
        throw err;
      }
      return { res, abort: scope.abort, done: () => scope.done() };
    } catch (e) {
      scope.done();
      if (e && e.name === 'AbortError')
        throw new DeepSeekError('DeepSeek stream aborted or timed out', { retryable: true });
      throw e;
    }
  }

  async readStream(stream, parser, signal) {
    try {
      await pumpSSE(stream.res.body, {
        onData: (obj) => parser.push(obj),
        signal,
        idleMs: config.idleTimeoutMs,
        controller: { abort: stream.abort },
      });
    } catch (e) {
      if (e && (e.code || e.bizCode)) {
        const err = new DeepSeekError(`DeepSeek: ${e.message}`, {
          code: e.code,
          bizCode: e.bizCode,
          retryable: true,
        });
        err.auth = isAuthFailure(err);
        throw err;
      }
      if (e && (e.name === 'AbortError' || /abort|timeout/i.test(e.message || ''))) {
        throw new DeepSeekError('DeepSeek stream aborted or timed out', { retryable: true });
      }
      throw e;
    }
  }

  async complete({
    messages,
    sessionKey = '',
    thinking = false,
    search = false,
    signal,
    onText,
    onThink,
    onMeta,
  } = {}) {
    const key = this.sessions.normalizeKey(sessionKey);

    if (!key)
      return this._completeLocked({
        key,
        messages,
        thinking,
        search,
        signal,
        onText,
        onThink,
        onMeta,
      });
    return this.sessions.withLock(key, () =>
      this._completeLocked({ key, messages, thinking, search, signal, onText, onThink, onMeta })
    );
  }

  async _completeLocked({ key, messages, thinking, search, signal, onText, onThink, onMeta }) {
    const total = this.tokens.size;
    if (!total)
      throw new DeepSeekError('No DeepSeek tokens configured (tokens.txt is empty)', {
        status: 503,
      });

    const maxAttempts = Math.max(total, 1) + Math.max(0, config.maxRetries);
    let lastErr = null;
    let authFails = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal && signal.aborted)
        throw new DeepSeekError('Client disconnected', { retryable: false });
      const health = this.tokens.status();
      if (health.healthy === 0) {
        const waitMs = health.cooldowns.length
          ? Math.min(...health.cooldowns.map((c) => c.seconds_left * 1000))
          : config.rateLimitCooldownMs;
        throw new DeepSeekError('All DeepSeek tokens are cooling down', {
          status: 429,
          retryAfterMs: waitMs,
        });
      }
      const pick = this.tokens.pick();
      if (!pick) throw new DeepSeekError('All DeepSeek tokens are cooling down', { status: 429 });

      let token;
      try {
        token = await this.resolveToken(pick);
      } catch (e) {
        lastErr = e;
        if (e.auth) {
          this.tokens.markBad(pick.index, 'login failed');
          if (++authFails >= total) break;
          continue;
        }
        throw e;
      }

      let ephemeral = !key;
      let createdNow = false;
      let sessionId = null;

      try {
        return await this.withTokenLock(pick.index, signal, async () => {
          const rec = this.sessions.get(key);
          const sameToken = rec && rec.tokenIndex === pick.index;
          sessionId = sameToken && rec.sessionId ? rec.sessionId : null;
          const parentId = sessionId ? (rec.parentId ?? null) : null;
          const needsSeed = !sessionId || rec.seeded === false;

          if (!sessionId) {
            sessionId = await this.createSession(token, signal);
            createdNow = true;
            if (key) {
              this.sessions.set(key, {
                tokenIndex: pick.index,
                sessionId,
                parentId: null,
                seeded: false,
              });
            }
          }

          const prompt = buildPrompt(messages, needsSeed);
          if (!prompt) throw new DeepSeekError('Empty prompt', { status: 400, retryable: false });

          const payload = {
            chat_session_id: sessionId,
            parent_message_id: parentId,
            prompt,
            ref_file_ids: [],
            thinking_enabled: !!thinking,
            search_enabled: !!search,
          };

          const powHeader = await this.getPow(token, TARGETS.completion, signal);
          const stream = await this.postStream(PATHS.completion, payload, token, powHeader, signal);

          const parser = new DeepSeekStreamParser({
            onText: (d) => onText && onText(d),
            onThink: (d) => onThink && onThink(d),
          });
          parser.usage.prompt_tokens = estimateTokens(prompt);

          try {
            await this.readStream(stream, parser, signal);
          } finally {
            stream.done();
          }

          if (!parser.text.trim() && !parser.reasoning.trim()) {
            throw new DeepSeekError('DeepSeek returned an empty answer', { retryable: true });
          }

          let rounds = 0;
          let continuePow = powHeader;
          while (
            config.autoContinue &&
            parser.shouldContinue &&
            rounds < config.maxContinueRounds
          ) {
            rounds++;
            const msgId = parser.messageId;
            if (!msgId) break;
            let header = continuePow;
            try {
              header = await this.getPow(token, TARGETS.continue, signal);
            } catch (e) {
              log.debug(`continue pow fallback: ${e.message}`);
            }
            const cont = await this.postStream(
              PATHS.continue,
              { chat_session_id: sessionId, message_id: msgId, fallback_to_resume: true },
              token,
              header,
              signal
            );
            try {
              await this.readStream(cont, parser, signal);
            } finally {
              cont.done();
            }
            continuePow = header;
          }

          parser.usage.completion_tokens =
            parser.usage.completion_tokens || estimateTokens(parser.text + parser.reasoning);
          parser.usage.total_tokens = parser.usage.prompt_tokens + parser.usage.completion_tokens;

          const messageId = parser.messageId || parentId || null;
          if (key) {
            this.sessions.set(key, {
              tokenIndex: pick.index,
              sessionId,
              parentId: messageId,
              seeded: true,
              messageId,
            });
          }
          this.tokens.markGood(pick.index);

          if (ephemeral) {
            this.deleteSession(token, sessionId).catch(() => {});
          }

          if (onMeta) {
            try {
              onMeta({
                session_id: sessionId,
                message_id: messageId,
                thinking: !!thinking,
                text: parser.text,
                reasoning: parser.reasoning,
              });
            } catch {}
          }

          return {
            text: parser.text,
            reasoning: parser.reasoning,
            usage: parser.usage,
            messageId,
            sessionId,
            tokenIndex: pick.index,
          };
        });
      } catch (e) {
        lastErr = e;

        if (createdNow && sessionId && (ephemeral || e.auth || isRetryable(e))) {
          this.deleteSession(token, sessionId).catch(() => {});
        }
        if (e.auth) {
          this.tokens.markBad(
            pick.index,
            (/HTTP|code/i.test(e.message) ? e.message : 'unauthorized').slice(0, 100)
          );
          this.sessions.dropByToken(pick.index);
          if (++authFails >= total) break;
          continue;
        }
        const rateLimited =
          e.status === 429 || /rate.?limit|too many|频繁|限流/i.test(e.message || '');
        if (rateLimited) {
          const cooldown = Math.max(5_000, e.retryAfterMs || config.rateLimitCooldownMs);
          this.tokens.markBad(pick.index, 'rate limited', cooldown);
          if (total <= 1) {
            e.status = 429;
            throw e;
          }
          continue;
        }
        if (isRetryable(e) && attempt < maxAttempts - 1) {
          const backoff = Math.min(2500, 300 * 2 ** Math.min(attempt, 3));
          log.warn(`completion retry ${attempt + 1}/${maxAttempts}: ${e.message} (${backoff}ms)`);
          await sleep(backoff + Math.floor(Math.random() * 250), signal);
          continue;
        }
        throw e;
      }
    }

    throw lastErr || new DeepSeekError('DeepSeek completion failed', { status: 502 });
  }
}

function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;

  return Math.max(1, Math.ceil(s.length / 3));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  DeepSeekClient,
  DeepSeekError,
};
