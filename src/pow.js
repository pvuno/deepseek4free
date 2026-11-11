'use strict';

const RATE = 136;
const ROUNDS = 24;

const RC = [
  '0000000000000001',
  '0000000000008082',
  '800000000000808a',
  '8000000080008000',
  '000000000000808b',
  '0000000080000001',
  '8000000080008081',
  '8000000000008009',
  '000000000000008a',
  '0000000000000088',
  '0000000080008009',
  '000000008000000a',
  '000000008000808b',
  '800000000000008b',
  '8000000000008089',
  '8000000000008003',
  '8000000000008002',
  '8000000000000080',
  '000000000000800a',
  '800000008000000a',
  '8000000080008081',
  '8000000000008080',
  '0000000080000001',
  '8000000080008008',
].map((h) => {
  const v = BigInt('0x' + h);
  return [Number(v & 0xffffffffn), Number(v >> 32n)];
});

const RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const PI = [
  0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4,
];

const B = new Uint32Array(50);
const C = new Uint32Array(10);
const D = new Uint32Array(10);

function keccakF23(s) {
  for (let r = 1; r < ROUNDS; r++) {
    for (let x = 0; x < 5; x++) {
      const i = 2 * x;
      C[i] = s[i] ^ s[i + 10] ^ s[i + 20] ^ s[i + 30] ^ s[i + 40];
      C[i + 1] = s[i + 1] ^ s[i + 11] ^ s[i + 21] ^ s[i + 31] ^ s[i + 41];
    }
    for (let x = 0; x < 5; x++) {
      const p = 2 * ((x + 4) % 5);
      const q = 2 * ((x + 1) % 5);
      const i = 2 * x;
      D[i] = C[p] ^ ((C[q] << 1) | (C[q + 1] >>> 31));
      D[i + 1] = C[p + 1] ^ ((C[q + 1] << 1) | (C[q] >>> 31));
    }
    for (let i = 0; i < 25; i++) {
      const d = 2 * (i % 5);
      s[2 * i] ^= D[d];
      s[2 * i + 1] ^= D[d + 1];
    }

    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i];
      const hi = s[2 * i + 1];
      const rot = RHO[i];
      let nlo;
      let nhi;
      if (rot === 0) {
        nlo = lo;
        nhi = hi;
      } else if (rot < 32) {
        nlo = (lo << rot) | (hi >>> (32 - rot));
        nhi = (hi << rot) | (lo >>> (32 - rot));
      } else if (rot === 32) {
        nlo = hi;
        nhi = lo;
      } else {
        const r2 = rot - 32;
        nlo = (hi << r2) | (lo >>> (32 - r2));
        nhi = (lo << r2) | (hi >>> (32 - r2));
      }
      const j = 2 * PI[i];
      B[j] = nlo;
      B[j + 1] = nhi;
    }

    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = 2 * (y + x);
        const i1 = 2 * (y + ((x + 1) % 5));
        const i2 = 2 * (y + ((x + 2) % 5));
        s[i] = B[i] ^ (~B[i1] & B[i2]);
        s[i + 1] = B[i + 1] ^ (~B[i1 + 1] & B[i2 + 1]);
      }
    }

    s[0] ^= RC[r][0];
    s[1] ^= RC[r][1];
  }
}

function absorbBlock(state, buf, off) {
  for (let i = 0; i < 17; i++) {
    const p = off + i * 8;
    const lo = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    const hi = (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16) | (buf[p + 7] << 24)) >>> 0;
    state[2 * i] ^= lo;
    state[2 * i + 1] ^= hi;
  }
}

function deepseekHashV1(data) {
  const state = new Uint32Array(50);
  let off = 0;
  while (off + RATE <= data.length) {
    absorbBlock(state, data, off);
    keccakF23(state);
    off += RATE;
  }
  const tail = new Uint8Array(RATE);
  tail.set(data.subarray(off));
  tail[data.length - off] = 0x06;
  tail[RATE - 1] |= 0x80;
  absorbBlock(state, tail, 0);
  keccakF23(state);
  return lanesToBuffer(state);
}

function lanesToBuffer(state) {
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeUInt32LE(state[2 * i] >>> 0, i * 8);
    out.writeUInt32LE(state[2 * i + 1] >>> 0, i * 8 + 4);
  }
  return out;
}

function buildPrefix(salt, expireAt) {
  return `${salt}_${expireAt}_`;
}

const SCRATCH = new Uint8Array(RATE);
const STATE = new Uint32Array(50);

function solvePow({ challenge, salt, expireAt, difficulty, onProgress }) {
  if (typeof challenge !== 'string' || !/^[0-9a-fA-F]{64}$/.test(challenge)) {
    throw new Error('pow: challenge must be 64 hex chars');
  }
  const total = Math.trunc(Number(difficulty) || 0);
  if (!(total > 0)) throw new Error('pow: difficulty must be > 0');

  const target = Buffer.from(challenge, 'hex');
  const t0 = target.readUInt32LE(0);
  const t1 = target.readUInt32LE(4);
  const t2 = target.readUInt32LE(8);
  const t3 = target.readUInt32LE(12);
  const t4 = target.readUInt32LE(16);
  const t5 = target.readUInt32LE(20);
  const t6 = target.readUInt32LE(24);
  const t7 = target.readUInt32LE(28);

  const prefix = Buffer.from(buildPrefix(salt, expireAt), 'utf8');
  const base = new Uint32Array(50);
  let off = 0;
  while (off + RATE <= prefix.length) {
    absorbBlock(base, prefix, off);
    keccakF23(base);
    off += RATE;
  }
  const tailLen = prefix.length - off;
  const tail = new Uint8Array(tailLen);
  tail.set(prefix.subarray(off));

  for (let n = 0; n < total; n++) {
    if (onProgress && (n & 0x1fff) === 0) onProgress(n, total);

    const num = String(n);
    const numLen = num.length;
    const totalTail = tailLen + numLen;

    STATE.set(base);
    if (totalTail < RATE) {
      SCRATCH.fill(0);
      SCRATCH.set(tail, 0);
      for (let i = 0; i < numLen; i++) SCRATCH[tailLen + i] = num.charCodeAt(i);
      SCRATCH[totalTail] = 0x06;
      SCRATCH[RATE - 1] |= 0x80;
      absorbBlock(STATE, SCRATCH, 0);
      keccakF23(STATE);
    } else {
      SCRATCH.fill(0);
      SCRATCH.set(tail, 0);
      const first = RATE - tailLen;
      for (let i = 0; i < first; i++) SCRATCH[tailLen + i] = num.charCodeAt(i);
      absorbBlock(STATE, SCRATCH, 0);
      keccakF23(STATE);

      const rest = totalTail - RATE;
      SCRATCH.fill(0);
      let pos = first;
      for (let i = 0; i < rest; i++) SCRATCH[i] = num.charCodeAt(pos + i);
      SCRATCH[rest] = 0x06;
      SCRATCH[RATE - 1] |= 0x80;
      absorbBlock(STATE, SCRATCH, 0);
      keccakF23(STATE);
    }

    if (
      STATE[0] >>> 0 === t0 &&
      STATE[1] >>> 0 === t1 &&
      STATE[2] >>> 0 === t2 &&
      STATE[3] >>> 0 === t3 &&
      STATE[4] >>> 0 === t4 &&
      STATE[5] >>> 0 === t5 &&
      STATE[6] >>> 0 === t6 &&
      STATE[7] >>> 0 === t7
    ) {
      if (onProgress) onProgress(n, total);
      return n;
    }
  }
  throw new Error('pow: no solution found within difficulty');
}

function buildPowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function solveAndBuildHeader(challenge, opts) {
  const answer = solvePow({
    challenge: challenge.challenge,
    salt: challenge.salt,
    expireAt: challenge.expire_at,
    difficulty: challenge.difficulty,
    onProgress: opts && opts.onProgress,
  });
  return { answer, header: buildPowHeader(challenge, answer) };
}

module.exports = {
  deepseekHashV1,
  solvePow,
  buildPowHeader,
  solveAndBuildHeader,
  buildPrefix,
};
