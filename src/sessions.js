'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');

class SessionStore {
  constructor(file = config.sessionsFile, ttlMs = config.sessionTtlMs) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.locks = new Map();
    this.load();
    this.gcTimer = setInterval(() => this.gc(), 10 * 60_000);
    this.gcTimer.unref?.();
  }

  normalizeKey(key) {
    return String(key == null ? '' : key)
      .trim()
      .slice(0, 200);
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const rec of Object.values(raw.sessions || {})) {
        if (!rec || !rec.sessionId) continue;
        this.map.set(rec.key, rec);
      }
      log.info(`sessions: restored ${this.map.size} thread(s) from ${path.basename(this.file)}`);
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn(`sessions: cannot read ${this.file}: ${e.message}`);
    }
  }

  get(key) {
    return this.map.get(this.normalizeKey(key)) || null;
  }

  set(key, patch) {
    const k = this.normalizeKey(key);
    const now = Date.now();
    const prev = this.map.get(k) || { key: k, createdAt: now };
    const rec = { ...prev, ...patch, key: k, updatedAt: now };
    this.map.set(k, rec);
    this.save();
    return rec;
  }

  drop(key) {
    const k = this.normalizeKey(key);
    const had = this.map.delete(k);
    if (had) this.save();
    return had;
  }

  dropByToken(tokenIndex) {
    let n = 0;
    for (const [k, rec] of this.map) {
      if (tokenIndex == null || rec.tokenIndex === tokenIndex) {
        this.map.delete(k);
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  resetAll() {
    const n = this.map.size;
    this.map.clear();
    this.save();
    return n;
  }

  get size() {
    return this.map.size;
  }

  gc() {
    const cutoff = Date.now() - this.ttlMs;
    let n = 0;
    for (const [k, rec] of this.map) {
      if ((rec.updatedAt || 0) < cutoff) {
        this.map.delete(k);
        n++;
      }
    }
    if (n) {
      log.debug(`sessions: gc removed ${n}`);
      this.save();
    }
  }

  async withLock(key, fn) {
    const k = this.normalizeKey(key);
    const prev = this.locks.get(k) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(k, tail);
    tail.finally(() => {
      if (this.locks.get(k) === tail) this.locks.delete(k);
    });
    return run;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const sessions = {};
      for (const [k, v] of this.map) sessions[k] = v;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), sessions }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.warn(`sessions: save failed: ${e.message}`);
    }
  }

  flush() {
    this.save();
  }

  close() {
    clearInterval(this.gcTimer);
    this.flush();
  }
}

module.exports = { SessionStore };
