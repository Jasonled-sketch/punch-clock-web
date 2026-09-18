// MD5（RFC 1321）——安智連 LPush 的 token 驗簽用。
//
// 為什麼要自己寫一份：Node 有 crypto.createHash('md5')，但 Cloudflare Worker 的
// WebCrypto 沒有 MD5（只有 SHA 系列）。這份純 JS 版讓同一段驗簽程式在 Railway
// 和 Worker 都能跑。有 node:crypto 時會自動走原生版（比較快）。

let nodeCrypto = null;
try {
  // eslint-disable-next-line global-require
  nodeCrypto = require('node:crypto');
  if (typeof nodeCrypto.createHash !== 'function') nodeCrypto = null;
} catch (_) {
  nodeCrypto = null;
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  return Uint8Array.from(Buffer.from(str, 'utf8'));
}

function md5Pure(input) {
  const msg = typeof input === 'string' ? utf8Bytes(input) : Uint8Array.from(input);
  const bitLen = msg.length * 8;

  // padding：0x80，補 0 到 length % 64 === 56，最後 8 byte 放 little-endian 位元長度
  const padded = new Uint8Array(((msg.length + 8) >> 6 << 6) + 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const lenLo = bitLen >>> 0;
  const lenHi = Math.floor(bitLen / 4294967296) >>> 0;
  const tail = padded.length - 8;
  padded[tail] = lenLo & 0xff;
  padded[tail + 1] = (lenLo >>> 8) & 0xff;
  padded[tail + 2] = (lenLo >>> 16) & 0xff;
  padded[tail + 3] = (lenLo >>> 24) & 0xff;
  padded[tail + 4] = lenHi & 0xff;
  padded[tail + 5] = (lenHi >>> 8) & 0xff;
  padded[tail + 6] = (lenHi >>> 16) & 0xff;
  padded[tail + 7] = (lenHi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = off + i * 4;
      M[i] = (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i += 1) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = [a0, b0, c0, d0];
  let hex = '';
  for (let i = 0; i < 4; i += 1) {
    const w = out[i];
    for (let b = 0; b < 4; b += 1) {
      hex += (((w >>> (b * 8)) & 0xff) + 0x100).toString(16).slice(1);
    }
  }
  return hex;
}

function md5(input) {
  if (nodeCrypto) {
    return nodeCrypto.createHash('md5').update(input, 'utf8').digest('hex');
  }
  return md5Pure(input);
}

module.exports = { md5, md5Pure };
