#!/usr/bin/env node
// 讀 transcript 的 hook／腳本不得整檔讀成字串的回歸測試（2026-11-11）。
// 起因：來源實例 Stop hook 每次都把整份 transcript 讀成字串再逐行 parse，374 MB 的 transcript 讓 hook 進程峰值 1141 MB，
// 系統記憶體吃緊時直接「FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory」。
// 範本裡同樣寫法的有 init-stop-gate、guard-sediment-sweep（Stop 模式）、compact-snapshot、compact-handoff、guard-required-skill、
// learn-reflect、learn-promote，改成分塊讀（需要全歷史的逐塊讀；只需要本回合的從檔尾往回讀到最後一則使用者訊息）。
//
// 兩組：
//   等價：合成 transcript（長列讓 4 MB 分塊邊界切在中文字元與列中間），新讀法的結果要等於整檔讀＋split 的參考實作。
//   記憶體：子程序限 64 MB heap（--max-old-space-size=64），餵 80 MB transcript，各函式要跑完並答對；
//          整檔讀版本會在這裡 heap out of memory。驗舊版：TIO_HOOKS=<舊版 hooks 目錄>（底下要有 templates/）。
//
// 用法：node plugins/harness/tests/lib/transcript-io.js → 每項印一行 `PASS|FAIL <項目>｜<證據>`，有 FAIL 時 exit 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.resolve(process.env.TIO_HOOKS || path.join(__dirname, '..', '..', 'hooks'));
const TPL = path.join(HOOKS, 'templates');
let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}｜${detail}`); };

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tio-'));
const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const asst = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const toolRes = (t, id) => user([{ type: 'tool_result', tool_use_id: id || 'toolu_x', content: t }]);
const skillUse = (id, name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] } });
const filler = (n) => ({ type: 'x-filler', data: '中'.repeat(n) });

// 把檔尾主流程（marker 最後一次出現處起）切掉、補匯出，寫進暫存 hooks 目錄
function modularize(src, dest, marker, names) {
  const s = fs.readFileSync(src, 'utf8');
  const at = s.lastIndexOf(marker);
  if (at < 0) throw new Error('找不到主流程起點：' + path.basename(src));
  fs.writeFileSync(dest, s.slice(0, at).replace(/^#!.*\n/, '') + '\nmodule.exports = { ' + names.join(', ') + ' };\n');
}
const D = path.join(W, 'hooks');
fs.mkdirSync(D);
try {
  for (const f of ['compact-handoff.js', 'guard-required-skill.js', 'learn-lib.js', 'learn-reflect.js', 'learn-promote.js']) fs.copyFileSync(path.join(TPL, f), path.join(D, f));
  modularize(path.join(TPL, 'compact-snapshot.js'), path.join(D, 'compact-snapshot.js'), 'if (process.env.COMPACT_HANDOFF_CHILD) process.exit(0);', ['scan']);
  modularize(path.join(HOOKS, 'init-stop-gate.js'), path.join(D, 'init-stop-gate.js'), 'try {\n  const input = readInput();', ['lastAssistantText']);
  const sedSrc = fs.readFileSync(path.join(TPL, 'guard-sediment-sweep.js'), 'utf8');
  modularize(path.join(TPL, 'guard-sediment-sweep.js'), path.join(D, 'guard-sediment-sweep.js'), "try {\n  let raw = '';",
    ['isRealUserPrompt'].concat(/function readTurnEntries\(/.test(sedSrc) ? ['readTurnEntries'] : []));
} catch (e) {
  check(false, '準備暫存模組', e.message);
}

// 子程序執行一段探針；回 { ok, out, err }
const PROBE = path.join(W, 'probe.js');
fs.writeFileSync(PROBE, [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const [D, kind, file] = process.argv.slice(2);",
  "const R = (f) => require(path.join(D, f));",
  "const turnOf = (entries, isU) => { let s = -1; for (let i = entries.length - 1; i >= 0; i--) if (isU(entries[i])) { s = i; break; } return entries.slice(s + 1); };",
  "let out;",
  "if (kind === 'lines') {",
  "  const lib = R('learn-lib.js'); let n = 0, last = '';",
  "  lib.readLineBatches(file, (b) => { for (const l of b) { n++; if (l) last = l; } });",
  "  out = { n, last: JSON.parse(last).message.content[0].text };",
  "} else if (kind === 'skills') {",
  "  const m = R('guard-required-skill.js');",
  "  const names = m.loadedSkillsFromFile ? m.loadedSkillsFromFile(file) : m.loadedSkills(fs.readFileSync(file, 'utf8'));",
  "  out = [...names].sort();",
  // 增量：先掃一次建記錄，追加 gamma 的 Skill 呼叫與成功回傳，再掃時統計 readSync 讀了多少位元組
  "} else if (kind === 'skillsinc') {",
  "  const m = R('guard-required-skill.js'); m.loadedSkillsFromFile(file);",
  "  const add = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_g', name: 'Skill', input: { skill: 'gamma' } }] } },",
  "    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_g', content: 'ok' }] } }];",
  "  fs.appendFileSync(file, add.map((x) => JSON.stringify(x)).join('\\n') + '\\n');",
  "  let bytes = 0; const orig = fs.readSync; fs.readSync = function () { const n = orig.apply(fs, arguments); bytes += n; return n; };",
  "  const names = m.loadedSkillsFromFile(file); fs.readSync = orig;",
  "  out = { skills: [...names].sort(), bytes };",
  "} else if (kind === 'digest') {",
  "  const d = R('compact-handoff.js').buildDigest(file); out = typeof d === 'string' ? d : JSON.stringify(d);",
  "  out = out.includes('最後一問') && out.includes('最後回覆') ? 'has-tail' : 'missing-tail';",
  "} else if (kind === 'snapshot') {",
  "  const s = R('compact-snapshot.js').scan(file); out = JSON.stringify(s).includes('最後一問') ? 'has-prompt' : 'missing-prompt';",
  "} else if (kind === 'stopgate') {",
  "  out = R('init-stop-gate.js').lastAssistantText({ transcript_path: file });",
  "} else if (kind === 'sediment') {",
  "  const m = R('guard-sediment-sweep.js');",
  "  let entries;",
  "  if (m.readTurnEntries) entries = m.readTurnEntries(file, m.isRealUserPrompt);",
  "  else { entries = []; for (const l of fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean)) { try { entries.push(JSON.parse(l)); } catch {} } }",
  "  out = turnOf(entries, m.isRealUserPrompt).map((e) => e.type + ':' + (e.message ? JSON.stringify(e.message.content).slice(0, 40) : ''));",
  "} else if (kind === 'segment') {",
  "  const size = fs.statSync(file).size; const tail = Number(process.argv[5]);",
  "  const seg = R('learn-reflect.js').readSegment(file, { byte: size - tail, line: 100 });",
  "  out = { from: seg.fromByte, to: seg.toByte, lines: seg.toLine - seg.fromLine + 1, user: seg.hasUser };",
  "}",
  "process.stdout.write(JSON.stringify({ out, rssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));",
].join('\n'));
function probe(kind, file, heapMb, extra) {
  const args = (heapMb ? ['--max-old-space-size=' + heapMb] : []).concat([PROBE, D, kind, file]).concat(extra || []);
  // TEMP／TMP 指到暫存目錄：guard-required-skill 的增量記錄寫在 os.tmpdir()，跟著暫存目錄一起清
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, env: Object.assign({}, process.env, { CLAUDECODE: '', TEMP: W, TMP: W, TMPDIR: W }) });
  let out = null, rssMb = -1;
  try { const j = JSON.parse(r.stdout); out = j.out; rssMb = j.rssMb; } catch {}
  const oom = /heap out of memory|Allocation failed/i.test(r.stderr || '');
  return { ok: r.status === 0 && out !== null, out, rssMb, oom, err: (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200) };
}

// ── 等價組：合成 transcript，長列讓分塊邊界切在中文字元與列中間 ──
function writeRows(name, rows, trailingNewline) {
  const f = path.join(W, name);
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (trailingNewline === false ? '' : '\n'));
  return f;
}
const eqRows = [user('早先的問題'), skillUse('toolu_1', 'alpha'), toolRes('ok', 'toolu_1'), filler(1500000), user('最後一問' + '字'.repeat(1400000)),
  filler(1700000), skillUse('toolu_2', 'beta:gamma'), toolRes('ok', 'toolu_2'), filler(900000), asst('最後回覆')];
const eqFile = writeRows('eq.jsonl', eqRows);
const eqNoNl = writeRows('eq-nonl.jsonl', eqRows, false);
const refEntries = (f) => { const a = []; for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch {} } return a; };
const isUser = (e) => !!e && e.type === 'user' && !(Array.isArray(e.message.content) && e.message.content.some((b) => b && b.type === 'tool_result'));
try {
  const lib = require(path.join(D, 'learn-lib.js'));
  for (const f of [eqFile, eqNoNl]) {
    const tag = f === eqFile ? '' : '（檔尾無換行）';
    if (typeof lib.readLineBatches !== 'function') { check(false, 'learn-lib.readLineBatches 存在' + tag, '沒有匯出 readLineBatches'); continue; }
    const got = []; let batches = 0;
    lib.readLineBatches(f, (b) => { batches++; got.push(...b); });
    const ref = fs.readFileSync(f, 'utf8').split('\n');
    if (ref[ref.length - 1] === '') ref.pop();
    check(JSON.stringify(got) === JSON.stringify(ref) && batches > 1, 'learn-lib.readLineBatches 等於整檔 split' + tag, `行數 ${got.length}／${ref.length}，分 ${batches} 塊`);
  }
  const rs = require(path.join(D, 'guard-required-skill.js'));
  if (rs.loadedSkillsFromFile) {
    const a = [...rs.loadedSkills(fs.readFileSync(eqFile, 'utf8'))].sort(), b = [...rs.loadedSkillsFromFile(eqFile)].sort();
    check(JSON.stringify(a) === JSON.stringify(b) && b.includes('alpha') && b.includes('gamma'), 'guard-required-skill 檔案版等於字串版', JSON.stringify(b));
  } else check(false, 'guard-required-skill 檔案版等於字串版', '沒有 loadedSkillsFromFile');
  const sed = require(path.join(D, 'guard-sediment-sweep.js'));
  if (sed.readTurnEntries) {
    for (const f of [eqFile, eqNoNl]) {
      const tail = sed.readTurnEntries(f, sed.isRealUserPrompt), all = refEntries(f);
      let s = -1; for (let i = all.length - 1; i >= 0; i--) if (sed.isRealUserPrompt(all[i])) { s = i; break; }
      check(JSON.stringify(tail) === JSON.stringify(all.slice(s)) && isUser(tail[0]), 'guard-sediment-sweep.readTurnEntries 等於整檔尾段' + (f === eqFile ? '' : '（檔尾無換行）'), `列數 ${tail.length}`);
    }
    const none = writeRows('nouser.jsonl', [asst('a'), toolRes('r'), asst('b')]);
    check(JSON.stringify(sed.readTurnEntries(none, sed.isRealUserPrompt)) === JSON.stringify(refEntries(none)), 'readTurnEntries 沒有使用者訊息時回整份', '3 列');
    const capped = sed.readTurnEntries(eqFile, sed.isRealUserPrompt, 4 * 1024 * 1024);
    check(capped.length > 0 && capped.length < refEntries(eqFile).length && !isUser(capped[0]), 'readTurnEntries 超過上限只回已讀到的尾段', `列數 ${capped.length}`);
  } else check(false, 'guard-sediment-sweep.readTurnEntries 存在', '沒有 readTurnEntries');
  const ig = require(path.join(D, 'init-stop-gate.js'));
  check(ig.lastAssistantText({ transcript_path: eqFile }) === '最後回覆', 'init-stop-gate.lastAssistantText 取到本回合最後回覆', '');
} catch (e) {
  check(false, '等價組', 'throw ' + e.message);
}

// ── 記憶體組：80 MB transcript，子程序 64 MB heap ──
const big = path.join(W, 'big.jsonl');
{
  const fd = fs.openSync(big, 'w');
  const line = JSON.stringify({ type: 'x-filler', data: 'a'.repeat(60000) }) + '\n';
  const n = Math.ceil(80 * 1024 * 1024 / line.length);
  fs.writeSync(fd, JSON.stringify(user('很早的問題')) + '\n' + JSON.stringify(skillUse('toolu_1', 'alpha')) + '\n' + JSON.stringify(toolRes('ok', 'toolu_1')) + '\n');
  for (let i = 0; i < n; i++) fs.writeSync(fd, line);
  fs.writeSync(fd, JSON.stringify(user('最後一問')) + '\n' + JSON.stringify(asst('最後回覆')) + '\n');
  fs.closeSync(fd);
}
const HEAP = 64;
const mem = (label, kind, okFn, extra) => {
  const r = probe(kind, big, HEAP, extra);
  check(r.ok && okFn(r.out), label, r.ok ? 'out=' + JSON.stringify(r.out).slice(0, 120) : (r.oom ? 'heap out of memory' : 'exit≠0 ' + r.err));
};
mem('80 MB／64 MB heap：learn-lib 分塊讀行', 'lines', (o) => o.last === '最後回覆');
mem('80 MB／64 MB heap：guard-required-skill 掃已載入 skill', 'skills', (o) => Array.isArray(o) && o.includes('alpha'));
// 增量讀（2026-11-11）：第二次掃只讀追加的兩列＋指紋 8 KB，不重讀 80 MB
{
  const inc = path.join(W, 'big-inc.jsonl');
  fs.copyFileSync(big, inc);
  const r = probe('skillsinc', inc, HEAP);
  check(r.ok && r.out && Array.isArray(r.out.skills) && r.out.skills.includes('alpha') && r.out.skills.includes('gamma') && r.out.bytes < 1024 * 1024,
    '80 MB：guard-required-skill 追加後再掃只讀新增部分（<1 MB）且含新舊 skill', r.ok ? JSON.stringify(r.out) : (r.oom ? 'heap out of memory' : 'exit≠0 ' + r.err));
  try { fs.unlinkSync(inc); } catch {}
}
mem('80 MB／64 MB heap：compact-handoff.buildDigest', 'digest', (o) => o === 'has-tail');
mem('80 MB／64 MB heap：compact-snapshot.scan', 'snapshot', (o) => o === 'has-prompt');
mem('80 MB／64 MB heap：init-stop-gate 取本回合最後回覆', 'stopgate', (o) => o === '最後回覆');
mem('80 MB／64 MB heap：guard-sediment-sweep 本回合切片', 'sediment', (o) => Array.isArray(o) && o.length === 1 && o[0].startsWith('assistant:'));
// learn-reflect：水位線在檔尾附近時只讀之後的位元組。整檔讀成 Buffer 不佔 heap、不會 OOM，
// 所以另看進程峰值 RSS（2026-11-11 實測：新 43 MB、舊 124 MB）
{
  const tailBytes = Buffer.byteLength(JSON.stringify(user('最後一問')) + '\n' + JSON.stringify(asst('最後回覆')) + '\n');
  const r = probe('segment', big, HEAP, [String(tailBytes)]);
  const size = fs.statSync(big).size;
  check(r.ok && r.out.from === size - tailBytes && r.out.to === size && r.out.lines === 2 && r.out.user === true && r.rssMb > 0 && r.rssMb < 100,
    '80 MB／64 MB heap：learn-reflect.readSegment 只讀水位線之後（峰值 RSS < 100 MB）', r.ok ? JSON.stringify(r.out) + ' peakRSS=' + r.rssMb + 'MB' : r.err);
}

try { fs.rmSync(W, { recursive: true, force: true }); } catch {}
console.log(`transcript-io：PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
