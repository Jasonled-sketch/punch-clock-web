import { q } from './db.js';
import { zonedToMs } from './time.js';

const VISIBLE = 'ph.hidden = 0 AND ph.duplicate_of IS NULL';
const dayStart = s => { const [y, m, d] = s.split('-').map(Number); return zonedToMs(y, m, d); };

/**
 * @param {{people?:string[], from?:string, to?:string, ym?:string, keywords?:string[], kind?:string, limit?:number, offset?:number, order?:'asc'|'desc'}} f
 */
export function searchPhotos(f = {}) {
  const where = [VISIBLE], args = [];
  if (f.ym) { where.push('ph.ym = ?'); args.push(f.ym); }
  if (f.from) { where.push('ph.taken_at >= ?'); args.push(dayStart(f.from)); }
  if (f.to) { where.push('ph.taken_at < ?'); args.push(dayStart(f.to) + 86400000); }
  if (f.kind) { where.push('ph.kind = ?'); args.push(f.kind); }
  for (const name of f.people || []) { // 每個被點名的人都要在照片裡
    where.push(`EXISTS (SELECT 1 FROM faces f JOIN people p ON p.id = f.person_id
      WHERE f.photo_id = ph.id AND p.name = ? AND f.status IN ('auto', 'confirmed'))`);
    args.push(name);
  }
  const kws = (f.keywords || []).map(k => String(k).trim()).filter(Boolean);
  if (kws.length) { // 關鍵字任一命中即可（AI 已把同義詞展開）
    where.push('(' + kws.map(() => `(ph.caption LIKE ? OR ph.tags LIKE ? OR ph.event LIKE ? OR ph.scene LIKE ?)`).join(' OR ') + ')');
    for (const k of kws) { const like = `%${k}%`; args.push(like, like, like, like); }
  }
  const sql = `FROM photos ph WHERE ${where.join(' AND ')}`;
  const total = q.get(`SELECT COUNT(*) AS n ${sql}`, ...args).n;
  const rows = q.all(`SELECT ph.id, ph.kind, ph.taken_at, ph.ym, ph.ymd, ph.caption, ph.event, ph.scene, ph.tags, ph.width, ph.height,
      ph.duration, ph.source, ph.uploader, ph.drive_file_id, ph.quality, ph.highlight, ph.face_count
    ${sql} ORDER BY ph.taken_at ${f.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    ...args, Math.min(f.limit || 60, 500), f.offset || 0);
  return { total, rows };
}

export function months() {
  return q.all(`SELECT ph.ym, COUNT(*) AS n, MAX(ph.id) AS cover FROM photos ph WHERE ${VISIBLE} GROUP BY ph.ym ORDER BY ph.ym DESC`);
}

export function stats(ym) {
  const cond = ym ? `AND ph.ym = '${ym.replace(/[^0-9-]/g, '')}'` : '';
  const total = q.get(`SELECT COUNT(*) AS n, SUM(ph.kind = 'video') AS videos FROM photos ph WHERE ${VISIBLE} ${cond}`);
  const people = q.all(`SELECT p.name, COUNT(DISTINCT f.photo_id) AS n FROM faces f JOIN people p ON p.id = f.person_id
    JOIN photos ph ON ph.id = f.photo_id WHERE f.status IN ('auto', 'confirmed') AND ${VISIBLE} ${cond} GROUP BY p.id ORDER BY n DESC`);
  const events = q.all(`SELECT ph.event AS name, COUNT(*) AS n FROM photos ph WHERE ${VISIBLE} ${cond} AND ph.event IS NOT NULL AND ph.is_document = 0
    GROUP BY ph.event ORDER BY n DESC LIMIT 6`);
  const pendingFaces = q.get(`SELECT COUNT(*) AS n FROM faces f JOIN photos ph ON ph.id = f.photo_id WHERE f.status IN ('unknown', 'suggest') AND ${VISIBLE}`).n;
  return { total: total.n, videos: total.videos || 0, people, events, pendingFaces };
}

/** 那年今日：往年同一天的照片 */
export function onThisDay(md, thisYear) {
  return q.all(`SELECT ph.id, ph.taken_at, ph.ymd, ph.caption, ph.kind FROM photos ph
    WHERE ${VISIBLE} AND substr(ph.ymd, 6) = ? AND substr(ph.ymd, 1, 4) < ? AND ph.kind = 'photo' AND ph.is_document = 0
    ORDER BY COALESCE(ph.highlight, 3) DESC, ph.taken_at DESC LIMIT 10`, md, String(thisYear));
}
