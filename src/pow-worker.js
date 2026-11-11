'use strict';

const { parentPort } = require('worker_threads');
const { solvePow } = require('./pow');

parentPort.on('message', (msg) => {
  try {
    const answer = solvePow({
      challenge: msg.challenge,
      salt: msg.salt,
      expireAt: msg.expireAt,
      difficulty: msg.difficulty,
    });
    parentPort.postMessage({ id: msg.id, answer });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: (e && e.message) || String(e) });
  }
});
