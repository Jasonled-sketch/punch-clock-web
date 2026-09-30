# 交接包：車輛 GPS → AI → Ragic 拜訪記錄

給接手執行的人或 Claude Code。從這份文件可以獨立把整套跑起來。

---

## ⛔ 金鑰規則（先讀這段）

這個專案會用到四把金鑰。**四把都只能存在環境變數或部署平台的 Secret 設定裡。**

| 金鑰 | 用途 |
|---|---|
| `RAGIC_API_KEY` | 讀客戶主檔、寫拜訪記錄 |
| `ANTHROPIC_API_KEY` | 產生拜訪摘要 |
| `TRACCAR_INGEST_TOKEN` | 自己設的共享密碼，擋偽造的位置資料 |
| `AZLIOT_TF_KEY` | 走安智連路線才需要 |

**禁止事項**

- 不要把金鑰寫進任何檔案後 commit
- 不要把金鑰放進網址列（會留在瀏覽器歷史，瀏覽器同步的話還會上雲）
- 不要在對話、issue、PR、log 裡貼出金鑰
- 不要 `echo $RAGIC_API_KEY` 或用任何方式把它印到終端機

**執行工具時的正確寫法**：金鑰用環境變數傳入，工具只會印出欄位編號，不會印金鑰。

```bash
RAGIC_API_KEY=xxx node tools/probe-fields.js check-in-system/15 visit
```

如果金鑰曾經外流過（貼到聊天、進過網址列、進過 commit），
去 Ragic 後台重新產生一把新的，舊的作廢。

---

## 一、現況

**Repo**：`Jasonled-sketch/punch-clock-web`
**分支**：`claude/car-gps-ragic-integration-a6oyz2`
**程式位置**：`gps/`

已完成並測試過（82 項測試，不連外網）：

| 模組 | 功能 |
|---|---|
| `src/lpush.js` | 安智連 LPush 六種封包解析與 md5 驗簽 |
| `src/traccar.js` | Traccar 轉發轉接，含節→公里換算 |
| `src/visit-engine.js` | 到點、離開、短停丟棄、離線收尾、稀疏資料補救 |
| `src/geo.js` | 距離計算與客戶比對 |
| `src/ragic.js` | 客戶主檔讀取、拜訪記錄寫入 |
| `src/ai.js` | Claude 摘要與性質分類，失敗退回規則式句子 |
| `src/handler.js` | 主流程，先回 200 再背景寫入 |
| `src/server.js` | Railway 入口（獨立服務或掛進既有 Express） |
| `src/worker.js` | Cloudflare Worker 入口 |
| `tools/probe-fields.js` | 自動抓 Ragic 欄位 ID |
| `tools/simulate.js` | 模擬一趟完整拜訪，裝機前驗證用 |

**已知狀態**

- Ragic 拜訪紀錄表已建好，路徑 `check-in-system/15`（欄位 ID 1003426～1003441；到達/離開時間格式到分鐘 → `RAGIC_DATETIME_SECONDS=0`）
- **2026-09-29 已部署（Railway 專案 luminous-compassion）**
  - 接收服務 `usled-gps`：https://usled-gps-production.up.railway.app（金鑰用 Railway 引用變數接 usled-linebot，Postgres 共用）
  - Traccar 6.16 `usled-traccar`：管理頁 https://usled-traccar-production.up.railway.app ，定位器連 **switchback.proxy.rlwy.net:16981**，Volume 掛 /opt/traccar/data，設定全走 `CONFIG_USE_ENVIRONMENT_VARIABLES`
  - 客戶比對暫不做（Jason 決定不補經緯度），`RAGIC_CUSTOMER_FIELDS` 未設
  - 已用 `tools/gt06-sim.js` 假 GT06 從 TCP 埠驗證整條線到 Ragic，時間無 8 小時差
- 硬體：Jason 已決定買淘寶「源富信通 4G定位器GT06」（G900L 系列）；Jason 版開箱工單 = Artifact https://claude.ai/artifact/FhKfxe1PtNRb3FucdKFPx8

---

## 二、待辦步驟

### 步驟 1：確認程式沒壞

```bash
cd gps
npm install
npm test
```

預期輸出最後一行：`全部通過 82 項`。不是 82 就先停下來看哪裡壞了。

---

### 步驟 2：抓 Ragic 欄位 ID

前提：拜訪紀錄表裡還留著那筆 `PROBE...` 開頭的探測記錄。
沒有的話先把 `ragic/車輛拜訪記錄-匯入用.csv` 的第二列手動新增一筆。

```bash
RAGIC_API_KEY=<從你的密碼管理工具取得> node tools/probe-fields.js check-in-system/15 visit
```

輸出最後一行會是 `RAGIC_VISIT_FIELDS={...}`，記下來，等一下設進環境變數。

**同時要確認一件事**：拜訪紀錄表的「到達時間」「離開時間」兩個欄位，
在 Ragic 的格式設定是到分還是到秒。

- 到秒（`yyyy/MM/dd HH:mm:ss`）→ 不用做任何事
- 到分（`yyyy/MM/dd HH:mm`）→ 環境變數要加 `RAGIC_DATETIME_SECONDS=0`

格式不符的話那兩欄會寫不進去，而且 Ragic 不會報錯，記錄會建立但那兩格空白。

接著抓客戶主檔的欄位 ID：

```bash
RAGIC_API_KEY=<...> node tools/probe-fields.js ragicsales-order-management/20004 customer
```

客戶主檔要先有「緯度」「經度」兩個欄位並填好值，否則比對不到任何客戶。

---

### 步驟 3：確認 Ragic 權限

用來產生 `RAGIC_API_KEY` 的那個帳號，必須在拜訪紀錄表有**讀寫權限**。
沒有的話寫入會被擋掉，而且訊息不明顯。

到 Ragic 的表單設定 → 存取權限，確認該帳號所屬群組不是「無權限」。

---

### 步驟 4：部署接收服務

兩種擇一。

**選項 A：Railway 獨立服務**

```bash
cd gps
# 部署方式依你們的 Railway 慣例
npm start   # 本機測試用，預設聽 PORT 或 3000
```

**選項 B：掛進既有的 Railway LINE bot（usled-linebot）**

```js
const { mountExpress } = require('./gps/src/server');
mountExpress(app, process.env);
```

> ⚠ 不要在這條路由前面套 `express.json()`。驗簽需要原始 body 字串，
> parse 再 stringify 回去可能差一個位元組。`mountExpress` 內建了 raw body 中介層。

**環境變數**（放進 Railway 的 Variables，不要寫進檔案）

```
RAGIC_API_KEY=...
RAGIC_VISIT_SHEET=check-in-system/15
RAGIC_VISIT_FIELDS={步驟 2 抓到的}
RAGIC_CUSTOMER_SHEET=ragicsales-order-management/20004
RAGIC_CUSTOMER_FIELDS={步驟 2 抓到的}
RAGIC_DATETIME_SECONDS=0          # 只有欄位格式到分鐘時才加
TRACCAR_INGEST_TOKEN=<openssl rand -hex 24 產生>
ANTHROPIC_API_KEY=...
GPS_DRIVER_MAP={"IMEI":"駕駛姓名"}
DATABASE_URL=...                   # 有 Postgres 就設，重啟才不會掉拜訪狀態
```

用 Postgres 的話先建表：

```sql
CREATE TABLE IF NOT EXISTS gps_device_state (
  imei TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 步驟 5：先用模擬器驗證（硬體還沒到就能做）

```bash
TRACCAR_INGEST_TOKEN=<跟服務同一組> SIM_MODE=traccar \
  node tools/simulate.js https://你的服務網址/traccar/position
```

會模擬出發、抵達、停 35 分鐘、離開。跑完去 Ragic 看有沒有長出一筆約 35 分鐘的記錄。

**這一步過了才值得買硬體。**

---

### 步驟 6：部署 Traccar

見 `traccar/README.md`。重點：

- `traccar/traccar.xml` 只要改 `forward.url` 和 `forward.header` 兩個地方
- `forward.type` 必須是 `json`，預設的 `url` 我們讀不到
- Railway 上要掛 Volume 到 `/opt/traccar/data`，否則重新部署會清空所有裝置
- Railway 的 TCP Proxy 對外埠是它分配的號碼，不是容器內的 5023

---

### 步驟 7：買硬體並設定

採購準則見 `BUYING.md`。買到 G900L 系列的話，指令清單見 `traccar/device-G900L.md`。

**開箱後照順序發簡訊**（`TIMER` 那條一定要改）：

```
APN,internet,,#
SERVER,1,<Traccar 位址>,<Traccar 埠>,0#
TIMER,30,300#
HBT,180,180#
SUPPRESS,1#
ANGLE,1#
```

**絕對不要改** `SZCS#GT06GPRSGMT`，保持預設 0。改成 1 會讓所有記錄時間差 8 小時。

---

## 三、驗證清單

依序確認，每一項過了再做下一項：

1. `npm test` 輸出 82 項全過
2. `curl https://你的服務/healthz` 回 `{"ok":true,...}`
3. 模擬器跑完，Ragic 長出一筆約 35 分鐘的記錄
4. 記錄裡「客戶」欄位有值（代表客戶主檔座標比對成功）
5. 記錄裡「到達時間」「離開時間」不是空白（代表日期格式正確）
6. 定位器在 Traccar 後台看得到
7. 實車跑一趟，Ragic 出現真實記錄

---

## 四、卡住時看哪裡

| 症狀 | 先查 |
|---|---|
| 服務沒收到任何東西 | Traccar 的 `forward.type` 是不是 `json`；`forward.url` 對不對 |
| log 寫「X-Ingest-Token 不符」 | Traccar 和服務的 token 不一致 |
| log 寫「封包被拒」 | 安智連路線的 md5 驗簽失敗，檢查 `AZLIOT_TF_KEY` |
| 有寫入但 Ragic 沒資料 | 欄位 ID 錯了，重跑步驟 2 |
| 記錄有但某欄空白 | 該欄位 ID 對到別處，或型別不符（數值欄位不能帶單位）|
| 到達/離開時間空白 | 日期格式不符，加 `RAGIC_DATETIME_SECONDS=0` |
| 客戶永遠是空的 | 客戶主檔沒有經緯度，或 `RAGIC_CUSTOMER_FIELDS` 沒設對 |
| 記錄時間差 8 小時 | 定位器的 `GT06GPRSGMT` 被改成 1 了，改回 0 |
| 一堆很短或很奇怪的記錄 | 基站定位被誤用。確認 `gType`/`valid` 判斷還在，沒被改掉 |
| 拜訪時長都是估的 | 定位器 `TIMER` 第二個參數太大，改成 300 |
| 完全沒反應 | Ragic 服務帳戶沒有那張表的權限 |

---

## 五、其他文件

| 檔案 | 內容 |
|---|---|
| `README.md` | 架構、兩條路線比較、環境變數完整清單、踩過的坑 |
| `ragic-setup.md` | 三張表的欄位清單、建表、抓欄位 ID |
| `BUYING.md` | 定位器採購管道、型號、問賣家的稿、驗收流程 |
| `traccar/README.md` | Traccar 部署與設定 |
| `traccar/device-G900L.md` | G900L 系列完整指令清單 |

---

## 六、刻意沒做的事

- **遠端斷油電**。安智連和 G900L 都有這個功能，程式沒接也不建議接。
  行駛中誤觸會造成事故，而且一個被打進來的端點就能讓車隊全部熄火。
- **用平台的圍欄功能**。自己算距離，客戶主檔改了立刻生效，狀態不會散在兩邊。
