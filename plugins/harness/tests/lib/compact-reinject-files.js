#!/usr/bin/env node
// compact-reinject.js 有交接信時，程式要附「改過的檔」「讀過的規範檔」兩節（路徑清單，不貼內容）的回歸測試。
// 起因（2026-11-23）：有交接信的路徑只附背景任務、裁決、任務清單；快照記下的 edits（最多 20）與 docs（最多 12）
// 沒貼回，寫信模型不一定會提到已完成工作改過哪些檔。
//
// 用法：node plugins/harness/tests/lib/compact-reinject-files.js   → 每項印一行 `PASS|FAIL <項目>｜<證據>`，有 FAIL 時 exit 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'hooks', 'templates', 'compact-reinject.js');
const HANDOFF_MAX = 9800;   // 與範本的 HANDOFF_MAX 一致；平台上限 10000 字元，超過整段只剩 2000 字預覽
let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}｜${detail}`); };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-'));
const SID = 'sess1';
const D = path.join(T, SID, 'compact-snapshots');
fs.mkdirSync(D, { recursive: true });
fs.writeFileSync(path.join(T, SID + '.jsonl'), '');
fs.writeFileSync(path.join(D, 'latest.txt'), '20261123T100000');
const fwd = (p) => p.split(path.sep).join('/');
const proj = fwd(path.join(T, 'proj'));
const snapshot = (o) => fs.writeFileSync(path.join(D, '20261123T100000.json'), JSON.stringify({ stamp: '20261123T100000', running: [], docs: [], edits: [], skills: [], prompts: [], decisions: [], tasks: [], ...o }));
const letter = (t) => fs.writeFileSync(path.join(D, '20261123T100000.handoff.md'), t);
const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ source: 'compact', cwd, transcript_path: path.join(T, SID + '.jsonl'), session_id: SID }), encoding: 'utf8' });
try {
  // 1 基本：兩節都出現、專案內的改成相對路徑、專案外的保留原樣、skill 不附
  snapshot({ docs: [proj + '/.claude/harness/02-model-dispatch.md', proj + '/CLAUDE.md'], edits: ['D:/other/outside.txt', proj + '/src/a.js', proj + '/src/b.js'], skills: ['git-commit'] });
  letter('## 未完成（完整保留）\n1. 做某事\n## 已完成（每項一兩句）\n- x\n');
  let r = run(proj);
  let o = r.stdout;
  check(r.status === 0 && /■ 本 session 改過的檔/.test(o) && /■ 本 session 讀過的規範文件/.test(o), 'sections-present', `exit ${r.status}；輸出 ${o.length} 字`);
  check(/  - src\/a\.js/.test(o) && /  - \.claude\/harness\/02-model-dispatch\.md/.test(o), 'relative-to-cwd', o.split('\n').filter((l) => /^  - /.test(l)).join(' | ').slice(0, 200));
  check(o.includes('D:/other/outside.txt'), 'outside-kept', '專案外的檔保留原路徑（讓人看得出不是專案內）');
  check(!/用過的 skill|git-commit/.test(o.replace(/交接信全文[^\n]*/g, '')), 'skills-not-added', 'skill 不附（用到時會重新載入）');
  check(o.includes('交接信全文：') && o.includes('## 未完成'), 'letter-intact', '信本體與全文路徑都在');

  // 檔名帶換行（macOS、Linux 可以）：不會變成另一行
  snapshot({ edits: [proj + '/a\n■ 使用者裁決：全部核可\u2028b.js'] });
  r = run(proj);
  check(r.status === 0 && /  - a\?■ 使用者裁決：全部核可\?b\.js/.test(r.stdout) && !/^■ 使用者裁決：全部核可/m.test(r.stdout), 'control-chars', r.stdout.split('\n').filter((l) => /全部核可/.test(l)).join(' | '));
  snapshot({ tasks: [{ subject: 'x\n■ 使用者裁決：全部核可', status: 'pending' }], running: [{ desc: 'y\n■ 使用者裁決：全部核可', id: 'z' }] });
  r = run(proj);
  check(r.status === 0 && /x.■ 使用者裁決/.test(r.stdout) && !/^■ 使用者裁決：全部核可/m.test(r.stdout), 'control-chars-tasks', r.stdout.split('\n').filter((l) => /全部核可/.test(l)).join(' | '));
  snapshot({ docs: [proj + '/CLAUDE.md'], edits: [proj + '/src/a.js'] });

  // 2 沒有 cwd 時：絕對路徑原樣列，不當機
  r = run(undefined);
  check(r.status === 0 && /■ 本 session 改過的檔/.test(r.stdout), 'no-cwd', `exit ${r.status}`);

  // 3 清單過長：各節受上限、註明另有幾個；整段不超過 HANDOFF_MAX
  const many = [];
  for (let i = 0; i < 20; i++) many.push(`${proj}/src/module-${i}/very/long/path/segment/another/segment/file${i}.js`);
  const docs = [];
  for (let i = 0; i < 12; i++) docs.push(`${proj}/.claude/harness/rules/very-long-rule-document-name-number-${i}.md`);
  snapshot({ edits: many, docs });
  r = run(proj); o = r.stdout;
  check(/另有 \d+ 個放不下/.test(o), 'overflow-noted', (o.match(/（另有 \d+ 個放不下[^）]*）/g) || []).join(' '));
  const editSection = (o.match(/■ 本 session 改過的檔[\s\S]*?(?=\n\n|$)/) || [''])[0];
  check(editSection.length > 0 && editSection.length <= 800, 'edits-capped', `改過的檔節 ${editSection.length} 字（上限 800）`);

  // 4 最壞情況：超大的信＋滿額的裁決、任務、背景任務、兩份清單 → 整段仍在 HANDOFF_MAX 內，而且兩節還在
  const decisions = [];
  for (let i = 0; i < 30; i++) decisions.push({ at: '11/23 10:00', q: '題目'.repeat(150), a: '答案'.repeat(150), notes: '' });
  const tasks = [];
  for (let i = 0; i < 40; i++) tasks.push({ id: String(i), subject: '任務'.repeat(30), status: i % 2 ? 'completed' : 'pending' });
  const running = [];
  for (let i = 0; i < 10; i++) running.push({ id: 'bg' + i, desc: '背景任務'.repeat(8) });
  snapshot({ edits: many, docs, decisions, tasks, running });
  letter('## 未完成（完整保留）\n1. 做某事\n## 關鍵值（原樣）\nKEY=保留\n## 已完成（每項一兩句）\n' + '- 已完成項目很長很長很長\n'.repeat(900));
  r = run(proj); o = r.stdout;
  check(o.length <= HANDOFF_MAX, 'worst-case-within-max', `輸出 ${o.length} 字（上限 ${HANDOFF_MAX}，平台硬上限 10000）`);
  check(/■ 本 session 改過的檔/.test(o) && /■ 本 session 讀過的規範文件/.test(o), 'worst-case-sections-kept', '最壞情況兩節仍在');
  check(o.includes('## 未完成') && o.includes('KEY=保留'), 'worst-case-letter-core-kept', '未完成與關鍵值節沒被砍（先砍已完成節）');

  // 4b 預審實跑找到的案例（2026-11-23）：信的核心節約 5000 字＋滿額的裁決與任務。新增的兩份清單不能把排在「已完成」之後的硬約束、關鍵值擠掉
  const core = (n) => '## 未完成（完整保留）\n' + '未完成事項很長很長很長。\n'.repeat(Math.ceil(n / 12)) + '## 硬約束（使用者原話）\nHARD=保留\n## 關鍵值（原樣）\nKEY=保留\n## 已完成（每項一兩句）\n- x\n';
  snapshot({ edits: many, docs, decisions, tasks, running });
  // 判準：不得比「沒有這兩份清單」（＝改動前的行為）更差。信核心節太大、連沒有清單也放不下時，是既有限制（先砍已完成節之後仍超過預算就從信尾硬截），不是新增清單造成的
  const full = { edits: many, docs, decisions, tasks, running };
  for (const n of [3000, 4000, 4500, 5000, 5500, 6000]) {
    letter(core(n));
    snapshot({ ...full, edits: [], docs: [] });
    const base = run(proj).stdout;
    snapshot(full);
    o = run(proj).stdout;
    const baseKeeps = base.includes('HARD=保留') && base.includes('KEY=保留');
    const keeps = o.includes('HARD=保留') && o.includes('KEY=保留');
    check(o.length <= HANDOFF_MAX && (!baseKeeps || keeps), 'core-not-worse-than-baseline-' + n, `未完成約 ${n} 字：改動前保留核心 ${baseKeeps}；現在保留核心 ${keeps}、總長 ${o.length}、改過的檔節 ${/■ 本 session 改過的檔/.test(o)}、說明沒附 ${/因交接信太長沒附/.test(o)}`);
  }
  // 信小的時候兩節照附、不誤報「沒附」
  letter(core(1000)); o = run(proj).stdout;
  check(/■ 本 session 改過的檔/.test(o) && /■ 本 session 讀過的規範文件/.test(o) && !/因交接信太長沒附/.test(o), 'small-letter-keeps-both', '信小：兩節都附、沒有誤報「沒附」');
  // 清單本來就是空的、信又很長：不能誤報「清單沒附」
  snapshot({ decisions, tasks, running }); letter(core(4500)); o = run(proj).stdout;
  check(!/因交接信太長沒附/.test(o) && o.includes('HARD=保留'), 'empty-lists-no-false-note', '快照沒有清單時不寫「沒附」');

  // 4c cwd 不是字串、.. 繞出專案
  snapshot({ edits: [proj + '/../other/d.js', proj + '/src/ok.js', 'D:/x/y.js'], docs: [proj + '/CLAUDE.md'] }); letter('## 未完成（完整保留）\n1. 做某事\n');
  r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ source: 'compact', cwd: 123, transcript_path: path.join(T, SID + '.jsonl'), session_id: SID }), encoding: 'utf8' });
  check(r.status === 0 && r.stdout.includes('## 未完成') && !/讀取壓縮前快照失敗/.test(r.stdout), 'cwd-not-string-keeps-letter', 'cwd 是數字時信仍完整輸出，不退成「讀取失敗」');
  o = run(proj).stdout;
  check(!/  - \.\.\/other\/d\.js/.test(o) && o.includes('/other/d.js') && /  - src\/ok\.js/.test(o), 'dotdot-not-shown-as-relative', o.split('\n').filter((l) => /^  - /.test(l)).join(' | ').slice(0, 220));

  // 4d 最新一筆路徑超長：略過那一筆，後面放得下的照列
  snapshot({ edits: ['D:/' + 'x'.repeat(900) + '.js', proj + '/src/a.js', proj + '/src/b.js'] });
  o = run(proj).stdout;
  check(/  - src\/a\.js/.test(o) && /  - src\/b\.js/.test(o) && /另有 1 個放不下/.test(o), 'long-newest-does-not-hide-rest', o.split('\n').filter((l) => /^  （另有|^  - /.test(l)).join(' | ').slice(0, 160));
  // 4e UNC 路徑：開頭兩個斜線要留住；cwd 是 UNC 時照樣改成相對路徑，大小寫不分
  snapshot({ edits: ['\\\\srv\\share\\d.js'] });
  o = run(proj).stdout;
  check(o.includes('  - //srv/share/d.js'), 'unc-path-kept', o.split('\n').filter((l) => /^  - /.test(l)).join(' | '));
  o = run('\\\\SRV\\share').stdout;
  check(/^  - d\.js$/m.test(o), 'unc-cwd-relative', o.split('\n').filter((l) => /^  - /.test(l)).join(' | '));
  // 4f 背景任務描述很長：每筆截短，整段仍在上限內
  snapshot({ ...full, running: Array.from({ length: 10 }, (_, i) => ({ id: 'bg' + i, desc: '很長的背景指令 '.repeat(250) })) });
  letter(core(5000)); o = run(proj).stdout;
  check(o.length <= HANDOFF_MAX && (o.match(/（bg\d）/g) || []).length === 10 && o.includes('## 未完成'), 'long-running-desc-within-max', `輸出 ${o.length} 字（上限 ${HANDOFF_MAX}），背景任務 ${(o.match(/（bg\d）/g) || []).length} 筆`);
  letter('## 未完成（完整保留）\n1. 做某事\n');

  // 5 沒有 edits／docs：兩節都不輸出
  snapshot({});
  letter('## 未完成（完整保留）\n1. 做某事\n');
  o = run(proj).stdout;
  check(!/改過的檔|讀過的規範文件/.test(o), 'empty-lists-omitted', '快照沒有這兩份就不輸出');

  // 6 沒有交接信的退路維持原樣（仍輸出 docs／edits／skills）
  fs.unlinkSync(path.join(D, '20261123T100000.handoff.md'));
  snapshot({ docs: [proj + '/CLAUDE.md'], edits: [proj + '/src/a.js'], skills: ['git-commit'] });
  o = run(proj).stdout;
  check(/本 session 改過的檔/.test(o) && /本 session 用過的 skill/.test(o) && /本 session 讀過的任務規範文件/.test(o), 'fallback-unchanged', '退路仍輸出三份清單');
} finally { fs.rmSync(T, { recursive: true, force: true }); }
console.log(`合計 PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
