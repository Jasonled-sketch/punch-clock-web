# 部署步驟

每一步做完請 Jason 實測再往下，不要一次全上。

## 第 0 步：先讀 JR 的 index.js

在動任何一行之前，把 JR 的 `index.js` 讀過，找出這四段現在長什麼樣：

1. webhook 事件迴圈（`for (const ev of events)` 那一段）
2. 收到圖片怎麼下載（**注意：LINE 圖片用 `fetch` 會失敗，要用 Node 內建 `https`**）
3. 呼叫 Claude 的函式叫什麼、參數長怎樣
4. 現有的 Ragic 寫入怎麼寫的

本包的模組是照「不依賴框架」寫的，要照 JR 的現有風格接進去，不是覆蓋。

## 第 1 步：Ragic 建四張表

照 `spec/01-ragic-tables.md`。建完**每張表都要把「JR家庭」群組加進權限**。

每張表先手動建一筆假資料（欄位都填東西，不要留空），然後：

```bash
RAGIC_KEY=<家庭金鑰> node bot/probe-fields.js bookkeeping/7 bookkeeping/8 bookkeeping/9
```

把印出來的欄位 ID 填進 `bot/exam-module.js` 最上面的 `FIELDS`，順便把 `sheet` 路徑改成實際的。

假資料記得刪掉。

## 第 2 步：跑測試

```bash
EXAM_SECRET=test node bot/exam-module.test.js
```

應該看到「通過 38 項，失敗 0 項」。這步不碰 Ragic，純驗邏輯。

## 第 3 步：加環境變數

Railway → Variables 加四個：

```
EXAM_SECRET        自己產一串隨機字（例如 openssl rand -hex 32）
EXAM_WEB_BASE      考卷網頁網址，第 5 步拿到後再回來填
EXAM_GROUP_ID      家庭群組 ID
EXAM_PARENT_ID     Jason 的 userId
EXAM_STUDENT_ID    小朋友的代號，例如 kid
```

群組 ID 怎麼抓：把 bot 拉進群組後，在群裡打「群組id」，或看 join 事件的 log。

## 第 4 步：掛 API 端點

在 index.js 現有的 express app 後面加一行：

```js
require('./bot/exam-routes')(app);
```

部署後用瀏覽器測（`t` 用 `node -e "process.env.EXAM_SECRET='...';console.log(require('./bot/exam-module').signStudent('kid'))"` 算出來）：

```
https://<你的 Railway 網域>/exam/api/home?s=kid&t=<簽章>
```

看得到 JSON 才往下。看到 `bad_token` 表示簽章算錯或 `EXAM_SECRET` 沒同步。

## 第 5 步：上考卷網頁

`web/index.html` 放上 GitHub Pages（或任何靜態空間）。

**只有一個地方要改**：第一個 script 標籤

```js
window.EXAM_API = "https://<你的 Railway 網域>";
```

放好之後把網址填回 `EXAM_WEB_BASE`。

用手機開 `<網址>/?s=kid&t=<簽章>`，應該看到週曆獎章板。這時還沒有考卷，是正常的。

## 第 6 步：匯入七份現成題庫

`banks/` 裡有七份，寫進 Ragic 的考卷表，狀態填「已上架」：

```js
const X = require('./bot/exam-module');
const fs = require('fs');
for (const f of fs.readdirSync('./banks')) {
  const j = JSON.parse(fs.readFileSync('./banks/' + f, 'utf8'));
  await X.savePaper({ id: f.replace('.json',''), subject: j.subject, title: j.title,
                      unit: j.unit, parts: j.parts, bank: j.bank, status: '已上架' });
}
```

重新整理網頁，七張考卷要出現。挑一張考完，確認分數寫進 Ragic、獎章出現在週曆上。**這一步通過，代表整條資料鏈通了。**

## 第 7 步：接 LINE

在現有的圖片處理流程，AI 判斷是課本／講義時，改呼叫：

```js
const exam = require('./bot/exam-line');
await exam.onTextbookImage(ev, client, imageBuffer, aiSummary);
```

在 postback 處理最前面插一行，讓 exam 先接：

```js
if (await exam.handlePostback(ev, client, { askClaudeVision })) continue;
```

`askClaudeVision(prompt, buffers)` 要自己接上 JR 現有的 Claude 呼叫，回傳字串即可。

測試：小朋友傳一張課本照片 → 卡片第一顆變成「📚 這是考試範圍」→ 按下去 → 等一分鐘 → Jason 收到審核卡片 → 按上架 → 收到作答連結。

## 第 8 步：接晚上七點週曆

```js
const cron = require('node-cron');
exam.scheduleWeeklyBoard(client, cron);
global.lineClient = client;   // 交卷通知要用
```

**時區注意**：Railway 預設 UTC，模組裡寫的是 `0 11 * * *`（＝台灣 19:00）。如果容器已設 `TZ=Asia/Taipei`，要改成 `0 19 * * *`。部署後看日誌確認實際觸發時間，不要用猜的。

## 驗收清單

- [ ] 四張 Ragic 表建好，家庭群組有權限
- [ ] probe 拿到欄位 ID 並填進 FIELDS
- [ ] 測試 38 項全過
- [ ] `/exam/api/home` 回得了 JSON
- [ ] 手機開得了網頁，看得到週曆
- [ ] 七份題庫匯入，考一張，分數進 Ragic、獎章上週曆
- [ ] 傳課本照片 → 出題 → 審核 → 上架 → 作答連結，整條走通
- [ ] 晚上七點收到週曆推播（先手動呼叫測一次，不要等一天）

## 遇到問題先看這裡

| 症狀 | 多半是 |
| --- | --- |
| Ragic 回成功但欄位空白 | 用了中文欄名寫入，要用欄位 ID |
| 日期寫不進去 | 用了 `2026-09-24`，要用 `2026/09/24` |
| 數值欄整欄被拒 | 送了 `"92分"`，要送 `"92"` |
| 讀到空陣列或 403 | 那張表沒把「JR家庭」群組加進權限 |
| 網頁回 bad_token | `EXAM_SECRET` 兩邊不一致，或簽章算錯 |
| 出題回來解析失敗 | Claude 回的 JSON 包了 Markdown 圍欄，模組已處理，若仍失敗把原始回應印出來看 |
| 收到 429 | 先看 log 分清是 Ragic 的 IP 限流還是 LINE 的推播額度用完，兩邊錯誤碼一樣 |
| 圖片下載失敗 | 用了 `fetch`，LINE 的圖要用 Node 內建 `https` |
