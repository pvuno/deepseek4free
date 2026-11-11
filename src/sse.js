'use strict';

const TEXT_TYPES = new Set(['RESPONSE']);

class DeepSeekStreamParser {
  constructor(handlers = {}) {
    this.onText = handlers.onText || (() => {});
    this.onThink = handlers.onThink || (() => {});
    this.onUsage = handlers.onUsage || (() => {});
    this.onStatus = handlers.onStatus || (() => {});

    this.fragments = [];
    this.lastContentPath = null;
    this.messageId = null;
    this.responseMessageId = null;
    this.status = '';
    this.quasiStatus = '';
    this.autoContinue = false;
    this.thinkingEnabled = false;
    this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  get text() {
    return this.fragments
      .filter((f) => f && TEXT_TYPES.has(f.type))
      .map((f) => f.content || '')
      .join('');
  }

  get reasoning() {
    return this.fragments
      .filter((f) => f && f.type === 'THINK')
      .map((f) => f.content || '')
      .join('');
  }

  get shouldContinue() {
    if (this.status === 'CONTENT_FILTER' || this.status === 'FINISHED') return false;
    return this.autoContinue || this.status === 'INCOMPLETE';
  }

  push(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (typeof obj.code === 'number' && obj.code !== 0) {
      const err = new Error(obj.msg || `DeepSeek error ${obj.code}`);
      err.code = obj.code;
      throw err;
    }
    const bizCode = obj.data && obj.data.biz_code;
    if (typeof bizCode === 'number' && bizCode !== 0) {
      const err = new Error((obj.data && obj.data.biz_msg) || `DeepSeek business error ${bizCode}`);
      err.bizCode = bizCode;
      throw err;
    }

    if (obj.response_message_id != null) this.responseMessageId = num(obj.response_message_id);
    if (obj.message_id != null && this.messageId == null) this.messageId = num(obj.message_id);

    const v = obj.v;
    const response = pickResponse(v) || pickResponse(obj.message);

    if (response) this.mergeResponse(response);

    if (typeof obj.p === 'string' && obj.p) {
      this.applyPatch(obj.p, obj.o, obj.v);
      return;
    }
    if (response) return;

    if (typeof v === 'string' && this.lastContentPath)
      this.applyPatch(this.lastContentPath, obj.o, v);
  }

  mergeResponse(r) {
    if (!r || typeof r !== 'object') return;
    if (r.message_id != null) this.messageId = num(r.message_id);
    if (r.thinking_enabled != null) this.thinkingEnabled = !!r.thinking_enabled;
    if (r.auto_continue != null) this.autoContinue = !!r.auto_continue;
    if (r.status) this.setStatus(r.status);
    if (Array.isArray(r.fragments)) {
      r.fragments.forEach((frag, i) => this.upsertFragment(i, frag, true));
    }
    if (r.accumulated_token_usage != null) {
      this.usage.completion_tokens = num(r.accumulated_token_usage);
      this.usage.total_tokens = this.usage.prompt_tokens + this.usage.completion_tokens;
      this.onUsage(this.usage);
    }
  }

  applyPatch(p, op, value) {
    let segs = String(p)
      .split('/')
      .filter((s) => s !== '');
    if (segs[0] === 'response') segs = segs.slice(1);
    if (!segs.length) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!item || typeof item !== 'object') continue;
          const child = item.p ? `response/${String(item.p).replace(/^response\//, '')}` : '';
          if (child) this.applyPatch(child, item.o || 'SET', item.v);
        }
      }
      return;
    }

    const head = segs[0];
    if (head === 'fragments') {
      if (segs.length === 1) {
        if (Array.isArray(value)) value.forEach((f) => this.appendFragment(f));
        return;
      }
      if (segs.length === 2) {
        if (value && typeof value === 'object')
          this.upsertFragment(this.resolveIndex(segs[1]), value, false);
        return;
      }
      if (segs.length === 3) {
        const idx = this.resolveIndex(segs[1]);
        const field = segs[2];
        if (field === 'content') {
          this.lastContentPath = p;
          this.addContent(idx, value, op);
        } else if (field === 'type') {
          this.setFragmentType(idx, value);
        }
        return;
      }
      return;
    }

    if (head === 'status') return this.setStatus(value);
    if (head === 'quasi_status') {
      this.quasiStatus = String(value || '');
      if (this.quasiStatus === 'FINISHED' && !this.status) this.setStatus('FINISHED');
      return;
    }
    if (head === 'auto_continue') {
      if (value === true) this.autoContinue = true;
      return;
    }
    if (head === 'accumulated_token_usage') {
      this.usage.completion_tokens = num(value);
      this.usage.total_tokens = this.usage.prompt_tokens + this.usage.completion_tokens;
      this.onUsage(this.usage);
      return;
    }
    if (head === 'message_id') {
      this.messageId = num(value);
    }
  }

  resolveIndex(seg) {
    if (seg === '-1') return Math.max(0, this.fragments.length - 1);
    if (seg === '-2') return Math.max(0, this.fragments.length - 2);
    const n = Number.parseInt(seg, 10);
    return Number.isFinite(n) && n >= 0 ? n : Math.max(0, this.fragments.length - 1);
  }

  ensureSlot(i) {
    while (this.fragments.length <= i) this.fragments.push({ id: null, type: '', content: '' });
    return this.fragments[i];
  }

  appendFragment(frag) {
    if (!frag || typeof frag !== 'object') return;
    const i = this.fragments.length;
    this.fragments.push({ id: frag.id ?? null, type: frag.type || '', content: '' });
    this.mergeFragment(i, frag, true);
  }

  upsertFragment(i, frag, emitInitial) {
    if (!frag || typeof frag !== 'object') return;
    const slot = this.ensureSlot(i);
    if (frag.id != null) slot.id = frag.id;

    this.mergeFragment(i, frag, emitInitial);
  }

  mergeFragment(i, frag, emitInitial) {
    const slot = this.ensureSlot(i);
    if (frag.type && frag.type !== slot.type) {
      slot.type = frag.type;
      if (slot.content) this.emit(frag.type, slot.content);
    }
    if (frag.content != null) {
      const before = slot.content || '';
      const next = String(frag.content);
      if (next !== before) {
        slot.content = next;
        if (emitInitial) {
          if (next.startsWith(before)) this.emit(slot.type, next.slice(before.length));
          else this.emit(slot.type, next);
        } else if (next.startsWith(before)) {
          this.emit(slot.type, next.slice(before.length));
        }
      }
    }
  }

  setFragmentType(i, type) {
    const slot = this.ensureSlot(i);
    if (!type || slot.type === type) return;
    slot.type = String(type);
    if (slot.content) this.emit(slot.type, slot.content);
  }

  addContent(i, value, op) {
    if (value == null) return;
    const slot = this.ensureSlot(i);
    const before = slot.content || '';
    const piece = String(value);
    let next;
    if (op === 'SET') next = piece;
    else if (op === 'PREPEND') next = piece + before;
    else next = before + piece;

    slot.content = next;
    if (next === before) return;
    if (op === 'PREPEND') this.emit(slot.type, piece);
    else if (next.startsWith(before)) this.emit(slot.type, next.slice(before.length));
    else this.emit(slot.type, next);
  }

  emit(type, delta) {
    if (!delta) return;
    if (type === 'THINK') this.onThink(delta);
    else if (TEXT_TYPES.has(type)) this.onText(delta);
  }

  setStatus(status) {
    const s = String(status || '').trim();
    if (!s) return;
    this.status = s;
    this.onStatus(s);
  }
}

function pickResponse(v) {
  if (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    v.response &&
    typeof v.response === 'object'
  )
    return v.response;
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function pumpSSE(body, { onData, signal, idleMs = 0, controller } = {}) {
  if (!body || typeof body.getReader !== 'function') throw new Error('empty response body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let timer = null;

  const touch = () => {
    if (!idleMs || !controller) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        controller.abort(new Error('idle timeout'));
      } catch {}
    }, idleMs);
    timer.unref?.();
  };

  touch();
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('event:')) {
          event = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        await onData(obj, event);
        event = '';
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {}
  }
}

module.exports = { DeepSeekStreamParser, pumpSSE };
