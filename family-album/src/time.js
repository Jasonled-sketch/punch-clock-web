// 時間一律用家裡的時區（預設台灣）切月份，伺服器在國外（UTC）也不會把月底的照片算到隔月。
import { config } from './config.js';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
const pad = n => String(n).padStart(2, '0');
export const ymOf = ms => { const p = parts(ms); return `${p.y}-${pad(p.m)}`; };
export const ymdOf = ms => { const p = parts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };

/** 把「當地牆上時間」轉成毫秒（EXIF 的拍攝時間沒有時區，要當成家裡的時區） */
export function zonedToMs(y, m, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const p = parts(guess);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return guess - (asUtc - guess);
}

/** "2026:11:01 08:30:00" 或 "2026-11-01T08:30:00"（可帶 +08:00）→ 毫秒 */
export function parseExifDate(str, offset) {
  if (!str) return null;
  if (str instanceof Date) return isNaN(str) ? null : str.getTime();
  const m = String(str).match(/(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(v => Number(v || 0));
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12) return null;
  const off = String(offset || '').match(/^([+-])(\d{2}):?(\d{2})$/);
  if (off) return Date.UTC(y, mo - 1, d, h, mi, s) - (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60000;
  return zonedToMs(y, mo, d, h, mi, s);
}

export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { from: zonedToMs(y, m, 1), to: m === 12 ? zonedToMs(y + 1, 1, 1) : zonedToMs(y, m + 1, 1) };
}
export function prevMonth(ms = Date.now()) {
  const p = parts(ms);
  return p.m === 1 ? `${p.y - 1}-12` : `${p.y}-${pad(p.m - 1)}`;
}
export const zhMonth = ym => { const [y, m] = ym.split('-'); return `${y} 年 ${Number(m)} 月`; };
export const zhDate = ms => { const p = parts(ms); return `${p.y}/${p.m}/${p.d}`; };
