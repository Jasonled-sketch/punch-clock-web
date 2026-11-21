// Google 雲端硬碟：爸爸、媽媽各自授權一次（只讀），指定放照片的資料夾，小秘書定時掃新照片進相簿。
// 原檔留在各自的雲端硬碟不搬動，相簿只存縮圖與索引；刪掉相簿不會動到雲端硬碟裡的任何東西。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { q, kv, encrypt, decrypt } from './db.js';
import { ingest } from './ingest.js';
import { parseExifDate, zhMonth } from './time.js';

const D = config.drive;
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'];
export const driveConfigured = () => Boolean(D.clientId && D.clientSecret);
const redirectUri = () => `${config.baseUrl}/auth/google/callback`;

export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: D.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(D.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: D.clientId, client_secret: D.clientSecret, ...params }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google 授權失敗：${body.error_description || body.error || res.status}`);
  return body;
}

const tokens = new Map(); // accountId → {token, exp}
async function accessToken(account) {
  const hit = tokens.get(account.id);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(account.refresh_token) });
  tokens.set(account.id, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
  return t.access_token;
}
async function gfetch(account, url, init = {}) {
  const res = await fetch(url.startsWith('http') ? url : D.apiBase + url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await accessToken(account)}` } });
  if (!res.ok) throw new Error(`Google Drive ${res.status}：${(await res.text()).slice(0, 200)}`);
  return res;
}

/** 授權完成：記下這個帳號 */
export async function handleCallback(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new Error('Google 沒有給長期授權，請到 Google 帳戶「第三方應用程式存取權」移除本程式後再授權一次');
  const res = await fetch(`${D.apiBase}/drive/v3/about?fields=user(displayName,emailAddress)`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (!res.ok) throw new Error(`讀不到 Google 帳號資料 ${res.status}`);
  const { user } = await res.json();
  q.run(`INSERT INTO drive_accounts(email, name, refresh_token, created_at) VALUES(?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET refresh_token = excluded.refresh_token, name = excluded.name`,
    user.emailAddress, user.displayName || user.emailAddress, encrypt(t.refresh_token), Date.now());
  return q.get('SELECT id, email, name FROM drive_accounts WHERE email = ?', user.emailAddress);
}

export function accounts() {
  return q.all('SELECT id, email, name, folders, last_scan_at, last_scan_note FROM drive_accounts ORDER BY id')
    .map(a => ({ ...a, folders: JSON.parse(a.folders || '[]'),
      indexed: q.get('SELECT COUNT(*) AS n FROM photos WHERE drive_account_id = ?', a.id).n }));
}
const getAccount = id => q.get('SELECT * FROM drive_accounts WHERE id = ?', Number(id));

/** 貼上雲端硬碟資料夾網址（或 ID）→ 加入掃描清單 */
export async function addFolder(accountId, urlOrId) {
  const account = getAccount(accountId);
  if (!account) throw new Error('找不到這個帳號');
  const m = String(urlOrId).match(/folders\/([\w-]{10,})/) || String(urlOrId).match(/[?&]id=([\w-]{10,})/) || String(urlOrId).trim().match(/^([\w-]{10,})$/);
  if (!m) throw new Error('看不懂這個網址，請貼雲端硬碟資料夾的網址');
  const meta = await (await gfetch(account, `/drive/v3/files/${m[1]}?fields=id,name,mimeType&supportsAllDrives=true`)).json();
  if (meta.mimeType !== 'application/vnd.google-apps.folder') throw new Error('這個連結不是資料夾');
  const folders = JSON.parse(account.folders || '[]').filter(f => f.id !== meta.id);
  folders.push({ id: meta.id, name: meta.name });
  q.run('UPDATE drive_accounts SET folders = ? WHERE id = ?', JSON.stringify(folders), account.id);
  return { id: meta.id, name: meta.name };
}
export function removeFolder(accountId, folderId) {
  const account = getAccount(accountId);
  if (!account) return;
  q.run('UPDATE drive_accounts SET folders = ? WHERE id = ?', JSON.stringify(JSON.parse(account.folders || '[]').filter(f => f.id !== folderId)), account.id);
}
export function removeAccount(accountId) {
  q.run('DELETE FROM drive_accounts WHERE id = ?', Number(accountId)); // 已建好的相簿索引保留
  tokens.delete(Number(accountId));
}

async function* listMedia(account, rootId) {
  const queue = [rootId], seen = new Set();
  while (queue.length) {
    const folder = queue.shift();
    if (seen.has(folder)) continue;
    seen.add(folder);
    let pageToken = '';
    do {
      const p = new URLSearchParams({
        q: `'${folder}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.folder')`,
        fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,imageMediaMetadata(time))',
        pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', orderBy: 'createdTime'
      });
      if (pageToken) p.set('pageToken', pageToken);
      const page = await (await gfetch(account, `/drive/v3/files?${p}`)).json();
      for (const f of page.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') queue.push(f.id);
        else yield f;
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken);
  }
}

let scanning = false;
export const isScanning = () => scanning;

/** 掃所有帳號的指定資料夾，一次最多處理 max 個新檔（其餘下一輪再做） */
export async function scanAll(max = D.maxPerScan) {
  if (scanning) return { busy: true };
  scanning = true;
  const summary = { added: 0, duplicate: 0, failed: 0, skipped: 0, more: false };
  const failed = new Set(kv.get('drive.failed', []));
  const videoMax = Number(process.env.DRIVE_VIDEO_MAX_MB || 100) * 1048576;
  try {
    for (const account of q.all('SELECT * FROM drive_accounts ORDER BY id')) {
      const before = { ...summary };
      try {
        scan: for (const folder of JSON.parse(account.folders || '[]')) {
          for await (const f of listMedia(account, folder.id)) {
            if (failed.has(f.id) || q.get('SELECT 1 FROM photos WHERE drive_file_id = ?', f.id)) continue;
            const isVideo = f.mimeType.startsWith('video/');
            if (Number(f.size || 0) > (isVideo ? videoMax : 80 * 1048576)) { summary.skipped++; failed.add(f.id); continue; }
            if (summary.added + summary.duplicate + summary.failed >= max) { summary.more = true; break scan; }
            const tmp = path.join(os.tmpdir(), `drive-${f.id}`);
            try {
              const res = await gfetch(account, `/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`);
              await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
              const r = await ingest({
                filePath: tmp, source: 'drive', sourceRef: f.name, uploader: account.name, driveFileId: f.id, driveAccountId: account.id,
                fallbackTime: parseExifDate(f.imageMediaMetadata?.time) || Date.parse(f.createdTime), fallbackSrc: 'drive'
              });
              if (r.status === 'added') summary.added++;
              else { summary.duplicate++; q.run('UPDATE photos SET drive_file_id = COALESCE(drive_file_id, ?), drive_account_id = COALESCE(drive_account_id, ?) WHERE id = ?', f.id, account.id, r.id); if (!q.get('SELECT 1 FROM photos WHERE drive_file_id = ?', f.id)) failed.add(f.id); }
            } catch (e) {
              summary.failed++; failed.add(f.id);
              console.error(`[drive] ${f.name} 處理失敗：`, e.message);
            } finally { await fs.rm(tmp, { force: true }); }
          }
        }
        q.run('UPDATE drive_accounts SET last_scan_at = ?, last_scan_note = ? WHERE id = ?', Date.now(),
          `新增 ${summary.added - before.added}、重複 ${summary.duplicate - before.duplicate}、失敗 ${summary.failed - before.failed}${summary.more ? '（還有，下一輪繼續）' : ''}`, account.id);
      } catch (e) {
        q.run('UPDATE drive_accounts SET last_scan_at = ?, last_scan_note = ? WHERE id = ?', Date.now(), `掃描失敗：${e.message}`.slice(0, 200), account.id);
        console.error(`[drive] ${account.email} 掃描失敗：`, e.message);
      }
      if (summary.more) break;
    }
  } finally {
    kv.set('drive.failed', [...failed].slice(-5000));
    scanning = false;
  }
  return summary;
}

// ---- 把 LINE 收到的原檔備份一份到第一個帳號的雲端硬碟（DRIVE_BACKUP=1 才會做）----
async function ensureFolder(account, name, parentId) {
  const key = `drive.folder.${account.id}.${parentId || 'root'}.${name}`;
  const cached = kv.get(key);
  if (cached) return cached;
  const res = await gfetch(account, '/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }) });
  const { id } = await res.json();
  kv.set(key, id);
  return id;
}
export async function backupToDrive(photoId) {
  if (!D.backupLineUploads || !driveConfigured()) return null;
  const account = q.get('SELECT * FROM drive_accounts ORDER BY id LIMIT 1');
  const p = q.get('SELECT id, ym, orig_path, drive_file_id FROM photos WHERE id = ?', photoId);
  if (!account || !p?.orig_path || p.drive_file_id) return null;
  const root = await ensureFolder(account, '家庭相簿小秘書（LINE 上傳）', null);
  const month = await ensureFolder(account, zhMonth(p.ym), root);
  const data = await fs.readFile(path.join(config.dataDir, p.orig_path));
  const boundary = 'album' + Date.now();
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: path.basename(p.orig_path), parents: [month] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const res = await gfetch(account, '/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--`)]) });
  const { id } = await res.json();
  q.run('UPDATE photos SET drive_file_id = ?, drive_account_id = ? WHERE id = ?', id, account.id, photoId);
  return id;
}
