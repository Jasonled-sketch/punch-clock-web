# LINE 群組 → Ragic 專案報價單（Sheet 8）自動建單

在「譽昇-工程討論」群組打一句話，系統直接在 Ragic 專案報價單建一筆 **✎草稿**，
並 reply 一張卡片（免費，不扣 LINE 額度）。行政只要開連結核價、改進度。

## 你在 LINE 打什麼

```
報價單 蚵寮國小
1.更換為訊號延伸器組(華碩) $3500
2.更換為華碩 USB無線網卡 $1200
3.升級韌體為非陸製軟件組 $8600
4.實體開關 拉線壁切 $2000
```

- 開頭「報價單」（或「建報價」「新報價」），第一行客戶，之後每行一個品項、結尾金額。口語也可以，Claude 會整理。
- 照片：報價單前後 3 分鐘內傳的圖，自動掛到該單的「上傳圖片」欄。
- 查詢：`查報價 蚵寮國小` 或 `@AI 找 遊覽車`，回最近 5 筆，每筆有「開啟報價單」按鈕。
- 只有 `QUOTE_STAFF` 白名單裡的員工能觸發，客戶群不會誤觸。

## 系統流程

1. Claude 把文字抽成 JSON（客戶、品項、單價、數量、product/extra）。
2. 查客戶主檔 CRM 20004 帶電話、統編、抬頭、地址；對不到不擋單。
3. 寫 Sheet 8：報價日期、客戶名稱、案件敘述、產品簡要、首洽縮寫、進度 ✎草稿、現金未稅總計。
   機器/零件進子表「產品明細」，施工/拉線/配件進子表「附加項目」，帶 `doFormula=true` 讓稅額、含稅由 Ragic 算。
4. 照片下載後 multipart 上傳到「上傳圖片」欄。
5. reply Flex 卡：案件編號、品項、合計、Ragic 連結。

## 安裝（usled-linebot，Railway）

1. 把 `line-quote/quote-bot.js` 複製到 usled-linebot 專案根目錄的 `line-quote/` 資料夾。
2. `npm i @anthropic-ai/sdk@latest`（已有就升級到最新）。Node 18 以上（用到內建 fetch / FormData / Blob）。
3. Railway → Variables 新增：

   | 變數 | 值 |
   |---|---|
   | `RAGIC_API_KEY` | Ragic 服務帳戶 Claude YSPE 的 API key（Ragic 右上角個人設定 → API Key） |
   | `QUOTE_STAFF` | `{"U你的userId":"J","U行政userId":"T","U業務userId":"W"}` |
   | `QUOTE_GROUP_ID` | 工程討論群組 ID（選填；不填＝所有群組可用） |

   `ANTHROPIC_API_KEY` 原本就有。
4. `index.js` 頂端加 `const quoteBot = require('./line-quote/quote-bot');`，
   群組事件分支最前面加：

   ```js
   if (await quoteBot.handleEvent(ev, { lineToken: account.token })) continue;
   ```

   `account.token` 換成該 LINE OA 的 channel access token 變數名。
5. （選）每天早上提醒未處理草稿，一則群組 push：

   ```js
   cron.schedule('0 1 * * 1-6', () => quoteBot.remindDrafts({ lineToken: account.token, groupId: process.env.QUOTE_GROUP_ID }).catch(console.error)); // UTC 01:00 = 台灣 09:00
   ```

6. Commit → Railway 自動部署 → Deploy Logs 看到 started → 到群組打「報價單 測試客戶 測試品項 $100」。

拿 userId：白名單員工在群組傳訊息，Railway log 印 `ev.source.userId`（或先讓 bot 回 `ev.source.userId`）。

## 本機測試（不經 LINE）

```
node line-quote/test-parse.js --mock          # 不打 API，看組出來的欄位
node line-quote/test-parse.js                 # 打 Claude 解析範例（需 ANTHROPIC_API_KEY）
node line-quote/test-parse.js --write         # 真的寫一筆到 Sheet 8（需 RAGIC_API_KEY）；寫完到 Ragic 看，確認後可刪
```

## 上線前要驗證的三點

1. **服務帳戶權限**：Claude YSPE 對 Sheet 8 有讀寫、對 CRM 20004 有讀。沒有 → Ragic 回 403 或空 JSON。
2. **子表欄位名**：`1000655_項目_-1` 這種寫法用的是子表欄位「中文名」，若 Ragic 上子表欄位改過名會靜默寫不進。用 `--write` 寫一筆，開 Ragic 看子表有沒有內容。
3. **多張照片**：同一個檔案欄一次上傳多張，Ragic 是否全部保留。若只留最後一張，把 `attachPhotos` 改成一張一個 POST。

## 已知限制

- 客戶編號（1000758）和機型款式（2002408）是連結欄位，API 寫不進，行政在 Ragic 點選。
- Claude 每次解析成本約 NT$0.1 以內；LINE 全部走 reply，不扣月額度；只有每日草稿提醒是 1 則 push。
- 模型預設 `claude-opus-5`，並開了伺服器端 fallback（`fallbacks: 'default'`），極少數被拒答時自動換模型重跑。要省錢改 `QUOTE_MODEL=claude-sonnet-5`。
