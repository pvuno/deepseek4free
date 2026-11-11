'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const config = require('./config');
const { solvePow } = require('./pow');
const log = require('./logger');

class PowPool {
  constructor(size = config.powWorkers) {
    this.size = Math.max(0, Math.trunc(size) || 0);
    this.workers = [];
    this.queue = [];
    this.seq = 0;
    this.tasks = new Map();
    this.closed = false;
    for (let i = 0; i < this.size; i++) this.spawn(i);
    if (this.size) log.info(`pow: ${this.size} worker(s) started`);
  }

  spawn(slot) {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'pow-worker.js'));
    } catch (e) {
      log.warn(`pow: cannot start worker (${e.message}), falling back to inline solver`);
      this.size = 0;
      return;
    }
    worker.slot = slot;
    worker.busy = null;
    worker.on('message', (msg) => this.onMessage(worker, msg));
    worker.on('error', (err) => this.onCrash(worker, err));
    worker.on('exit', (code) => {
      if (code !== 0 && !this.closed) log.warn(`pow: worker exited with code ${code}`);
      this.onCrash(worker, new Error(`worker exited (${code})`), false);
    });
    this.workers[slot] = worker;
  }

  onMessage(worker, msg) {
    const task = worker.busy;
    worker.busy = null;
    if (!task) return;
    this.tasks.delete(task.id);
    clearTimeout(task.timer);
    if (msg && msg.error) task.reject(new Error(msg.error));
    else task.resolve(msg.answer);
    this.pump();
  }

  onCrash(worker, err) {
    const task = worker.busy;
    worker.busy = null;
    if (task) {
      this.tasks.delete(task.id);
      clearTimeout(task.timer);
      task.reject(err);
    }
    if (this.closed) return;
    const slot = worker.slot;
    if (this.workers[slot] === worker) {
      this.workers[slot] = null;

      setTimeout(() => {
        if (!this.closed && !this.workers[slot]) this.spawn(slot);
      }, 250).unref?.();
    }
    this.pump();
  }

  pump() {
    if (this.closed) return;
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      if (!w || w.busy || !this.queue.length) continue;
      const task = this.queue.shift();
      w.busy = task;
      this.tasks.set(task.id, task);
      w.postMessage({
        id: task.id,
        challenge: task.challenge.challenge,
        salt: task.challenge.salt,
        expireAt: task.challenge.expire_at,
        difficulty: task.challenge.difficulty,
      });
    }
  }

  solve(challenge) {
    if (!this.size) {
      return Promise.resolve(
        solvePow({
          challenge: challenge.challenge,
          salt: challenge.salt,
          expireAt: challenge.expire_at,
          difficulty: challenge.difficulty,
        })
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timeoutMs = Math.max(30_000, (Number(challenge.difficulty) || 0) * 20);
      const timer = setTimeout(() => {
        const t = this.tasks.get(id);
        this.tasks.delete(id);
        reject(new Error('pow: solver timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.queue.push({ id, challenge, resolve, reject, timer });
      this.pump();
    });
  }

  async close() {
    this.closed = true;
    const err = new Error('pow pool closed');
    for (const t of this.tasks.values()) {
      clearTimeout(t.timer);
      t.reject(err);
    }
    this.tasks.clear();
    this.queue = [];
    await Promise.all(
      this.workers.filter(Boolean).map(
        (w) =>
          new Promise((r) => {
            const done = () => r();
            w.once('exit', done);
            w.terminate().catch(done);
            setTimeout(done, 2000).unref?.();
          })
      )
    );
    this.workers = [];
  }
}

module.exports = { PowPool };
