# JR 家庭考卷系統 — 交接包

給桌機 Claude Code 執行。目標是讓 JR 家庭 bot 接手「小朋友拍講義 → 自動出考卷 → LINE 發作答連結 → 記分數 → 晚上七點秀週曆獎章」。

## 先讀這段再動手

**這個包裡沒有任何金鑰。** 所有 secret 一律放 Railway 環境變數，程式碼不寫死。包裡出現的全是變數名稱。

**不要照抄貼上。** 先把 JR 的 `index.js` 讀過一遍，看清楚現有的 webhook 迴圈、圖片下載、Claude 呼叫、Ragic 寫入四段長什麼樣，再把本包的模組**依照現有風格接進去**。本包的模組刻意寫成不依賴框架，方便你改。

**一次一小步。** 每完成一個里程碑就請 Jason 在手機實測一次再往下。順序在最後一節。

## 現況（2026-09-24 查證）

小朋友的課本照片**已經會傳進 JR**。JR 也已經用 AI 讀出內容（實例：辨識出「國文課本《如夢令》、南鄉子講義」）。但 JR 把它歸到「其他」，回一張卡片給 Jason 選「行程／支出／算了」，三個都不對，所以沒人按，照片就掉了。

**缺的不是基礎建設，是一顆按鈕。**

## 要做的四件事

| # | 事項 | 檔案 |
| --- | --- | --- |
| 1 | Ragic 開四張表 | `spec/01-ragic-tables.md` |
| 2 | bot 加考卷模組（出題／評分／複習／獎章） | `bot/exam-module.js` |
| 3 | bot 加 API 端點給網頁用 | `bot/exam-routes.js` |
| 4 | bot 加 LINE 事件處理與七點排程 | `bot/exam-line.js` |

網頁在 `web/index.html`，七份現成題庫在 `banks/`。

## 新增的環境變數

```
EXAM_SECRET        ← 自己產一串隨機字，用來簽作答連結
EXAM_WEB_BASE      ← 考卷網頁網址，例如 https://xxx.github.io/exam
EXAM_GROUP_ID      ← 家庭群組 ID（七點推播與審核卡片用）
EXAM_PARENT_ID     ← Jason 的 userId（審核卡片推給他）
```

沿用既有的：Ragic 家庭金鑰、Anthropic 金鑰、LINE 通道金鑰。一把都不用新增。

## 里程碑順序

1. **Ragic 建表＋跑 probe** 拿到欄位 ID，填進 `bot/exam-module.js` 最上面的 `FIELDS`。沒有這步後面全部寫不進去。
2. **匯入七份題庫** 用 `banks/*.json`，確認 Ragic 看得到題目。
3. **接 API 端點** 先用瀏覽器打 `/exam/api/papers?s=...&t=...` 看得到 JSON。
4. **上網頁** 把 `web/index.html` 放上 GitHub Pages，設好 `EXAM_WEB_BASE`，手機開得起來、考得完、分數寫得進 Ragic。
5. **接 LINE 分類卡片第四顆按鈕** 小朋友傳照片 → 出題 → 審核卡片 → Jason 按上架。
6. **接七點排程** 最後才做，先確認前面都穩。

每一步做完請 Jason 實測再往下。
