# 員工訊息回覆 KPI — LINE bot 端

打卡系統「回覆KPI」頁籤的後端。這裡的檔案屬於 **`Jasonled-sketch/usled-linebot`**（Railway），
放在打卡 repo 只是為了一起交付，部署時要複製過去。

---

## 這套在算什麼

在 LINE 群組裡，管理者丟出一則「需要人回」的訊息 → 系統記成一個**錨點**，
接著看誰回了、幾分鐘回、回的當下是不是在自己的打卡時間內。每天 23:50 結算成一人一列的數字。

**什麼算「需要人回」**（四種，只有管理者發的才算）

| 種類 | 觸發方式 | 應回覆的人 |
|---|---|---|
| `announce` | 打卡 App「回覆KPI」頁按「📢 發公告」，bot 發出帶「✅ 收到」鈕的卡片 | 全體在職正職 |
| `mention` | 管理者在群裡 @ 某人 | 只有被 @ 到的人 |
| `keyword` | 訊息含「收到請回／請回覆／請回報／請確認／回覆一下／看到請回」，或以 `!` 開頭 | 全體在職正職 |
| `manual` | 管理者在群裡打 `!kpi 內容` | 全體在職正職 |

**什麼算「有回」**（三種，前兩種才是考核用的「明確回應」）

| 來源 | `via` | 可信度 |
|---|---|---|
| 按公告卡的「✅ 收到」鈕（送出 `收到 #代號`） | `button` | 明確 |
| 用 LINE 的引用回覆功能回那一則 | `quote` | 明確 |
| 錨點之後 120 分鐘內在群裡講話 | `window` | **推定**——可能只是剛好在聊別的 |

前端把「明確」和「總計」分兩欄顯示。**要拿來考核就看明確那欄。**

**上班 / 下班怎麼分**
用當事人**當天真實打卡區間**（Ragic `check-in-system/3` 的上班時間～下班時間）判定，
不是寫死 08:30–18:00。所以請假、加班、假日、還沒打卡，全部自然落在「下班後」。
未打完卡的開放班段視為「還在上班」。

---

## LINE API 做不到的事（先講清楚，別再花時間找）

- ❌ **已讀**：Messaging API 從來沒有開放過任何已讀資料。
- ❌ **按讚（訊息表情回應）**：官方 webhook 事件表裡**沒有** reaction 這種事件。
  群組收得到的只有 message / edit / unsend / join / leave / member join / member leave / postback。
  這就是為什麼「收到」要做成按鈕。
- ❌ **裝 bot 之前的歷史訊息**：webhook 只從裝上去那一刻開始。
- ⚠️ **電腦版 LINE**：官方註明 `source.userId` 只保證 iOS / Android 帶。
  用電腦版發言可能認不出是誰 → 那筆會記進 `msg_raw` 但 `email` 是空的，不列入任何人的成績。

**為什麼「收到」鈕是 message action 不是 postback**：
官方文件寫群組 source 的 `userId`「只在 message 事件帶」。postback 不保證有 userId，
記名就會漏。message action 一定產生 message 事件，userId 100% 拿得到。
（程式仍保留 postback 分支當備援，真的有帶 userId 也照收。）

---

## 部署步驟

### 1. 放檔案
```
lib/msgkpi.js      ← 本資料夾的 msgkpi.js
test/msgkpi.test.js ← 本資料夾的 msgkpi.test.js（選用，但建議一起放）
```

### 2. 改 `index.js`（四處，內容見 `index.js.patch`）

**① 檔案開頭**，接在 `const anthropic = ...` 之後：
```js
const msgkpi = require('./lib/msgkpi').init(pool, {
  punchRagicGet: (...a) => punchRagicGet(...a),
  attIsMgr: e => attIsMgr(e),
  attIsTestW: w => attIsTestW(w),
  get ATT_FID() { return ATT_FID; }
});
```
> ⚠️ 這裡**一定要**包成箭頭函式／getter。`attIsMgr`、`attIsTestW`、`ATT_FID` 都是檔案後段才宣告的
> `const`，直接寫變數名會踩到 TDZ，服務整個開不起來。

**② `/webhook/attendance` 的群組分支**，在 `continue;` 前面加一行：
```js
try { await msgkpi.handleGroupEvent(ev); } catch (e) { console.error('[msgkpi] 事件處理失敗:', e.message); }
continue;
```

**③ `/api/calc/roster-now` 那段之後**，掛上兩條路由：
```js
msgkpi.mountRoutes(app, req => CALC_KEY && req.get('X-Calc-Key') === CALC_KEY, express.json({ limit: '64kb' }));
```

**④ 每分鐘的 `cron.schedule('* * * * *', ...)` 裡面**，加兩行：
```js
if (hhmm === '23:50') { try { await msgkpi.rollup(3); } catch (e) { console.error('msgkpi.rollup:', e.message); } }
if (hhmm === '04:10') { try { await msgkpi.purge(); } catch (e) { console.error('msgkpi.purge:', e.message); } }
```

### 3. Cloudflare Worker（`punch-clock-proxy`）
放行兩條新路由，前端才連得到：
```
/calc/msg-kpi        (GET)
/calc/msg-announce   (POST)
```
Worker 若是用白名單列舉 `/calc/*` 路由就要加這兩條；若本來就是萬用轉發則不用動。

### 4. Railway 環境變數（都可不設，有預設值）

| 變數 | 預設 | 說明 |
|---|---|---|
| `MSGKPI_GROUP_ID` | 沿用 `PUNCH_REMIND_GROUP_ID` | 要統計哪個群。**只統計這一個群**，其他群完全不碰 |
| `MSGKPI_WINDOW_MIN` | `120` | 錨點後幾分鐘內的發言算「推定回應」 |
| `MSGKPI_SLA_ON_MIN` | `30` | 上班中應該幾分鐘內回 |
| `MSGKPI_SLA_OFF_MIN` | `720` | 下班後應該幾分鐘內回（12 小時） |
| `MSGKPI_KEEP_DAYS` | `180` | 原始群組發言保留幾天，過期自動清 |
| `MSGKPI_STORE_TEXT` | 開 | 設 `0` 就**不存訊息內容**，只記「誰在幾點講了一則」 |
| `MSGKPI_OFF` | — | 設 `1` 整組停用（不記錄、不開錨點），其他功能不受影響 |

資料表（`msg_anchor` / `msg_ack` / `msg_raw` / `msg_kpi_daily`）第一次跑會自動建，不用手動開。
**Ragic 不用新增任何表單。**

### 5. 上線後先測這一輪（5 分鐘）
1. 打卡 App →「回覆KPI」→「📢 發公告」隨便發一則。
2. 群組出現卡片 → 用**手機**按「✅ 收到」。
3. 回「回覆KPI」頁 → 那則應該從 `0/N` 變 `1/N`，你的名字從「未回」名單消失。
4. 若按了沒反應 → 看 Railway log 有沒有 `[msgkpi]` 開頭的錯誤。

---

## 測試

```bash
# 沒有 Postgres 也不會紅，會自動 skip
npm test

# 要真的驗算法，指一個測試用 Postgres
DATABASE_URL=postgres://... node --test test/msgkpi.test.js
```
11 個案例涵蓋：群組隔離、四種錨點判定、三種回應來源、上班/下班切分、
重複回應去重、每日結算數字、重跑結算不重複灌、API 彙總與未回名單。

---

## 已知取捨

- **「推定回應」偏寬鬆**：錨點開著的時候隨口講一句話，三則錨點會一起被記成已回。
  這是刻意的（總比漏記好），所以才把 `acked_hard` / `acked_soft` 分開存。
  想要嚴格一點就把 `MSGKPI_WINDOW_MIN` 調小，或考核只看明確回應率。
- **錨點算在發出當天**：晚回的（例如下班後隔天早上才回）會回頭補記到錨點那天，
  所以 `rollup(3)` 每晚重算最近三天，不是只算今天。
- **隱私**：預設會存群組訊息前 300 字（錨點 500 字）供查核。不想存就設 `MSGKPI_STORE_TEXT=0`，
  統計照常，只是頁面上看不到訊息內容。
- **勞基法**：目前設定「下班後回覆」**有**計入 KPI 分數（Jason 2026/08/26 決定）。
  台灣實務上，把下班後回訊息列入考核可能被主張為工時／加班，
  建議搭配加班費或責任制加給。若要改成不計分，前端把 `acked_off` 從分母拿掉即可，
  資料本身照樣分開存著。
