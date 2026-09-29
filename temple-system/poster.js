// 芳名錄海報・帆布產生器：名單 → SVG（向量，可給輸出中心任意放大）→ PNG／列印

const POSTER_SIZES = {
  a4:   { name: 'A4（21×29.7 cm）', w: 210, h: 297 },
  a3:   { name: 'A3（29.7×42 cm）', w: 297, h: 420 },
  half: { name: '對開海報（54.5×78.7 cm）', w: 545, h: 787 },
  b60:  { name: '帆布 60×90 cm', w: 600, h: 900 },
  b90:  { name: '帆布 90×180 cm', w: 900, h: 1800 },
  b120: { name: '帆布 120×240 cm', w: 1200, h: 2400 },
};

const POSTER_THEMES = {
  red:   { name: '紅底金字', bg: '#B3161B', frame: '#F2C14E', title: '#FFE39A', name_: '#FFFFFF', amount: '#FFE39A', foot: '#FFE39A' },
  white: { name: '白底紅字（省墨）', bg: '#FFFFFF', frame: '#B3161B', title: '#B3161B', name_: '#1A1A1A', amount: '#B3161B', foot: '#6B1A12' },
};

const POSTER_FONT = "DFKai-SB, BiauKai, 'Kaiti TC', 'Noto Serif TC', 'Songti TC', serif";

// 金額轉國字大寫：36000 → 參萬陸仟元
function cnAmount(n) {
  n = Math.floor(Number(n) || 0);
  if (!n) return '零元';
  const D = '零壹貳參肆伍陸柒捌玖', U = ['仟', '佰', '拾', ''], BIG = ['億', '萬', ''];
  const seg4 = v => {
    let s = '', zero = false;
    [Math.floor(v / 1000), Math.floor(v / 100) % 10, Math.floor(v / 10) % 10, v % 10].forEach((d, i) => {
      if (!d) { if (s) zero = true; } else { if (zero) { s += '零'; zero = false; } s += D[d] + U[i]; }
    });
    return s;
  };
  const segs = [Math.floor(n / 1e8), Math.floor(n / 1e4) % 1e4, n % 1e4];
  let out = '', gap = false;
  segs.forEach((v, i) => {
    if (!v) { if (out) gap = true; return; }
    if (out && (gap || v < 1000)) out += '零';
    out += seg4(v) + BIG[i]; gap = false;
  });
  return out + '元';
}

function xmlEsc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// opt: {w,h (mm), theme, layout:'v'|'h', title, subtitle, footer, showAmount}
// entries: [{name, amount, role?}] 已排序
function posterSVG(opt, entries) {
  const U = 10, W = opt.w * U, H = opt.h * U;         // 0.1 mm 為單位
  const T = POSTER_THEMES[opt.theme] || POSTER_THEMES.red;
  const m = Math.min(W, H) * 0.05;
  const titleF = Math.min(W * 0.1, H * 0.07);
  const subF = titleF * 0.38;
  const footF = titleF * 0.3;
  const top = m * 1.6 + titleF + subF * 1.8;
  const bottom = H - m * 1.6 - footF * 1.6;
  const left = m * 1.6, right = W - m * 1.6;
  const bw = right - left, bh = bottom - top;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${opt.w}mm" height="${opt.h}mm">`);
  out.push(`<rect width="${W}" height="${H}" fill="${T.bg}"/>`);
  out.push(`<rect x="${m * 0.6}" y="${m * 0.6}" width="${W - m * 1.2}" height="${H - m * 1.2}" fill="none" stroke="${T.frame}" stroke-width="${m * 0.12}"/>`);
  out.push(`<rect x="${m * 0.9}" y="${m * 0.9}" width="${W - m * 1.8}" height="${H - m * 1.8}" fill="none" stroke="${T.frame}" stroke-width="${m * 0.04}"/>`);
  const txt = (x, y, s, f, fill, anchor = 'middle', weight = 700) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${f.toFixed(1)}" fill="${fill}" text-anchor="${anchor}" font-family="${POSTER_FONT}" font-weight="${weight}">${xmlEsc(s)}</text>`;
  out.push(txt(W / 2, m * 1.4 + titleF * 0.88, opt.title, titleF, T.title, 'middle', 900));
  if (opt.subtitle) out.push(txt(W / 2, m * 1.4 + titleF + subF * 1.3, opt.subtitle, subF, T.title));
  out.push(txt(W / 2, H - m * 1.5, opt.footer, footF, T.foot));

  const items = entries.map(e => ({ name: e.name, amt: opt.showAmount ? cnAmount(e.amount) : '' }));
  const n = items.length;
  if (!n) { out.push(txt(W / 2, H / 2, '（尚無名單）', titleF * 0.4, T.name_)); out.push('</svg>'); return out.join(''); }

  if (opt.layout === 'h') {
    const maxLen = Math.max(...items.map(i => i.name.length + (i.amt ? i.amt.length * 0.75 + 1 : 0)));
    let f = titleF * 0.6, cols, rows;
    for (; f > 2; f *= 0.96) {
      const cw = f * (maxLen + 1.5), rh = f * 1.7;
      cols = Math.max(1, Math.floor(bw / cw)); rows = Math.ceil(n / cols);
      if (rows * rh <= bh) break;
    }
    const cw = bw / cols, rh = f * 1.7;
    const y0 = top + Math.max(0, (bh - rows * rh) / 2);
    items.forEach((it, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const x = left + c * cw + cw / 2, y = y0 + r * rh + f;
      out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="${POSTER_FONT}" font-weight="700"><tspan font-size="${f.toFixed(1)}" fill="${T.name_}">${xmlEsc(it.name)}</tspan>${it.amt ? `<tspan font-size="${(f * 0.75).toFixed(1)}" fill="${T.amount}" dx="${(f * 0.5).toFixed(1)}">${xmlEsc(it.amt)}</tspan>` : ''}</text>`);
    });
  } else {
    // 直式：每人一直行，由右至左，排滿換下一段
    const maxName = Math.max(...items.map(i => i.name.length));
    const maxAmt = Math.max(0, ...items.map(i => i.amt.length));
    let f = titleF * 0.6, cols, bands, colH;
    for (; f > 2; f *= 0.96) {
      colH = f * maxName + (maxAmt ? f * 0.5 + f * 0.72 * maxAmt : 0);
      const cw = f * 1.55;
      cols = Math.max(1, Math.floor(bw / cw)); bands = Math.ceil(n / cols);
      if (bands * colH + (bands - 1) * f * 1.2 <= bh) break;
    }
    const cw = bw / Math.min(cols, n);
    const used = Math.min(cols, n) * cw;
    const x0 = right - (bw - used) / 2;
    const totalH = bands * colH + (bands - 1) * f * 1.2;
    const y0 = top + Math.max(0, (bh - totalH) / 2);
    items.forEach((it, i) => {
      const c = i % cols, b = Math.floor(i / cols);
      const x = x0 - c * cw - cw / 2;
      let y = y0 + b * (colH + f * 1.2);
      // 名字置中於名字區
      const pad = (maxName - it.name.length) * f / 2;
      [...it.name].forEach((ch, k) => out.push(txt(x, y + pad + f * (k + 0.88), ch, f, T.name_)));
      if (it.amt) {
        const fa = f * 0.72, ya = y + f * maxName + f * 0.5;
        [...it.amt].forEach((ch, k) => out.push(txt(x, ya + fa * (k + 0.88), ch, fa, T.amount)));
      }
      if (b > 0 && c === 0) out.push(`<line x1="${left}" x2="${right}" y1="${(y - f * 0.6).toFixed(1)}" y2="${(y - f * 0.6).toFixed(1)}" stroke="${T.frame}" stroke-width="${(f * 0.04).toFixed(1)}" opacity=".6"/>`);
    });
  }
  out.push('</svg>');
  return out.join('');
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function svgToPng(svg, wmm, hmm, dpi) {
  return new Promise((resolve, reject) => {
    let pw = Math.round(wmm / 25.4 * dpi), ph = Math.round(hmm / 25.4 * dpi);
    const cap = 16000 / Math.max(pw, ph);
    if (cap < 1) { pw = Math.round(pw * cap); ph = Math.round(ph * cap); }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = pw; c.height = ph;
      c.getContext('2d').drawImage(img, 0, 0, pw, ph);
      c.toBlob(b => b ? resolve({ blob: b, pw, ph }) : reject(new Error('轉檔失敗')), 'image/png');
    };
    img.onerror = () => reject(new Error('轉檔失敗'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
