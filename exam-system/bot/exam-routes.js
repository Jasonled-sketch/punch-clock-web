'use strict';
/**
 * 給考卷網頁用的 API。掛進現有 Express app：
 *   require('./bot/exam-routes')(app);
 *
 * 安全原則：Ragic 金鑰只活在這一層，絕對不能傳到瀏覽器。
 * 網頁只帶 ?s=<學生>&t=<簽章>，由 verifyStudent 驗。
 */
const X = require('./exam-module');

function auth(req, res, next) {
  const s = req.query.s || req.body?.s;
  const t = req.query.t || req.body?.t;
  if (!X.verifyStudent(s, t)) return res.status(403).json({ error: 'bad_token' });
  req.student = String(s);
  next();
}
const fail = (res, e) => { console.error('[exam]', e); res.status(500).json({ error: 'server' }); };

module.exports = function (app) {
  app.use('/exam/api', require('express').json());

  /** 首頁一次拿齊：考卷、紀錄、待複習數、週曆 */
  app.get('/exam/api/home', auth, async (req, res) => {
    try {
      const [papers, attempts, reviews] = await Promise.all([
        X.listPapers(), X.listAttempts(req.student), X.loadReviews(req.student)
      ]);
      const due = X.dueQuestions(papers, reviews);
      res.json({
        student: req.student,
        papers: papers.map(p => ({
          id:p.id, subject:p.subject, title:p.title, unit:p.unit,
          assigned:p.assigned, count:p.bank.length
        })),
        attempts, dueCount: due.length,
        board: X.weekBoard(attempts),
        pass: X.PASS, reviewMax: X.REVIEW_MAX
      });
    } catch (e) { fail(res, e); }
  });

  /** 開一份卷。kind=paper 帶 id，kind=review 不用帶 */
  app.get('/exam/api/exam', auth, async (req, res) => {
    try {
      const [papers, reviews] = await Promise.all([X.listPapers(), X.loadReviews(req.student)]);
      let items, title;
      if (req.query.kind === 'review') {
        items = X.buildReviewExam(papers, reviews);
        title = '錯題複習 · 跨科目';
      } else {
        const p = papers.find(x => x.id === req.query.id);
        if (!p) return res.status(404).json({ error: 'no_paper' });
        const st = (reviews[p.id] || {}).state || {};
        items = X.buildExam(p, st).map(q => ({ paper:p, q }));
        title = p.title;
      }
      // 正解與解析不送到前端，交卷時才回，避免直接看原始碼找答案
      res.json({
        title, kind: req.query.kind || 'paper',
        parts: req.query.kind === 'review' ? null
             : (papers.find(x => x.id === req.query.id) || {}).parts || null,
        items: items.map(it => ({
          paperId: it.paper.id, subject: it.paper.subject, qid: it.q.id,
          p: it.q.p || 0, s: it.q.s, o: it.q.o
        }))
      });
    } catch (e) { fail(res, e); }
  });

  /** 交卷：評分、寫紀錄、更新複習排程，回逐題訂正 */
  app.post('/exam/api/submit', auth, async (req, res) => {
    try {
      const { answers = [], kind = 'paper', paperId = '', resets = 0 } = req.body || {};
      if (!Array.isArray(answers) || !answers.length) return res.status(400).json({ error: 'empty' });
      const [papers, reviews] = await Promise.all([X.listPapers(), X.loadReviews(req.student)]);
      const g = X.grade(answers, papers);
      const head = papers.find(p => p.id === paperId);

      const rec = {
        at: Date.now(), student: req.student,
        paperId: kind === 'review' ? 'review' : paperId,
        title: kind === 'review' ? '錯題複習' : (head ? head.title : paperId),
        subject: kind === 'review' ? '錯題複習' : (head ? head.subject : ''),
        score: g.score, right: g.right, total: g.total, medal: g.medal,
        wrong: g.wrong, resets
      };
      await X.saveAttempt(rec);

      // 一張考卷寫一筆，不要一題一筆
      for (const pid of Object.keys(g.byPaper)) {
        const cur = reviews[pid] || { state:{}, _rid:null };
        for (const { qid, ok } of g.byPaper[pid]) {
          const next = X.bumpCell(cur.state[qid], ok);
          if (next) cur.state[qid] = next; else delete cur.state[qid];
        }
        await X.saveReview(req.student, pid, cur.state, cur._rid);
      }

      // 訂正明細
      const detail = answers.map(a => {
        const p = papers.find(x => x.id === a.paperId);
        const q = p && p.bank.find(x => String(x.id) === String(a.qid));
        return q ? { paperId:a.paperId, qid:a.qid, a:q.a, e:q.e, ok:Number(a.pick) === q.a } : null;
      }).filter(Boolean);

      res.json({ score:g.score, right:g.right, total:g.total, medal:g.medal, pass:X.PASS, detail });

      // 通知失敗不可連累寫入，所以放在回應之後並獨立包起來
      try {
        if (typeof module.exports.onSubmitted === 'function') await module.exports.onSubmitted(rec);
      } catch (e) { console.error('[exam] 通知失敗（不影響已寫入的成績）', e); }
    } catch (e) { fail(res, e); }
  });

  console.log('[exam] routes ready: /exam/api/home, /exam/api/exam, /exam/api/submit');
};
/** 由 exam-line.js 覆寫，交卷後推一則成績卡到群組 */
module.exports.onSubmitted = null;
