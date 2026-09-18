// Ragic 讀寫層（server-side）
//
// 照 skill `ragic-api` 的地雷清單走：
//   · POST 一定要帶 ?api，沒帶會 302 而且不寫入
//   · server-side 用 Authorization: Basic <APIKey>（不是 URL APIKey）
//   · 日期送 YYYY/MM/DD，ISO 8601 寫不進去
//   · 數值欄位送純數字字串，不能帶單位
//   · POST 只認欄位 ID，送中文名會靜默失敗
//   · GET 帶 naming=fid，回應才會用欄位 ID
//   · 單次 GET 上限 1000 筆，要分頁
//   · 429 是 IP 限流，要退避重試

const DEFAULT_BASE = 'https://ap10.ragic.com/Fan28';

function requireEnv(env, name) {
  const v = env[name];
  if (!v) throw new Error(`缺少環境變數 ${name}`);
  return v;
}

async function ragicFetch(url, init, attempt) {
  const tries = attempt || 0;
  const res = await fetch(url, init);

  // 429 = Ragic IP 限流。退避重試，最多 3 次。
  if (res.status === 429 && tries < 3) {
    const waitMs = 1000 * 2 ** tries;
    await new Promise((r) => setTimeout(r, waitMs));
    return ragicFetch(url, init, tries + 1);
  }
  return res;
}

/** Ragic 日期格式。ISO 8601 會被拒收。 */
function ragicDate(ms, tzOffsetHours) {
  const off = tzOffsetHours === undefined ? 8 : tzOffsetHours;
  const d = new Date(ms + off * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

/** 日期＋時間，給「到達時間 / 離開時間」這種欄位用。 */
function ragicDateTime(ms, tzOffsetHours) {
  const off = tzOffsetHours === undefined ? 8 : tzOffsetHours;
  const d = new Date(ms + off * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ragicDate(ms, off)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

class RagicClient {
  /**
   * @param {object} env 環境變數
   *   RAGIC_API_KEY          必填
   *   RAGIC_BASE             選填，預設 https://ap10.ragic.com/Fan28
   *   RAGIC_VISIT_SHEET      拜訪記錄表路徑，例如 ragicproject-management/21
   *   RAGIC_VISIT_FIELDS     JSON，邏輯名 → 欄位 ID
   *   RAGIC_CUSTOMER_SHEET   預設 ragicsales-order-management/20004
   *   RAGIC_CUSTOMER_FIELDS  JSON，需含 name / lat / lng 的欄位 ID
   */
  constructor(env) {
    this.env = env;
    this.apiKey = requireEnv(env, 'RAGIC_API_KEY');
    this.base = (env.RAGIC_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    this.tz = env.AZLIOT_TZ_OFFSET === undefined ? 8 : Number(env.AZLIOT_TZ_OFFSET);
    this.customerCache = { at: 0, rows: [] };
    this.customerTtlMs = Number(env.RAGIC_CUSTOMER_TTL_MS || 10 * 60 * 1000);
  }

  headers() {
    return { Authorization: `Basic ${this.apiKey}` };
  }

  parseFieldMap(varName, required) {
    const raw = this.env[varName];
    if (!raw) throw new Error(`缺少環境變數 ${varName}（欄位 ID 對應表 JSON）`);
    let map;
    try {
      map = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error(`${varName} 不是合法 JSON: ${e.message}`);
    }
    for (const key of required || []) {
      if (!map[key]) throw new Error(`${varName} 缺少 "${key}" 的欄位 ID`);
    }
    return map;
  }

  /**
   * 讀客戶主檔，轉成 { id, name, lat, lng }。
   * 沒有座標的客戶直接略過——比對時用不到，留著只會拖慢每筆的距離計算。
   */
  async fetchCustomers(force) {
    const now = Date.now();
    if (!force && this.customerCache.rows.length && now - this.customerCache.at < this.customerTtlMs) {
      return this.customerCache.rows;
    }

    const sheet = this.env.RAGIC_CUSTOMER_SHEET || 'ragicsales-order-management/20004';
    const f = this.parseFieldMap('RAGIC_CUSTOMER_FIELDS', ['name', 'lat', 'lng']);

    const rows = [];
    const pageSize = 1000; // Ragic 單次 GET 上限
    for (let offset = 0; ; offset += pageSize) {
      const url = `${this.base}/${sheet}?api&naming=fid&limit=${pageSize}&offset=${offset}`;
      const res = await ragicFetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`讀客戶主檔失敗 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const entries = Object.entries(body || {}).filter(([k]) => /^\d+$/.test(k));
      if (!entries.length) break;

      for (const [recordId, rec] of entries) {
        const lat = Number(rec[f.lat]);
        const lng = Number(rec[f.lng]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
        rows.push({
          id: f.code && rec[f.code] ? String(rec[f.code]) : String(recordId),
          ragicId: String(recordId),
          name: String(rec[f.name] || '').trim() || `(未命名 ${recordId})`,
          lat,
          lng,
        });
      }
      if (entries.length < pageSize) break;
    }

    // 只有真的讀到東西才更新快取。0 筆不覆蓋舊資料，避免快取毒化
    // （skill ragic-api 地雷：0 筆/失敗結果別寫快取）。
    if (rows.length) {
      this.customerCache = { at: now, rows };
    }
    return rows.length ? rows : this.customerCache.rows;
  }

  /** 送一筆記錄到指定表。values 是「欄位 ID → 值」。 */
  async createRecord(sheetPath, values) {
    const form = new URLSearchParams();
    for (const [fid, val] of Object.entries(values)) {
      if (val === null || val === undefined || val === '') continue;
      form.append(String(fid), String(val));
    }

    const url = `${this.base}/${sheetPath}?api`;
    const res = await ragicFetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, this.headers()),
      body: form.toString(),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Ragic 寫入失敗 HTTP ${res.status}: ${text.slice(0, 300)}`);

    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* Ragic 偶爾回非 JSON */ }
    if (json && json.status && json.status !== 'SUCCESS') {
      throw new Error(`Ragic 回報失敗: ${text.slice(0, 300)}`);
    }
    return json || { status: 'SUCCESS', raw: text.slice(0, 300) };
  }

  /** 寫一筆車輛拜訪記錄。 */
  async writeVisit(visit) {
    const sheet = requireEnv(this.env, 'RAGIC_VISIT_SHEET');
    const f = this.parseFieldMap('RAGIC_VISIT_FIELDS', ['date', 'plateNum', 'arrivedAt']);

    const values = {};
    const put = (key, val) => { if (f[key]) values[f[key]] = val; };

    put('date', ragicDate(visit.arrivedAt, this.tz));
    put('imei', visit.imei);
    put('plateNum', visit.plateNum);
    put('driver', visit.driver);
    put('customer', visit.customerName);
    put('customerCode', visit.customerId);
    put('arrivedAt', ragicDateTime(visit.arrivedAt, this.tz));
    put('departedAt', visit.departedAt ? ragicDateTime(visit.departedAt, this.tz) : null);
    // 數值欄位送純數字，不能帶「分鐘」「公尺」這種單位
    put('durationMinutes', visit.durationMinutes == null ? null : String(Math.round(visit.durationMinutes)));
    put('distanceMeters', visit.customerDistanceMeters == null ? null : String(visit.customerDistanceMeters));
    put('lat', visit.lat == null ? null : String(visit.lat));
    put('lng', visit.lng == null ? null : String(visit.lng));
    put('mapUrl', visit.lat == null ? null : `https://www.google.com/maps?q=${visit.lat},${visit.lng}`);
    put('summary', visit.summary);
    put('category', visit.category);
    put('source', visit.reason);

    return this.createRecord(sheet, values);
  }

  /** 寫一筆工牌上下班打卡。沒設定表就跳過，不當成錯誤。 */
  async writeBadgePunch(punch) {
    const sheet = this.env.RAGIC_PUNCH_SHEET;
    if (!sheet) return { skipped: 'RAGIC_PUNCH_SHEET 未設定' };
    const f = this.parseFieldMap('RAGIC_PUNCH_FIELDS', ['date', 'name', 'at']);

    const values = {};
    const put = (key, val) => { if (f[key]) values[f[key]] = val; };
    put('date', ragicDate(punch.at, this.tz));
    put('name', punch.badgeName);
    put('imei', punch.imei);
    put('direction', punch.direction === 'in' ? '上班' : punch.direction === 'out' ? '下班' : '未知');
    put('at', ragicDateTime(punch.at, this.tz));
    put('lat', punch.lat == null ? null : String(punch.lat));
    put('lng', punch.lng == null ? null : String(punch.lng));
    put('place', punch.nearCustomer ? punch.nearCustomer.name : null);
    put('mileageMeters', punch.mileageMeters == null ? null : String(punch.mileageMeters));

    return this.createRecord(sheet, values);
  }
}

module.exports = { RagicClient, ragicDate, ragicDateTime };
