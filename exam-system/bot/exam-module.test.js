'use strict';
/** 純邏輯測試，不碰 Ragic。跑法：EXAM_SECRET=test node bot/exam-module.test.js */
process.env.EXAM_SECRET = process.env.EXAM_SECRET || 'test-secret';
const X = require('./exam-module');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };

console.log('獎章分級');
[[100,'超級獎盃'],[95,'超級獎盃'],[94,'鑽石'],[90,'鑽石'],[89,'金牌'],[85,'金牌'],[84,'銀牌'],
 [80,'銀牌'],[79,'銅牌'],[70,'銅牌'],[69,'獎狀'],[60,'獎狀'],[59,'豬頭'],[0,'豬頭']]
 .forEach(([s,n]) => ok(X.tierOf(s).name === n, `${s} 分 → ${n}`));

console.log('間隔複習');
let c = null;
c = X.bumpCell(c, false); ok(c.lv === 0 && c.due === X.isoDay(Date.now()+X.DAY), '答錯 → 第0級，明天');
c = X.bumpCell(c, true);  ok(c.lv === 1 && c.due === X.isoDay(Date.now()+3*X.DAY), '答對 → 第1級，3天後');
c = X.bumpCell(c, true);  ok(c.lv === 2 && c.due === X.isoDay(Date.now()+7*X.DAY), '再對 → 第2級，7天後');
c = X.bumpCell(c, true);  ok(c.lv === 3 && c.due === X.isoDay(Date.now()+14*X.DAY), '再對 → 第3級，14天後');
c = X.bumpCell(c, true);  ok(c.lv === 4 && c.due === X.isoDay(Date.now()+30*X.DAY), '再對 → 第4級，30天後');
ok(X.bumpCell(c, true) === null, '第4級再對 → 畢業');
ok(X.bumpCell(c, false).lv === 0, '第4級答錯 → 直接掉回第0級');

console.log('出題');
const bank = []; for (let i=1;i<=60;i++) bank.push({id:i,p:i<=30?1:2,r1:i<=30?1:0,s:'Q'+i,o:['a','b','c','d'],a:i%4,e:'E'+i});
const paper = { id:'p1', subject:'國文', title:'T', bank, parts:{1:'一',2:'二'} };
const e1 = X.buildExam(paper, {});
ok(e1.length === 25, '一份 25 題');
ok(new Set(e1.map(q=>q.id)).size === 25, '沒有重複題');
ok(e1.every((q,i,a) => i===0 || (a[i-1].p||0) <= (q.p||0)), '有 parts 時依大題排序');
const st = {}; [41,42,43,44,45].forEach(id => st[id] = {lv:0,due:X.isoDay()});
const e2 = X.buildExam(paper, st);
ok([41,42,43,44,45].every(id => e2.some(q => q.id === id)), '上次答錯的一定被帶進下一份');

console.log('評分');
const answers = e1.map((q,i) => ({paperId:'p1', qid:q.id, pick: i<20 ? q.a : (q.a+1)%4}));
const g = X.grade(answers, [paper]);
ok(g.right === 20 && g.total === 25 && g.score === 80, '20/25 → 80 分');
ok(g.medal === '銀牌', '80 分 → 銀牌');
ok(g.wrong.length === 5 && g.wrong[0].startsWith('p1:'), '答錯清單格式 考卷:題號');

console.log('週曆');
const ws = X.weekStart();
const att = [[0,96],[0,72],[2,88],[3,55]].map(([d,s]) => ({at: ws + d*X.DAY + 36e5, score:s}));
const b = X.weekBoard(att, ws + 3*X.DAY + 6e6);
ok(b.length === 7, '七格');
ok(b[0].score === 96 && b[0].medal === '超級獎盃', '同一天兩筆取最高分 96');
ok(b[1].score === null, '沒考的那天是空的');
ok(b[3].medal === '豬頭' && b[3].today === true, '星期四 55 分是豬頭且標記為今天');
ok(X.weekBoardText(b, '小明').includes('本週完成 3 / 7 天'), '推播文字統計正確');

console.log('連結簽章');
const tk = X.signStudent('kid');
ok(X.verifyStudent('kid', tk) === true, '正確簽章通過');
ok(X.verifyStudent('kid', 'deadbeefdeadbeef') === false, '錯誤簽章擋掉');
ok(X.verifyStudent('other', tk) === false, '換學生 ID 擋掉');

console.log('日期格式');
ok(/^\d{4}\/\d{2}\/\d{2}$/.test(X.ragicDay()), 'Ragic 日期用斜線');
ok(/^\d{4}-\d{2}-\d{2}$/.test(X.isoDay()), '內部比較用短線');

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
