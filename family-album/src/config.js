// 所有設定都從環境變數來。機密（Token/Secret/API Key）只放在 Railway → Variables，不寫進程式或文件。
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || './data');

export const config = {
  port: Number(env.PORT || 3000),
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'album.db'),
  libraryDir: path.join(DATA_DIR, 'library'),   // LINE 上傳的原檔
  displayDir: path.join(DATA_DIR, 'display'),   // 瀏覽/做影片用的中尺寸
  thumbDir: path.join(DATA_DIR, 'thumbs'),      // 縮圖
  faceDir: path.join(DATA_DIR, 'faces'),        // 人臉小圖（認人頁用）
  recapDir: path.join(DATA_DIR, 'recaps'),      // 回顧影片
  musicDir: path.resolve(env.MUSIC_DIR || path.join(DATA_DIR, 'music')), // 放 mp3 就會自動配樂

  // 對外網址（LINE 要抓圖片/影片、相簿連結都靠它），例：https://xxx.up.railway.app
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  // 相簿網頁的通行碼；沒設就每次啟動隨機產生（等於鎖起來，只能從 log 看）
  albumToken: env.ALBUM_TOKEN || crypto.randomBytes(12).toString('hex'),
  albumTokenFromEnv: Boolean(env.ALBUM_TOKEN),
  timezone: env.TZ_NAME || 'Asia/Taipei',

  line: {
    token: env.LINE_TOKEN || '',
    secret: env.LINE_SECRET || '',
    apiBase: (env.LINE_API_BASE || 'https://api.line.me').replace(/\/$/, ''),
    dataBase: (env.LINE_DATA_BASE || 'https://api-data.line.me').replace(/\/$/, ''),
    familyGroupId: env.FAMILY_GROUP_ID || '',  // 月度回顧要推到哪個群組（群組推播＝1 則）
    // 只收這些群組/使用者的照片（逗號分隔）。留空＝第一個把 bot 拉進去的群組會被記住。
    allowed: (env.LINE_ALLOWED_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean),
    ackQuietMs: Number(env.ACK_QUIET_MS || 8000),      // 一批照片傳完後安靜幾秒才回「收到 N 張」
    ackDeadlineMs: Number(env.ACK_DEADLINE_MS || 45000) // replyToken 快過期前一定要回
  },

  ai: {
    enabled: env.AI_VISION !== '0' && Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model: env.ALBUM_AI_MODEL || 'claude-opus-5-5',
    effort: env.ALBUM_AI_EFFORT || 'low'
  },

  faces: {
    enabled: env.FACES !== '0',
    matchThreshold: Number(env.FACE_MATCH_THRESHOLD || 0.42),     // 越小越嚴格（小孩彼此長得像，預設抓嚴一點）
    clusterThreshold: Number(env.FACE_CLUSTER_THRESHOLD || 0.42),
    minConfidence: Number(env.FACE_MIN_CONFIDENCE || 0.5),
    minSize: Number(env.FACE_MIN_SIZE || 48)                      // 太小的臉不比對（背景路人）
  },

  drive: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    apiBase: (env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, ''),
    tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    scanIntervalMin: Number(env.DRIVE_SCAN_INTERVAL_MIN || 60),
    maxPerScan: Number(env.DRIVE_MAX_PER_SCAN || 200),
    backupLineUploads: env.DRIVE_BACKUP === '1' // LINE 收到的原檔備份一份到雲端硬碟
  },

  media: {
    displaySize: Number(env.DISPLAY_SIZE || 1280),
    thumbSize: Number(env.THUMB_SIZE || 400)
  },

  recap: {
    maxPhotos: Number(env.RECAP_MAX_PHOTOS || 36),
    secondsPerPhoto: Number(env.RECAP_SECONDS_PER_PHOTO || 3),
    width: Number(env.RECAP_WIDTH || 1280),
    height: Number(env.RECAP_HEIGHT || 720),
    font: env.RECAP_FONT || 'Noto Sans CJK TC, WenQuanYi Zen Hei, PingFang TC, sans-serif',
    monthlyAt: env.RECAP_MONTHLY_AT || '1 20:00' // 每月幾號幾點自動做上個月回顧
  }
};

// 給 LINE 抓圖用的簽章（LINE 伺服器不會帶 cookie）
const signKey = crypto.createHash('sha256').update('media:' + config.albumToken + ':' + config.line.secret).digest();
export function signMedia(kind, id) {
  return crypto.createHmac('sha256', signKey).update(`${kind}:${id}`).digest('hex').slice(0, 24);
}
export function mediaUrl(kind, id) {
  return `${config.baseUrl}/m/${kind}/${id}?s=${signMedia(kind, id)}`;
}
export function albumUrl(hash = '') {
  return `${config.baseUrl}/?t=${config.albumToken}${hash ? '#' + hash : ''}`;
}
