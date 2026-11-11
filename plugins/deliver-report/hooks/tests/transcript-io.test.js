#!/usr/bin/env node
/**
 * 讀 transcript 不得整份讀成字串的回歸測試（2026-11-11）——跑法：node hooks/tests/transcript-io.test.js
 *
 * Why：Stop 時 6 支 hook 各把整份 transcript 讀成字串；360 MB 的 transcript 每支峰值約 1.1 GB，
 * 同時跑就「FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory」（使用者回報五則）。
 *
 * 等價組：合成 transcript（長列讓 4 MB 分塊邊界切在中文字元與列中間），lib/transcript-io.js 的讀法
 *   等於「整檔 split → 往回找起點 → 切到尾」；readLineBatches 等於整檔 split。
 * 記憶體組：80 MB transcript，子程序限 64 MB heap 跑每支 Stop hook，要正常結束、該擋的照擋：
 *   attach-handback（本回合最後回覆叫使用者自己拖附件）、upload-count（跨回合：前面上傳過、
 *   80 MB 之後這回合改內文沒帶附件——要掃整個 session 的那條路）。整份讀的舊版在這裡 heap out of memory。
 * 驗舊版：DR_HOOKS=<舊版 hooks 目錄>。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.resolve(process.env.DR_HOOKS || path.join(__dirname, '..'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-tio-'));
let pass = 0, fail = 0;
function check(ok, label, detail) {
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  → ' + detail));
}

let pid = 0;
const prompt = (text) => ({ type: 'user', promptId: 'p' + (++pid), message: { role: 'user', content: text } });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: content || 'ok' }] } });
const filler = (n) => ({ type: 'x-filler', data: '中'.repeat(n) });
const writeRows = (name, rows, nl) => { const f = path.join(W, name); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (nl === false ? '' : '\n')); return f; };

// ── 等價組 ──
console.log('=== 讀法等價 ===');
let TIO = null;
try { TIO = require(path.join(HOOKS, 'lib', 'transcript-io.js')); } catch (e) { check(false, 'lib/transcript-io.js 存在', e.message); }
if (TIO) {
  const isP = (o) => !!(o && o.type === 'user' && o.promptId && !('toolUseResult' in o));
  const rows = [prompt('早先'), say('a'), filler(1500000), prompt('最後一問' + '字'.repeat(1400000)), filler(1700000), say('最後回覆')];
  for (const [name, nl] of [['eq.jsonl', true], ['eq-nonl.jsonl', false]]) {
    const f = writeRows(name, rows, nl);
    const all = fs.readFileSync(f, 'utf8').split('\n');
    let st = -1;
    for (let i = all.length - 1; i >= 0; i--) { let o; try { o = JSON.parse(all[i]); } catch (_) { continue; } if (isP(o)) { st = i; break; } }
    const got = TIO.readTurnLines(f, isP);
    const tag = nl ? '' : '（檔尾無換行）';
    check(JSON.stringify(got) === JSON.stringify(all.slice(st)) && st > 0, 'readTurnLines 等於整檔 split 後從起點切到尾' + tag, (got ? got.length : got) + '／' + (all.length - st));
    const lb = []; let batches = 0;
    TIO.readLineBatches(f, (b) => { batches++; lb.push(...b); });
    const ref = all[all.length - 1] === '' ? all.slice(0, -1) : all;
    check(JSON.stringify(lb) === JSON.stringify(ref) && batches > 1, 'readLineBatches 等於整檔 split' + tag, lb.length + '／' + ref.length + '，' + batches + ' 塊');
  }
  const none = writeRows('none.jsonl', [say('x'), filler(10), say('y')]);
  check(JSON.stringify(TIO.readTurnLines(none, isP)) === JSON.stringify(fs.readFileSync(none, 'utf8').split('\n')), 'readTurnLines 沒有起點時回整份', '');
  const capped = writeRows('cap.jsonl', [prompt('q'), filler(3000000), filler(3000000)]);
  check(TIO.readTurnLines(capped, isP, 5 * 1024 * 1024) === null, 'readTurnLines 往回超過上限還沒找到起點回 null（呼叫端放行）', '');
}

// ── 記憶體組 ──
console.log('=== 80 MB transcript／64 MB heap ===');
const LIST2 = '<div dir="ltr">附件 2 份：<br><ol><li>a.docx — 報告</li><li>b.xlsx — 時程</li></ol></div>';
const NAV = 'https://mail.google.com/mail/?authuser=x#all?compose=thread-f:18796%2Bmsg-a:r-555';
function big(name, headRows, tailRows) {
  const f = path.join(W, name);
  const fd = fs.openSync(f, 'w');
  for (const r of headRows) fs.writeSync(fd, JSON.stringify(r) + '\n');
  const line = JSON.stringify({ type: 'x-filler', data: 'a'.repeat(60000) }) + '\n';
  for (let i = 0, n = Math.ceil(80 * 1024 * 1024 / line.length); i < n; i++) fs.writeSync(fd, line);
  for (const r of tailRows) fs.writeSync(fd, JSON.stringify(r) + '\n');
  fs.closeSync(fd);
  return f;
}
// 峰值 RSS：preload 在子程序結束時寫出 maxRSS。整份讀的舊版在 64 MB heap 下多半不會 OOM（大字串不算在 old space），
// 只看 OOM 會漏掉，所以另設峰值上限（2026-11-11 實測見 RSS_MAX 註解）
const PRELOAD = path.join(W, 'rss.js');
fs.writeFileSync(PRELOAD, "process.on('exit',()=>{try{require('fs').writeFileSync(process.env.RSS_OUT,String(Math.round(process.resourceUsage().maxRSS/1024)))}catch(e){}});");
function runHook(hook, tp) {
  const home = fs.mkdtempSync(path.join(W, 'home-'));
  const rssOut = path.join(home, 'rss.txt');
  const r = spawnSync(process.execPath, ['--max-old-space-size=64', '-r', PRELOAD, path.join(HOOKS, hook + '.js')], {
    input: JSON.stringify({ session_id: 'dr-tio', transcript_path: tp, cwd: W, hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8', timeout: 180000,
    env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home, TEMP: home, TMP: home, DR_VISUAL_GATE_STATE: path.join(home, 'vg.json'), RSS_OUT: rssOut }) });
  let rssMb = -1; try { rssMb = Number(fs.readFileSync(rssOut, 'utf8')); } catch (_) { /* 沒寫出＝異常結束 */ }
  let out = null; try { out = r.stdout ? JSON.parse(r.stdout) : {}; } catch (_) { out = { raw: r.stdout }; }
  const oom = /heap out of memory|Allocation failed/i.test(r.stderr || '');
  return { code: r.status, out, oom, rssMb, err: (r.stderr || '').split('\n').filter(Boolean).slice(-1).join('').slice(0, 160) };
}
const RSS_MAX = Number(process.env.DR_RSS_MAX || 150);   // 2026-11-11 實測（80 MB transcript）：新版 47～49 MB、舊版整份讀 284～285 MB（upload-count 舊版 heap out of memory）
const quiet = big('quiet.jsonl', [prompt('很早的問題'), say('早先回覆')], [prompt('最後一問'), say('好了')]);
for (const h of ['doc-readability-gate', 'visual-view-gate', 'daily-report-chain-gate', 'gmail-draft-link-gate', 'attach-handback-gate', 'upload-count-gate']) {
  const r = runHook(h, quiet);
  check(r.code === 0 && !r.oom && !(r.out && r.out.decision) && r.rssMb > 0 && r.rssMb < RSS_MAX, h + '：正常結束、放行、峰值 RSS < ' + RSS_MAX + ' MB', r.oom ? 'heap out of memory' : JSON.stringify(r));
}
{
  const f = big('attach.jsonl', [prompt('很早的問題')], [prompt('回信'), call('t1', 'Bash', {}), result('t1'), say('草稿已建好。\n附件為空，等使用者自行拖入三檔：a.sql、b.py、CHANGELOG.md。')]);
  const r = runHook('attach-handback-gate', f);
  check(r.code === 0 && r.out && r.out.decision === 'block', 'attach-handback-gate：本回合叫使用者自己拖附件照擋', r.oom ? 'heap out of memory' : JSON.stringify(r).slice(0, 200));
}
{
  const head = [prompt('寫回信'), call('d1', 'mcp__claude_ai_Gmail__create_draft', { htmlBody: LIST2 }), result('d1', JSON.stringify({ id: 'r-555', threadId: 't' })),
    prompt('附檔'), call('n1', 'mcp__claude-in-chrome__navigate', { url: NAV, tabId: 1 }), result('n1'),
    call('u1', 'mcp__claude-in-chrome__file_upload', { paths: ['C:\\out\\a.docx', 'C:\\out\\b.xlsx'], ref: 'ref_1', tabId: 1 }), result('u1')];
  const tail = [prompt('改一下內文'), call('w2', 'mcp__claude_ai_Gmail__update_draft', { draftId: 'r-555', htmlBody: LIST2 }), result('w2'), say('改好了')];
  const f = big('upload.jsonl', head, tail);
  const r = runHook('upload-count-gate', f);
  check(r.code === 0 && r.out && r.out.decision === 'block' && /清掉/.test(r.out.reason || ''), 'upload-count-gate：80 MB 前上傳、這回合改內文清掉附件照擋（掃整個 session）', r.oom ? 'heap out of memory' : JSON.stringify(r).slice(0, 200));
}

try { fs.rmSync(W, { recursive: true, force: true }); } catch (_) { /* 清不掉不影響結果 */ }
console.log(pass + ' passed, ' + fail + ' failed' + (process.env.DR_HOOKS ? '（' + HOOKS + '）' : ''));
process.exit(fail ? 1 : 0);
