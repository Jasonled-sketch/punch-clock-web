# API 端點規格

全部掛在 `/exam/api/`，由 `bot/exam-routes.js` 提供。每一支都要帶 `?s=<學生>&t=<簽章>`，驗不過回 403。

## GET /exam/api/home

首頁一次拿齊需要的東西，減少往返。

回傳：

```json
{
  "student": "kid",
  "papers": [{ "id":"chn-cixuan", "subject":"國文", "title":"詞選", "unit":"第二課",
               "assigned":"2026-09-24", "count":55 }],
  "attempts": [{ "at":1758700000000, "paperId":"chn-cixuan", "title":"詞選",
                 "score":92, "right":23, "total":25, "medal":"鑽石", "wrong":["chn-cixuan:7"] }],
  "dueCount": 12,
  "board": [{ "name":"星期一", "day":"2026-09-22", "score":96, "medal":"超級獎盃", "today":false }],
  "pass": 85, "reviewMax": 20
}
```

## GET /exam/api/exam?kind=paper&id=<考卷編號>

`kind=review` 時不用帶 id，會跨考卷抓今天到期的錯題，最多 20 題。

**回傳刻意不含正解與解析**，避免小朋友看網頁原始碼找答案。交卷時才回。

```json
{ "title":"詞選", "kind":"paper", "parts":{"1":"一、課文"},
  "items":[{ "paperId":"chn-cixuan", "subject":"國文", "qid":1, "p":1,
             "s":"題幹", "o":["A","B","C","D"] }] }
```

## POST /exam/api/submit

送出：

```json
{ "answers":[{ "paperId":"chn-cixuan", "qid":1, "pick":2 }],
  "kind":"paper", "paperId":"chn-cixuan", "resets":0 }
```

`pick` 是選項索引，未作答送 `null`。`resets` 是離開頁面被重新出題的次數。

回傳：

```json
{ "score":92, "right":23, "total":25, "medal":"鑽石", "pass":85,
  "detail":[{ "paperId":"chn-cixuan", "qid":1, "a":2, "e":"解析", "ok":true }] }
```

伺服器端在這支裡做三件事：寫作答紀錄、更新複習排程（一張考卷寫一筆，不是一題一筆）、推一則成績卡到家庭群組。

**成績寫入與 LINE 通知要分開包 try/catch。** 通知失敗不可以連累已經寫好的成績，否則會出現「假失敗真成功」，小朋友重考一次就變兩筆紀錄。
