// 裝置狀態儲存。
//
// 記憶體版夠用在單一實例。多實例或會重啟的環境要用 Postgres 版，
// 否則重啟時「進行中的拜訪」會整個消失，那趟就永遠不會結案。

class MemoryStore {
  constructor() {
    this.states = new Map();
    this.alarms = new Map();   // imei → [{alarmType, at}]
    this.seenTokens = new Map(); // token → at（去重用）
  }

  async get(imei) { return this.states.get(imei) || null; }
  async put(imei, state) { this.states.set(imei, state); }
  async all() { return Array.from(this.states.values()); }

  async recordAlarm(imei, alarmType, at) {
    const list = this.alarms.get(imei) || [];
    list.push({ alarmType, at });
    // 只留最近 50 筆，這是給 AI 當上下文用的，不是稽核用的
    this.alarms.set(imei, list.slice(-50));
  }

  async recentAlarms(imei, sinceMs) {
    return (this.alarms.get(imei) || []).filter((a) => a.at >= sinceMs).map((a) => a.alarmType);
  }

  /** 回傳 true 代表這個 token 之前看過（重送）。 */
  async seen(token) {
    if (!token) return false;
    const now = Date.now();
    if (this.seenTokens.has(token)) return true;
    this.seenTokens.set(token, now);
    if (this.seenTokens.size > 5000) {
      const cutoff = now - 10 * 60 * 1000;
      for (const [k, t] of this.seenTokens) {
        if (t < cutoff) this.seenTokens.delete(k);
      }
    }
    return false;
  }
}

/**
 * Postgres 版。用既有的 DATABASE_URL（Railway 上的 LINE bot 已經有一個）。
 * 建表語句見 README。
 */
class PostgresStore {
  constructor(connectionString) {
    // eslint-disable-next-line global-require, import/no-unresolved
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString, max: 4 });
    this.memory = new MemoryStore(); // 去重與告警上下文留在記憶體就好
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gps_device_state (
        imei TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async get(imei) {
    const { rows } = await this.pool.query('SELECT state FROM gps_device_state WHERE imei = $1', [imei]);
    return rows.length ? rows[0].state : null;
  }

  async put(imei, state) {
    await this.pool.query(
      `INSERT INTO gps_device_state (imei, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (imei) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [imei, JSON.stringify(state)],
    );
  }

  async all() {
    const { rows } = await this.pool.query('SELECT state FROM gps_device_state');
    return rows.map((r) => r.state);
  }

  async recordAlarm(imei, alarmType, at) { return this.memory.recordAlarm(imei, alarmType, at); }
  async recentAlarms(imei, sinceMs) { return this.memory.recentAlarms(imei, sinceMs); }
  async seen(token) { return this.memory.seen(token); }
}

function createStore(env) {
  if (env.GPS_STORE === 'postgres' || (env.DATABASE_URL && env.GPS_STORE !== 'memory')) {
    return new PostgresStore(env.DATABASE_URL);
  }
  return new MemoryStore();
}

module.exports = { MemoryStore, PostgresStore, createStore };
