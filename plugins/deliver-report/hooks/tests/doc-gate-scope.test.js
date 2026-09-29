#!/usr/bin/env node
/**
 * doc-readability-gate 掃描範圍的回歸測試
 *
 * 由來：舊版只掃固定 4 個目錄（目前目錄、_work、docs、output）近期改過的 docx，deliver-report 交付的
 * md／txt／pdf、以及放在別處的 docx（例如 tests/reports/…）完全沒人檢查；目錄頁碼也只在 check-before 跑。
 * 守：
 *   1. 本回合提到（assistant 文字）或寫過（Write）的交付檔，不論位置與格式都掃
 *   2. 說明文件（README 等）與不存在的檔不算交付物
 *   3. docx 有目錄且過期時擋下（Windows＋Word 才跑；沒有 Word 的環境略過這一項並標明）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'doc-readability-gate.js');
let pass = 0, fail = 0, skip = 0;
const check = (desc, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + (detail ? '：' + String(detail).slice(0, 300) : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docgate-'));
const BAD = '# 交付說明\n\n## 一、背景\n\n本次查核發現 §3 要調整。\n\n## 三、結果\n\n內容。\n';
fs.mkdirSync(path.join(tmp, 'deliver', 'out'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'deliver', 'out', '交付說明.md'), BAD);
fs.writeFileSync(path.join(tmp, 'README.md'), BAD);
fs.mkdirSync(path.join(tmp, 'tests', 'reports', 'r1'), { recursive: true });
execFileSync('python', ['-c', [
  'import docx, sys',
  'd = docx.Document(); d.add_heading("報告", 1)',
  'd.add_paragraph("本次查核發現 §3 要調整。")',
  'd.save(sys.argv[1])',
].join('\n'), path.join(tmp, 'tests', 'reports', 'r1', '測試報告.docx')]);

const user = { type: 'user', promptId: 'p1', message: { role: 'user', content: '幫我交付' } };
const skill = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'deliver-report:deliver-report' } }] } };
const res = { type: 'user', promptId: 'p1', toolUseResult: { success: true }, message: { role: 'user', content: [] } };
const meta = { type: 'user', promptId: 'p1', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill' }] } };
const say = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const write = (fp) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: fp, content: '' } }] } });
const run = (lines, cwd = tmp, stopHookActive = false) => {
  const tp = path.join(tmp, 'tr.jsonl');
  fs.writeFileSync(tp, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ cwd, transcript_path: tp, stop_hook_active: stopHookActive }), encoding: 'utf8', timeout: 180000 });
  try { const o = JSON.parse(r.stdout); return { d: o.decision || 'warn', t: o.reason || o.systemMessage || '' }; } catch (_) { return { d: 'allow', t: '' }; }
};

let r = run([user, skill, res, meta, say('交付檔在 `deliver/out/交付說明.md`，請過目。')]);
check('回覆裡提到的 md 交付檔（不在固定目錄）會被掃並擋下', r.d === 'block' && r.t.includes('交付說明.md'), r.t);

r = run([user, skill, res, meta, write(path.join(tmp, 'tests', 'reports', 'r1', '測試報告.docx')), say('報告已產出。')]);
check('Write 寫到 tests/reports/… 的 docx（不在固定目錄、不到 20 段）會被掃並擋下', r.d === 'block' && r.t.includes('測試報告.docx'), r.t);

// Codex 第一輪：去重方向、含空白的 Write 路徑
execFileSync('python', ['-c', [
  'import docx, sys',
  'd = docx.Document(); d.add_heading("短報告", 1); d.add_paragraph("本次查核發現 §3 要調整。"); d.save(sys.argv[1])',
].join('\n'), path.join(tmp, '根目錄短報告.docx')]);
r = run([user, skill, res, meta, say('交付 `根目錄短報告.docx`。')]);
check('交付檔同時在固定目錄內時，仍照交付檔處理（不到 20 段也掃）', r.d === 'block' && r.t.includes('根目錄短報告.docx'), r.t);

fs.mkdirSync(path.join(tmp, 'my docs', '交付 檔案'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'my docs', '交付 檔案', '說明 v1.md'), BAD);
r = run([user, skill, res, meta, write(path.join(tmp, 'my docs', '交付 檔案', '說明 v1.md')), say('已產出。')]);
check('Write 寫出、路徑含空白的交付檔也會被掃', r.d === 'block' && r.t.includes('說明 v1.md'), r.t);

// C 軌審查第一輪：只被提到的輸入檔不可以把 session 卡住
fs.mkdirSync(path.join(tmp, 'input'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'input', '客戶需求.md'), BAD);
const old = (Date.now() - 3 * 24 * 3600 * 1000) / 1000;
fs.utimesSync(path.join(tmp, 'input', '客戶需求.md'), old, old);
r = run([user, skill, res, meta, say('我讀了 `input/客戶需求.md`，整理如下。')]);
check('只被提到、3 天前的輸入檔不算交付檔（放行）', r.d === 'allow', r.t);
r = run([user, skill, res, meta, say('交付檔在 `deliver/out/交付說明.md`。')], tmp, true);
check('已擋過一次、剩下的缺陷只在「被提到」的檔上 → 降為提醒（不卡住 session）', r.d === 'warn' && r.t.includes('已擋過一次'), r.d + ' ' + r.t);
r = run([user, skill, res, meta, write(path.join(tmp, 'my docs', '交付 檔案', '說明 v1.md')), say('已產出。')], tmp, true);
check('已擋過一次，但缺陷在本回合寫出的檔 → 照樣擋', r.d === 'block', r.d);

// C 軌審查第二輪：固定目錄裡的客戶檔也不可以把 session 卡住
const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docgate-dir-'));
execFileSync('python', ['-c', [
  'import docx, sys',
  'd = docx.Document(); d.add_heading("客戶文件", 1)',
  '[d.add_paragraph(f"第{i}段內容。") for i in range(22)]',
  'd.add_paragraph("本次查核發現 §3 要調整。"); d.save(sys.argv[1])',
].join('\n'), path.join(dirTmp, '客戶提供.docx')]);
r = run([user, skill, res, meta, say('已看過資料。')], dirTmp, false);
check('固定目錄裡近期改過的 docx：第一次收尾照樣擋', r.d === 'block', r.d);
r = run([user, skill, res, meta, say('已看過資料。')], dirTmp, true);
check('固定目錄裡的檔、已擋過一次 → 降為提醒（不卡住 session）', r.d === 'warn' && r.t.includes('固定目錄'), r.d + ' ' + r.t);
fs.rmSync(dirTmp, { recursive: true, force: true });

// Codex 第二輪：Markdown 連結
r = run([user, skill, res, meta, say('交付檔：[交付說明](deliver/out/交付說明.md)，請過目。')]);
check('Markdown 連結 [標籤](路徑) 寫的交付檔會被掃並擋下', r.d === 'block' && r.t.includes('交付說明.md'), r.t);
r = run([user, skill, res, meta, say('交付檔：[說明](<my docs/交付 檔案/說明 v1.md>)。')]);
check('Markdown 連結的路徑含空白（<> 包住）也抓得到', r.d === 'block' && r.t.includes('說明 v1.md'), r.t);

// 第三輪：檔名帶半形括號、失敗的 Write／Edit
fs.writeFileSync(path.join(tmp, 'deliver', 'out', '報告(v2).md'), BAD);
r = run([user, skill, res, meta, say('交付檔是 deliver/out/報告(v2).md，請過目。')]);
check('檔名帶半形括號（報告(v2).md）也抓得到', r.d === 'block' && r.t.includes('報告(v2).md'), r.t);
fs.writeFileSync(path.join(tmp, 'my docs', '交付 檔案', '報告(v2) 定稿.md'), BAD);
r = run([user, skill, res, meta, say('交付檔：[報告](<my docs/交付 檔案/報告(v2) 定稿.md>)。')]);
check('Markdown 連結 <> 包住、含空白與括號的路徑也抓得到', r.d === 'block' && r.t.includes('報告(v2) 定稿.md'), r.t);
fs.writeFileSync(path.join(tmp, '(定稿)報告.md'), BAD);
r = run([user, skill, res, meta, write('(定稿)報告.md'), say('已產出。')]);
check('Write 的相對路徑檔名以括號開頭（(定稿)報告.md）照原樣採用、會被掃', r.d === 'block' && r.t.includes('(定稿)報告.md'), r.t);
const failedEdit = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e9', name: 'Edit', input: { file_path: path.join(tmp, 'input', '客戶需求.md'), old_string: 'x', new_string: 'y' } }] } };
const failedRes = { type: 'user', promptId: 'p1', toolUseResult: 'Error: String to replace not found', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e9', is_error: true, content: 'String to replace not found in file.' }] } };
r = run([user, skill, res, meta, failedEdit, failedRes, say('已看過資料。')]);
check('失敗的 Edit（回傳 is_error）不算寫出：舊的客戶原稿不被當交付檔（放行）', r.d === 'allow', r.d + ' ' + r.t);

r = run([user, skill, res, meta, say('請看 README.md 的說明。')]);
check('README.md 不算交付物（放行）', r.d === 'allow', r.t);

r = run([user, skill, res, meta, say('交付檔是 `deliver/out/不存在.md`。')]);
check('提到但不存在的檔忽略（放行）', r.d === 'allow', r.t);

r = run([say('交付檔在 `deliver/out/交付說明.md`。')]);
check('本回合沒叫 deliver-report 系 skill 時不掃（放行）', r.d === 'allow', r.t);

// 目錄過期（需要 Word）
let wordOk = false;
if (process.platform === 'win32') {
  const mk = spawnSync('python', ['-c', [
    'import sys, docx, win32com.client as w',
    'p = sys.argv[1]',
    'd = docx.Document(); d.add_paragraph("目錄位置")',
    'for t in ["一、背景", "二、結果"]:',
    '    d.add_heading(t, level=1)',
    '    [d.add_paragraph(f"{t} 的內容第 {k} 段，這是測試用的敘述文字，長度足以佔掉一些版面。") for k in range(12)]',
    'd.save(p)',
    'wd = w.Dispatch("Word.Application"); wd.Visible = False; wd.DisplayAlerts = 0',
    'doc = wd.Documents.Open(p)',
    'doc.TablesOfContents.Add(doc.Paragraphs(1).Range, True, 1, 1); doc.TablesOfContents(1).Update()',
    'end = doc.TablesOfContents(1).Range.End',
    'for para in doc.Paragraphs:',
    '    if para.Range.Start > end and para.Range.Text.strip() == "二、結果":',
    '        doc.Range(para.Range.Start, para.Range.Start).InsertBreak(7); break',
    'doc.Save(); doc.Close(0); wd.Quit()',
  ].join('\n'), path.join(tmp, 'stale_toc.docx')], { encoding: 'utf8', timeout: 180000 });
  wordOk = mk.status === 0;
}
if (wordOk) {
  r = run([user, skill, res, meta, say('交付 stale_toc.docx。')]);
  check('目錄過期的 docx 在 Stop hook 也會被擋（目錄頁碼）', r.d === 'block' && r.t.includes('目錄未更新'), r.t);
} else { skip++; console.log('  - 略過：目錄頁碼（這台沒有 Windows＋Word，無法產生測試檔）'); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 過、${fail} 失敗${skip ? `、${skip} 略過` : ''}`);
process.exit(fail ? 1 : 0);
