# 貼給桌機 Claude Code 的指令

在桌機打開 usled-linebot 專案（`C:\...\usled-linebot`），啟動 Claude Code，把下面整段貼進去：

---

請幫我把 LINE 群組建報價單功能接進這個專案：

1. 從 GitHub `Jasonled-sketch/punch-clock-web` 分支 `claude/ragic-quote-integration-uxrqg1` 抓 `line-quote/quote-bot.js` 和 `line-quote/test-parse.js`，放到本專案的 `line-quote/` 資料夾。
   （沒法抓就告訴我，我把檔案貼給你。）
2. `npm i @anthropic-ai/sdk@latest`，確認 package.json engines 是 Node 18 以上。
3. 在 `index.js` 頂端 `require('./line-quote/quote-bot')` 成 `quoteBot`。
4. 找到 webhook 裡處理群組事件的地方（`ev.source.type === 'group' || 'room'` 的分支），在該分支最前面加：
   `if (await quoteBot.handleEvent(ev, { lineToken: <該帳號的 channel access token 變數> })) continue;`
   確認這行在「群組id」指令和其他群組流程之前，且外層函式是 async。
5. 如果專案有 node-cron，加一個每天 UTC 01:00（台灣 09:00）週一到週六的排程呼叫
   `quoteBot.remindDrafts({ lineToken, groupId: process.env.QUOTE_GROUP_ID })`，包 try/catch。
6. 不要把任何 token、API key 寫進程式或文件；全部用 Railway 環境變數 `RAGIC_API_KEY`、`QUOTE_STAFF`、`QUOTE_GROUP_ID`。
7. 改完先跑 `node --check index.js` 和 `node line-quote/test-parse.js --mock`，把結果貼給我，再 commit。
   commit 訊息：`feat: LINE 群組一句話建 Ragic 報價單草稿（Sheet 8）`

---

Commit 後 Railway 會自動部署。部署完到群組打：

```
報價單 測試客戶
1.測試品項 $100
```

看到卡片就成功；沒回應先看 Railway Deploy Logs 有沒有 `[quote]` 開頭的錯誤。
