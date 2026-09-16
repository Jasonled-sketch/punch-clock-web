/*!
 * qr.js — 極簡 QR Code 產生器（Byte mode / Version 1-10 / EC L,M,Q,H）
 * 純前端、零外部相依，離線可用。用途：保固條款頁的機身標籤 QR。
 * 用法：QRLite.make('https://...', 'M') -> { size, modules:[[bool]] , version }
 */
(function (root) {
  'use strict';

  // ── GF(256) ─────────────────────────────────────────────
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenPoly(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      if (factor !== 0) for (var j = 0; j < gen.length - 1; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // ── 版本 / 區塊表 (version 1-10) ────────────────────────
  // [ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW]
  var RS = {
    L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],[18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69]],
    M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],[16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]],
    Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],[24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20]],
    H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],[28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16]]
  };
  var ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
  var VER_INFO = { 7:0x07C94, 8:0x085BC, 9:0x09A99, 10:0x0A4D3 };
  var ECL_BITS = { L:1, M:0, Q:3, H:2 };

  function dataCapacity(ver, ecl) {
    var r = RS[ecl][ver - 1];
    return r[1] * r[2] + r[3] * r[4];
  }

  // ── 位元串流 ────────────────────────────────────────────
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function utf8Bytes(str) {
    var out = [], enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(str) : null;
    if (enc) { for (var k = 0; k < enc.length; k++) out.push(enc[k]); return out; }
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function buildCodewords(bytes, ver, ecl) {
    var cap = dataCapacity(ver, ecl);
    var bb = new BitBuf();
    bb.put(4, 4);                                   // byte mode
    bb.put(bytes.length, ver < 10 ? 8 : 16);        // character count
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    var maxBits = cap * 8;
    var term = Math.min(4, maxBits - bb.bits.length);
    bb.put(0, term);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);
    var cw = [];
    for (var b = 0; b < bb.bits.length; b += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bb.bits[b + j];
      cw.push(v);
    }
    var pad = [0xEC, 0x11], p = 0;
    while (cw.length < cap) cw.push(pad[p++ % 2]);

    // 分區塊 → RS → 交錯
    var r = RS[ecl][ver - 1], ecLen = r[0];
    var blocks = [], idx = 0, g;
    for (g = 0; g < r[1]; g++) { blocks.push(cw.slice(idx, idx + r[2])); idx += r[2]; }
    for (g = 0; g < r[3]; g++) { blocks.push(cw.slice(idx, idx + r[4])); idx += r[4]; }
    var ecBlocks = blocks.map(function (bk) { return rsEncode(bk, ecLen); });

    var out = [], maxData = Math.max(r[2], r[4]), n;
    for (n = 0; n < maxData; n++) for (var bi = 0; bi < blocks.length; bi++) if (n < blocks[bi].length) out.push(blocks[bi][n]);
    for (n = 0; n < ecLen; n++) for (var ei = 0; ei < ecBlocks.length; ei++) out.push(ecBlocks[ei][n]);
    return out;
  }

  // ── 矩陣 ────────────────────────────────────────────────
  function newMatrix(size) {
    var m = [], r = [];
    for (var i = 0; i < size; i++) { m.push(new Array(size).fill(null)); r.push(new Array(size).fill(false)); }
    return { m: m, reserved: r, size: size };
  }

  function placeFinder(M, row, col) {
    for (var i = -1; i <= 7; i++) for (var j = -1; j <= 7; j++) {
      var rr = row + i, cc = col + j;
      if (rr < 0 || cc < 0 || rr >= M.size || cc >= M.size) continue;
      var dark = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                 (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
                 (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      M.m[rr][cc] = dark; M.reserved[rr][cc] = true;
    }
  }

  function placeFunctionPatterns(M, ver) {
    var size = M.size, i, j;
    placeFinder(M, 0, 0); placeFinder(M, 0, size - 7); placeFinder(M, size - 7, 0);
    // timing
    for (i = 8; i < size - 8; i++) {
      M.m[6][i] = (i % 2 === 0); M.reserved[6][i] = true;
      M.m[i][6] = (i % 2 === 0); M.reserved[i][6] = true;
    }
    // alignment
    var pos = ALIGN[ver - 1];
    for (i = 0; i < pos.length; i++) for (j = 0; j < pos.length; j++) {
      var r = pos[i], c = pos[j];
      // 只排除與三個定位圖案重疊者；落在 timing 線上的對齊圖案必須保留
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        M.m[r + dr][c + dc] = (Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        M.reserved[r + dr][c + dc] = true;
      }
    }
    // dark module
    M.m[size - 8][8] = true; M.reserved[size - 8][8] = true;
    // format info 保留區
    for (i = 0; i <= 8; i++) {
      if (!M.reserved[8][i]) { M.reserved[8][i] = true; M.m[8][i] = false; }
      if (!M.reserved[i][8]) { M.reserved[i][8] = true; M.m[i][8] = false; }
    }
    for (i = 0; i < 8; i++) {
      if (!M.reserved[8][size - 1 - i]) { M.reserved[8][size - 1 - i] = true; M.m[8][size - 1 - i] = false; }
      if (!M.reserved[size - 1 - i][8]) { M.reserved[size - 1 - i][8] = true; M.m[size - 1 - i][8] = false; }
    }
    // version info 保留區 (v7+)
    if (ver >= 7) {
      for (i = 0; i < 6; i++) for (j = 0; j < 3; j++) {
        M.reserved[size - 11 + j][i] = true; M.m[size - 11 + j][i] = false;
        M.reserved[i][size - 11 + j] = true; M.m[i][size - 11 + j] = false;
      }
    }
  }

  function placeData(M, cw) {
    var size = M.size, bitIdx = 0, total = cw.length * 8;
    var col = size - 1, up = true;
    while (col > 0) {
      if (col === 6) col--;            // 跳過 timing 欄
      for (var n = 0; n < size; n++) {
        var row = up ? (size - 1 - n) : n;
        for (var k = 0; k < 2; k++) {
          var c = col - k;
          if (M.reserved[row][c]) continue;
          var bit = false;
          if (bitIdx < total) bit = ((cw[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
          M.m[row][c] = bit; bitIdx++;
        }
      }
      col -= 2; up = !up;
    }
  }

  function maskFn(k, i, j) {
    switch (k) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      default: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    }
  }

  function bch15(data, gen, glen) {
    var d = data << (glen - 1);
    while (bitLen(d) >= glen) d ^= gen << (bitLen(d) - glen);
    return (data << (glen - 1)) | d;
  }
  function bitLen(x) { var n = 0; while (x !== 0) { n++; x >>>= 1; } return n; }

  function placeFormat(M, ecl, mask) {
    var size = M.size;
    var fmt = (bch15((ECL_BITS[ecl] << 3) | mask, 0x537, 11)) ^ 0x5412;
    for (var i = 0; i < 15; i++) {
      var bit = ((fmt >>> i) & 1) === 1;
      // 左上角直列（由上而下）＋ 左下角
      if (i < 6) M.m[i][8] = bit;
      else if (i < 8) M.m[i + 1][8] = bit;
      else M.m[size - 15 + i][8] = bit;
      // 左上角橫列（由右而左）＋ 右上角
      if (i < 8) M.m[8][size - 1 - i] = bit;
      else if (i === 8) M.m[8][7] = bit;
      else M.m[8][14 - i] = bit;
    }
  }

  function placeVersion(M, ver) {
    if (ver < 7) return;
    var size = M.size, bits = VER_INFO[ver];
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) === 1;
      var r = Math.floor(i / 3), c = i % 3;
      M.m[size - 11 + c][r] = bit;
      M.m[r][size - 11 + c] = bit;
    }
  }

  function penalty(m) {
    var size = m.length, score = 0, i, j, run, last, dark = 0;
    // 規則1：連續同色
    for (i = 0; i < size; i++) {
      run = 1; last = m[i][0];
      for (j = 1; j < size; j++) {
        if (m[i][j] === last) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; last = m[i][j]; }
      }
      if (run >= 5) score += 3 + (run - 5);
      run = 1; last = m[0][i];
      for (j = 1; j < size; j++) {
        if (m[j][i] === last) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; last = m[j][i]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // 規則2：2x2 同色
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {
      var v = m[i][j];
      if (m[i][j + 1] === v && m[i + 1][j] === v && m[i + 1][j + 1] === v) score += 3;
    }
    // 規則3：1011101 樣式
    var P1 = [true,false,true,true,true,false,true,false,false,false,false];
    var P2 = [false,false,false,false,true,false,true,true,true,false,true];
    function match(arr, off, pat) {
      for (var k = 0; k < 11; k++) if (arr[off + k] !== pat[k]) return false;
      return true;
    }
    for (i = 0; i < size; i++) {
      var rowArr = m[i], colArr = [];
      for (j = 0; j < size; j++) colArr.push(m[j][i]);
      for (j = 0; j <= size - 11; j++) {
        if (match(rowArr, j, P1) || match(rowArr, j, P2)) score += 40;
        if (match(colArr, j, P1) || match(colArr, j, P2)) score += 40;
      }
    }
    // 規則4：深色比例
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function make(text, ecl) {
    ecl = ecl || 'M';
    if (!RS[ecl]) throw new Error('不支援的錯誤更正等級：' + ecl);
    var bytes = utf8Bytes(String(text));
    var ver = 0;
    for (var v = 1; v <= 10; v++) {
      var headerBits = 4 + (v < 10 ? 8 : 16);
      if (bytes.length * 8 + headerBits <= dataCapacity(v, ecl) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('內容過長（本產生器支援至 version 10）');

    var cw = buildCodewords(bytes, ver, ecl);
    var size = ver * 4 + 17;
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var M = newMatrix(size);
      placeFunctionPatterns(M, ver);
      placeData(M, cw);
      for (var i = 0; i < size; i++) for (var j = 0; j < size; j++) {
        if (!M.reserved[i][j] && maskFn(mask, i, j)) M.m[i][j] = !M.m[i][j];
      }
      placeFormat(M, ecl, mask);
      placeVersion(M, ver);
      var sc = penalty(M.m);
      if (!best || sc < best.score) best = { score: sc, modules: M.m, mask: mask };
    }
    return { version: ver, size: size, modules: best.modules, mask: best.mask, ecLevel: ecl };
  }

  // ── 輸出 ────────────────────────────────────────────────
  function toSVG(qr, opt) {
    opt = opt || {};
    var quiet = opt.quiet == null ? 4 : opt.quiet;
    var dark = opt.dark || '#000', light = opt.light || '#fff';
    var n = qr.size, total = n + quiet * 2, d = '';
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      if (qr.modules[i][j]) d += 'M' + (j + quiet) + ' ' + (i + quiet) + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
      '" shape-rendering="crispEdges"><rect width="' + total + '" height="' + total + '" fill="' + light +
      '"/><path d="' + d + '" fill="' + dark + '"/></svg>';
  }

  function toCanvas(canvas, qr, opt) {
    opt = opt || {};
    var quiet = opt.quiet == null ? 4 : opt.quiet;
    var scale = opt.scale || 8;
    var total = (qr.size + quiet * 2) * scale;
    canvas.width = total; canvas.height = total;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opt.light || '#fff'; ctx.fillRect(0, 0, total, total);
    ctx.fillStyle = opt.dark || '#000';
    for (var i = 0; i < qr.size; i++) for (var j = 0; j < qr.size; j++) {
      if (qr.modules[i][j]) ctx.fillRect((j + quiet) * scale, (i + quiet) * scale, scale, scale);
    }
    return canvas;
  }

  var API = { make: make, toSVG: toSVG, toCanvas: toCanvas };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.QRLite = API;
})(typeof window !== 'undefined' ? window : globalThis);
