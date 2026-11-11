'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');

class TokenStore {
  constructor(file = config.tokensFile) {
    this.file = file;
    this.entries = [];
    this.active = 0;
    this.cooldown = new Map();
    this.load();
  }

  load() {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      log.warn(`tokens: ${this.file} not found — proxy will answer 503 until tokens are added`);
    }
    let entries = this.parse(raw);
    let source = path.basename(this.file);
    if (!entries.length) {
      const envRaw = process.env.DEEPSEEK_TOKENS || process.env.DEEPSEEK_TOKEN || '';
      if (envRaw.trim()) {
        entries = this.parse(envRaw);
        source = 'DEEPSEEK_TOKEN(S) env';
      }
    }
    if (!entries.length && config.loginEmail && config.loginPassword) {
      entries.push({
        kind: 'credentials',
        email: config.loginEmail,
        password: config.loginPassword,
        label: maskEmail(config.loginEmail),
      });
      source = 'DEEPSEEK_EMAIL/PASSWORD env';
    }
    this.entries = entries;
    this.active = 0;
    this.cooldown.clear();
    log.info(
      `tokens: loaded ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${source}`
    );
    return entries.length;
  }

  parse(raw) {
    const entries = [];
    for (const line of String(raw || '').split(/[,\r\n]+/)) {
      const s = line.replace(/^\uFEFF/, '').trim();
      if (!s || s.startsWith('#') || s.startsWith('//')) continue;
      if (/^[^\s:@]+@[^\s:]+:.+$/.test(s)) {
        const i = s.indexOf(':');
        entries.push({
          kind: 'credentials',
          email: s.slice(0, i),
          password: s.slice(i + 1),
          label: maskEmail(s.slice(0, i)),
        });
      } else {
        const token = s.replace(/^["'`]|["'`]$/g, '').trim();
        if (token.length < 16) {
          log.warn(`tokens: skipping suspiciously short entry (${token.length} chars)`);
          continue;
        }
        entries.push({ kind: 'token', token, label: maskToken(token) });
      }
    }
    return entries;
  }

  reload() {
    const n = this.load();
    return { tokens: n, status: 'reloaded' };
  }

  get size() {
    return this.entries.length;
  }

  resolve(i, token) {
    const e = this.entries[i];
    if (!e) return;
    e.kind = 'token';
    e.token = token;
  }

  isHealthy(i) {
    const cd = this.cooldown.get(i);
    return !cd || cd.until <= Date.now();
  }

  pick() {
    const n = this.entries.length;
    if (!n) return null;
    const start = this.active % n;
    for (let d = 0; d < n; d++) {
      const i = (start + d) % n;
      if (this.isHealthy(i)) {
        this.active = i;
        return { index: i, entry: this.entries[i] };
      }
    }

    let best = 0;
    let bestUntil = Infinity;
    for (let i = 0; i < n; i++) {
      const u = this.cooldown.get(i)?.until ?? 0;
      if (u < bestUntil) {
        best = i;
        bestUntil = u;
      }
    }
    this.active = best;
    return { index: best, entry: this.entries[best] };
  }

  markBad(i, reason, cooldownMs = config.tokenCooldownMs) {
    this.cooldown.set(i, {
      until: Date.now() + cooldownMs,
      reason: String(reason || '').slice(0, 120),
    });
    log.warn(`tokens: #${i + 1} on cooldown ${Math.round(cooldownMs / 1000)}s (${reason})`);
  }

  markGood(i) {
    this.cooldown.delete(i);
  }

  status() {
    const now = Date.now();
    let healthy = 0;
    const cooldowns = [];
    for (let i = 0; i < this.entries.length; i++) {
      const cd = this.cooldown.get(i);
      if (!cd || cd.until <= now) healthy++;
      else
        cooldowns.push({
          index: i + 1,
          seconds_left: Math.ceil((cd.until - now) / 1000),
          reason: cd.reason,
        });
    }
    return {
      tokens: this.entries.length,
      active: this.entries.length ? this.active + 1 : 0,
      healthy,
      cooldowns,
      labels: this.entries.map((e) => e.label),
    };
  }
}

function maskToken(t) {
  const s = String(t || '');
  return s.length <= 12 ? '***' : `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  return at > 1 ? `${s[0]}***${s.slice(at)}` : '***';
}

module.exports = { TokenStore };
