# 車輛 GPS → AI → Ragic 拜訪記錄

定位器把位置推進來，服務判斷「車子到了哪個客戶、停多久」，交給 Claude 寫成一句話，再寫進 Ragic。

```
定位器 → （安智連平台 或 自架 Traccar）→ 本服務 → Claude 摘要 → Ragic
```

## 兩條路，選一條

判斷、Ragic 寫入、AI 摘要三層完全共用。**只有最前面「資料怎麼進來」那一層不同**，兩種都寫好了。

| | A：安智連 LPush | B：Traccar 自架 |
|---|---|---|
| 硬體 | 淘寶安智連定位器 | 蝦皮 GT06 相容機（Seeworld 等） |
| 前置費用 | 對接費 2000 人民幣（約 NT$9,600，一次性，超過 100 台免費） | 無 |
| 要顧的伺服器 | 只有本服務 | 本服務 ＋ 一台 Traccar |
| 設定方式 | 把網址給安智連管理員 | 簡訊指令把定位器指到自己的 Traccar |
| 依賴 | 安智連平台要活著 | 沒有第三方 |
| 程式入口 | `src/lpush.js` → `POST /azliot/lpush` | `src/traccar.js` → `POST /traccar/position` |

**怎麼選**：車少（十台以內）又不想付對接費就走 B；懶得多維護一台伺服器、或車隊會超過百台就走 A。
兩條路隨時能換，換的只是設定，記錄格式一模一樣。

---

---

## 路線 A：先跟安智連談的事

開發前先問客服這四題，答案會決定值不值得做：

1. **對接費用多少？** 文件只寫「請諮詢客服」。只有一台設備時怎麼算？
2. **LPush 位置推送和 API 查詢是分開收費還是一起？** 這個服務只需要 LPush。
3. **推送網址是我自己在後台設定，還是要你們幫我開？** 文件寫的是「聯繫管理員提供接口地址」，也就是要給他們。
4. **tfKey 在哪裡拿？** 個人中心。拿到後當密碼保管，不要貼到任何聊天視窗。

文件上的對接流程共六步：註冊帳號 → 設備綁定 → 開發接收接口 → 把網址給安智連管理員開通。

---

## 共同準備（兩條路都要）

| 項目 | 說明 |
|---|---|
| 一個對外的 HTTPS 網址 | Railway 服務或 Cloudflare Worker 都行 |
| `tfKey` | 安智連個人中心取得，驗簽用 |
| Ragic「車輛拜訪記錄」表 | 新開一張，欄位見下 |
| Ragic 客戶主檔加經緯度欄位 | 沒有座標就無法比對客戶 |
| Anthropic API key | 生摘要用，不給也能跑（退回規則式句子） |

### Ragic 拜訪記錄表欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| 日期 | 日期 | |
| 車牌 | 文字 | |
| 設備 IMEI | 文字 | |
| 駕駛 | 文字 | 由 `GPS_DRIVER_MAP` 帶入 |
| 客戶 | 文字 | 比對不到時留空 |
| 到達時間 / 離開時間 | 文字 | 存 `YYYY/MM/DD HH:mm:ss` |
| 停留分鐘 | 數值 | |
| 距客戶公尺 | 數值 | 用來判斷比對品質 |
| 緯度 / 經度 | 文字 | |
| 地圖連結 | 文字 | 自動生成 Google Maps 連結 |
| AI 摘要 | 文字 | |
| 性質 | 文字 | 拜訪／送貨／施工／取件／用餐休息／返回公司／不明 |
| 來源 | 文字 | `moved_away` 正常離開，`offline_timeout` 離線逾時結案 |

建好表之後要拿到**欄位 ID**（不是中文名，Ragic POST 只認 ID），填進 `RAGIC_VISIT_FIELDS`。

### 客戶主檔要補座標

客戶主檔（`ragicsales-order-management/20004`）目前只有地址。加兩個欄位「緯度」「經度」，
用 Google Geocoding 把地址跑一次轉成座標。沒座標的客戶會被略過，不影響其他人。

---

## 路線 B：Traccar 怎麼設

四步，設定檔都寫好了：

1. **買機器** → 看 [`BUYING.md`](BUYING.md)，含型號推薦和貼給賣家的問答稿
2. **架 Traccar** → 看 [`traccar/README.md`](traccar/README.md)，`docker compose up -d` 就起來
3. **把定位器指過來** → 發簡訊改伺服器位址，指令格式向賣家索取
4. **設定轉發** → [`traccar/traccar.xml`](traccar/traccar.xml) 已經寫好，只要改網址和密碼兩個地方

車牌不用另外設定：Traccar 後台把裝置名稱（Device name）填成車牌，本服務會直接拿來用。

---

## 環境變數

```bash
# 安智連
AZLIOT_TF_KEY=個人中心拿到的 key        # 必填，驗簽用
AZLIOT_PUSH_PATH=/azliot/lpush          # 選填，推送路徑
AZLIOT_TZ_OFFSET=8                      # 選填，平台時間的時區。中國和台灣都是 8

# Traccar（路線 B 才要）
TRACCAR_INGEST_TOKEN=自己設一組長密碼      # 必填，否則拒收
TRACCAR_PUSH_PATH=/traccar/position
TRACCAR_SPEED_UNIT=kn                     # Traccar 預設送「節」。改過 conf 才填 kmh

# Ragic
RAGIC_API_KEY=...                       # 必填
RAGIC_BASE=https://ap10.ragic.com/Fan28
RAGIC_VISIT_SHEET=ragicproject-management/21
RAGIC_VISIT_FIELDS={"date":"1001234","plateNum":"1001235","arrivedAt":"1001236", ...}
RAGIC_CUSTOMER_SHEET=ragicsales-order-management/20004
RAGIC_CUSTOMER_FIELDS={"name":"1002001","lat":"1002050","lng":"1002051"}

# 工牌打卡（選用，沒設就跳過）
RAGIC_PUNCH_SHEET=...
RAGIC_PUNCH_FIELDS={"date":"...","name":"...","at":"..."}

# AI
ANTHROPIC_API_KEY=sk-ant-...            # 不給就用規則式句子
GPS_AI_DISABLED=0                       # 設 1 完全關掉 AI

# 判斷門檻（都有預設值，先別動，跑一週看實際資料再調）
GPS_MATCH_RADIUS_M=200                  # 距客戶多近算到達
GPS_LEAVE_RADIUS_M=350                  # 離開多遠算走了（必須大於上面那個）
GPS_DWELL_MIN=3                         # 引擎開著時要靜止幾分鐘才算到點
GPS_DWELL_MIN_ACC_OFF=1                 # 熄火時縮短到幾分鐘
GPS_MIN_VISIT_MIN=5                     # 短於幾分鐘不成案
GPS_OFFLINE_CLOSE_MIN=45                # 離線幾分鐘就把拜訪收尾

# 其他
GPS_DRIVER_MAP={"868120214425578":"王小明"}
DATABASE_URL=postgres://...             # 有設就用 Postgres 存狀態（建議）
```

---

## 跑起來

```bash
cd gps
npm install
npm test                 # 54 項測試，不連外網

AZLIOT_TF_KEY=xxx RAGIC_API_KEY=yyy npm start
```

掛進既有的 Express 專案（例如 Railway 上的 LINE bot）：

```js
const { mountExpress } = require('./gps/src/server');
mountExpress(app, process.env);
```

> 掛進 Express 時**不要**先套 `express.json()` 到這條路由。驗簽要的是原始 body 字串，
> parse 再 stringify 回去可能差一個位元組，md5 就全錯。`mountExpress` 內建了 raw body 中介層。

用 Postgres 存狀態的話先建表：

```sql
CREATE TABLE IF NOT EXISTS gps_device_state (
  imei TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 裝機前先模擬

定位器還沒到就能把整條路測通：

```bash
# 路線 A
AZLIOT_TF_KEY=xxx node tools/simulate.js https://你的網址/azliot/lpush

# 路線 B
SIM_MODE=traccar TRACCAR_INGEST_TOKEN=xxx node tools/simulate.js https://你的網址/traccar/position
```

會模擬出發、抵達、停 35 分鐘、離開，跑完去 Ragic 看有沒有長出一筆記錄。
這一步過了，裝機當天就只剩把網址給安智連。

---

## 路線 A：六種封包的處理方式

| LPushType | 內容 | 這個服務怎麼處理 |
|---|---|---|
| 1 | 心跳包（停止 3 分／休眠 5 分） | 更新 ACC 狀態，不產生記錄 |
| 2 | 定位包（行駛中 10-20 秒） | 主力。判斷到點和離開 |
| 3 | OBD 資料 | 目前忽略 |
| 4 | 告警 | 記錄下來當 AI 的上下文，不寫拜訪表 |
| 5 | 工牌簽到 | 直接寫成一筆上下班打卡 |
| 6 | 里程包 | 透過 `onMileage` 回呼給外部，本身不寫表 |

---

## 實作上踩過或避開的坑

**基站定位不能用來比對客戶。**
定位包有 `gType`：1 是衛星定位，2 是基站定位。基站定位誤差數百公尺到數公里，
拿去比對客戶座標會生出一堆假的到點記錄。這個服務只用 `gType=1` 做地理判斷。

**token 要對「收到的那串 data」做 md5。**
`token = md5(key + time + data)`。把 JSON parse 完再 stringify 回去，空白和跳脫字元
可能差一個位元組，md5 就全錯，看起來像金鑰設錯。所以驗簽時抓的是原始子字串。
另外文件裡 `time` 同時出現 10 位（秒）和 13 位（毫秒）兩種寫法，程式會兩種都試。

**到點不等於成案。**
車停 3 分鐘就算到點，但 5 分鐘內開走就丟棄不寫入。所以 Ragic 只在「離開」時寫一筆完整的，
不會先寫一筆再回頭更新。等紅燈、路邊臨停都不會進資料庫。

**進出半徑要有遲滯。**
`LEAVE_RADIUS` 一定要大於 `MATCH_RADIUS`，否則車停在邊界上會不停進出，產生一堆碎片記錄。

**車子會在拜訪途中離線。**
開進地下停車場就沒訊號。沒有收尾機制的話那筆拜訪永遠不會結束。
服務每 10 分鐘掃一次，離線超過 45 分鐘就用最後回報時間結案，並標記 `offline_timeout`。

**AI 失敗不能讓記錄消失。**
逾時、額度爆掉、被拒答，都退回規則式的句子照樣寫進 Ragic。
AI 只在拜訪結案時呼叫一次，不是每個定位包都叫——一台車一天上千個定位包，每包叫一次既慢又燒錢。

**回應要快。**
安智連等不到 200 會重送。驗簽和狀態更新做完就先回 200，Ragic 寫入和 AI 丟到背景跑。
驗簽失敗也是回 HTTP 200 加 `errorCode: 1`（照文件第 7 點的格式），避免平台無限重試。

**Traccar 的速度單位是「節」不是公里。**
1 節 = 1.852 公里。不換算的話，時速 15 公里的車會被讀成 8，低於移動門檻而被當成靜止，
於是塞車、等紅燈都會被記成拜訪客戶。`TRACCAR_SPEED_UNIT` 預設 `kn` 會自動換算，
只有在你改過 Traccar 設定讓它送公里時才填 `kmh`。

**Traccar 的 `valid` 和 `outdated` 等同 LPush 的 `gType`。**
`valid=false` 多半是基站定位，`outdated=true` 是補傳的舊點。兩者都不拿來做地理判斷。

**Ragic 的老地雷。**
POST 一定要帶 `?api`；日期送 `YYYY/MM/DD`，ISO 8601 寫不進去；數值欄位送純數字不能帶單位；
POST 只認欄位 ID 不認中文名；GET 上限 1000 筆要分頁；429 要退避重試。
客戶主檔讀到 0 筆時不覆蓋快取，避免快取毒化。

---

## 刻意沒有做的事

**遠端斷油電。**
安智連 API 有 `Transfer/doCmd` 可以遠端切斷車輛油電。這個服務沒有接，也不建議接。
行駛中誤觸會造成事故，而且一個 HTTP 端點被打進來就能讓車隊全部熄火，風險遠大於便利。
真的需要就在安智連自己的後台手動操作，留下他們的稽核記錄。

**用平台的圍欄功能。**
安智連 API 有新增圍欄和圍欄告警，可以讓平台幫你判斷進出。但新增圍欄一天只能 1000 次，
而且客戶一改地址就要同步，狀態散在兩邊。自己算距離反而單純，客戶主檔改了立刻生效。

---

## 接下來可以做

- 到點時透過 LINE bot 通知業務主管（記得走群組推播，一則就好，見 skill `line-quota-saving`）。
- 工牌簽到接進現有的出勤打卡比對系統，業務到客戶點位自動打卡。
- 里程包接成月報，算每台車的實際里程和油耗。
- 掛進營運中控中心當一張卡。
