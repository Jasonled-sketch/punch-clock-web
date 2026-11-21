// 「這張臉是誰」的規則：只跟家人親手標過（confirmed）的臉比對。
// 很像 → 自動歸人；有點像 → 列為「可能是他？」等家人一鍵確認；不像 → 進認人頁排隊。
import { q } from './db.js';
import { config } from './config.js';
import { distance, fromBlob } from './faces.js';

let samples = null; // [{personId, d}]
function loadSamples() {
  if (!samples) {
    samples = q.all(`SELECT person_id AS personId, descriptor FROM faces WHERE status = 'confirmed' AND person_id IS NOT NULL`)
      .map(r => ({ personId: r.personId, d: fromBlob(r.descriptor) }));
  }
  return samples;
}
export const invalidateSamples = () => { samples = null; };

/** 每個人取「最像的那張樣本」的距離，由近到遠 */
function rank(descriptor) {
  const best = new Map();
  for (const s of loadSamples()) {
    const d = distance(descriptor, s.d);
    if (!best.has(s.personId) || d < best.get(s.personId)) best.set(s.personId, d);
  }
  return [...best.entries()].map(([personId, dist]) => ({ personId, dist })).sort((a, b) => a.dist - b.dist);
}

/**
 * 一張照片裡的臉一起判斷：同一個人在一張照片只會出現一次。
 * @param {Array<{id:number, descriptor:Float32Array}>} faces
 * @returns {Map<number, {personId:number|null, status:string, dist:number|null}>}
 */
export function matchFaces(faces) {
  const T = config.faces.matchThreshold, SUGGEST = T + 0.14, MARGIN = 0.04;
  const cands = [];
  for (const f of faces) {
    const r = rank(f.descriptor);
    r.forEach((c, i) => cands.push({ faceId: f.id, ...c, runnerUp: r[i === 0 ? 1 : 0]?.dist ?? Infinity }));
  }
  cands.sort((a, b) => a.dist - b.dist);
  const out = new Map(faces.map(f => [f.id, { personId: null, status: 'unknown', dist: null }]));
  const usedPerson = new Set(), usedFace = new Set();
  for (const c of cands) {
    if (c.dist > SUGGEST) break;
    if (usedFace.has(c.faceId) || usedPerson.has(c.personId)) continue;
    usedFace.add(c.faceId); usedPerson.add(c.personId);
    const sure = c.dist <= T && c.runnerUp - c.dist >= MARGIN;
    out.set(c.faceId, { personId: c.personId, status: sure ? 'auto' : 'suggest', dist: Math.round(c.dist * 1000) / 1000 });
  }
  return out;
}

/** 有新的標記後，把還沒確定的臉重新比一次 */
export function rematchPending() {
  invalidateSamples();
  const rows = q.all(`SELECT id, photo_id, descriptor FROM faces WHERE status IN ('unknown', 'suggest') ORDER BY photo_id`);
  const byPhoto = new Map();
  for (const r of rows) {
    if (!byPhoto.has(r.photo_id)) byPhoto.set(r.photo_id, []);
    byPhoto.get(r.photo_id).push({ id: r.id, descriptor: fromBlob(r.descriptor) });
  }
  let changed = 0;
  for (const [photoId, faces] of byPhoto) {
    // 這張照片已經確定出現的人，不能再配給別張臉
    const taken = new Set(q.all(`SELECT person_id FROM faces WHERE photo_id = ? AND status IN ('auto', 'confirmed') AND person_id IS NOT NULL`, photoId).map(r => r.person_id));
    for (const [faceId, m] of matchFaces(faces)) {
      if (m.personId && taken.has(m.personId)) continue;
      const r = q.run('UPDATE faces SET person_id = ?, status = ?, dist = ? WHERE id = ? AND (status != ? OR person_id IS NOT ?)',
        m.personId, m.status, m.dist, faceId, m.status, m.personId);
      changed += Number(r.changes);
    }
  }
  return changed;
}

export function findOrCreatePerson(name) {
  name = String(name || '').trim().slice(0, 20);
  if (!name) throw new Error('名字不能空白');
  const hit = q.get('SELECT id FROM people WHERE name = ?', name);
  if (hit) return hit.id;
  return Number(q.run('INSERT INTO people(name, created_at) VALUES(?, ?)', name, Date.now()).lastInsertRowid);
}

/** 家人說「這幾張臉是某某」→ 當成樣本，並回頭重認其他照片 */
export function nameFaces(faceIds, name) {
  const personId = findOrCreatePerson(name);
  for (const id of faceIds) q.run(`UPDATE faces SET person_id = ?, status = 'confirmed', dist = 0 WHERE id = ?`, personId, Number(id));
  const rematched = rematchPending();
  return { personId, rematched };
}
export function ignoreFaces(faceIds) {
  for (const id of faceIds) q.run(`UPDATE faces SET person_id = NULL, status = 'ignored' WHERE id = ?`, Number(id));
  invalidateSamples();
}
export function renamePerson(id, name) {
  name = String(name || '').trim().slice(0, 20);
  if (!name) throw new Error('名字不能空白');
  const other = q.get('SELECT id FROM people WHERE name = ? AND id != ?', name, id);
  if (other) { // 改成已存在的名字 = 合併成同一個人
    q.run('UPDATE faces SET person_id = ? WHERE person_id = ?', other.id, id);
    q.run('DELETE FROM people WHERE id = ?', id);
    invalidateSamples();
    return other.id;
  }
  q.run('UPDATE people SET name = ? WHERE id = ?', name, id);
  return id;
}

/** 認人頁：把還沒確定的臉，長得像的排成一堆，一次命名一堆 */
export function pendingClusters(limit = 40) {
  const rows = q.all(`
    SELECT f.id, f.photo_id, f.descriptor, f.status, f.person_id, f.dist, f.score, p.name AS guess
    FROM faces f JOIN photos ph ON ph.id = f.photo_id LEFT JOIN people p ON p.id = f.person_id
    WHERE f.status IN ('unknown', 'suggest') AND ph.hidden = 0
    ORDER BY f.score DESC LIMIT 3000`);
  const T = config.faces.clusterThreshold;
  const clusters = [];
  for (const r of rows) {
    const d = fromBlob(r.descriptor);
    const key = r.status === 'suggest' ? r.person_id : null; // 「可能是小明」的自成一堆
    let home = null, best = T;
    for (const c of clusters) {
      if (c.guessId !== key) continue;
      const dist = distance(d, c.center);
      if (dist < best) { best = dist; home = c; }
    }
    if (!home) {
      home = { guessId: key, guess: r.status === 'suggest' ? r.guess : null, center: d, faces: [] };
      clusters.push(home);
    }
    home.faces.push({ id: r.id, photoId: r.photo_id, dist: r.dist });
  }
  return clusters
    .sort((a, b) => (b.guessId ? 1 : 0) - (a.guessId ? 1 : 0) || b.faces.length - a.faces.length)
    .slice(0, limit)
    .map(c => ({ guessId: c.guessId, guess: c.guess, count: c.faces.length, faces: c.faces.slice(0, 24) }));
}

export function peopleList() {
  return q.all(`
    SELECT p.id, p.name,
      (SELECT COUNT(DISTINCT f.photo_id) FROM faces f JOIN photos ph ON ph.id = f.photo_id
        WHERE f.person_id = p.id AND f.status IN ('auto', 'confirmed') AND ph.hidden = 0 AND ph.duplicate_of IS NULL) AS photos,
      (SELECT f.id FROM faces f WHERE f.person_id = p.id AND f.status = 'confirmed' ORDER BY f.score DESC LIMIT 1) AS coverFace
    FROM people p ORDER BY photos DESC`);
}
export function namesInPhoto(photoId) {
  return q.all(`SELECT p.name FROM faces f JOIN people p ON p.id = f.person_id
    WHERE f.photo_id = ? AND f.status IN ('auto', 'confirmed') ORDER BY f.x`, photoId).map(r => r.name);
}
