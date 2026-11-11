#!/usr/bin/env node
// summary-updater: must not read the whole transcript as one string (2026-11-11).
// Run: node hooks/tests/summary-title.test.js
//
// Why: on every prompt it loaded the whole transcript to find the latest
// custom-title; a 360 MB transcript peaked at ~1.1 GB per prompt. It now reads
// backwards in chunks and stops at the first custom-title line.
//
// 80 MB transcript, child limited to 64 MB heap, peak RSS measured:
//   1. latest custom-title (far back, before the filler) equals the summary -> no append
//   2. summary changed -> one new custom-title line appended
//   3. no custom-title anywhere -> appended
// The whole-file version peaks well above the RSS cap. Old version:
//   CC_HOOK=<path to old summary-updater.js> (its lib-state.js must sit next to it).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(process.env.CC_HOOK || path.join(__dirname, '..', 'summary-updater.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-title-'));
const RSS_MAX = 150;   // 2026-11-11 measured: new 76-80 MB, whole-file version 204-205 MB
let pass = 0, fail = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  -> ' + detail)); };

const SID = 'cctitletest';
function big(name, head) {
  const f = path.join(W, name);
  const fd = fs.openSync(f, 'w');
  for (const r of head) fs.writeSync(fd, JSON.stringify(r) + '\n');
  const line = JSON.stringify({ type: 'x-filler', data: 'a'.repeat(60000) }) + '\n';
  for (let i = 0, n = Math.ceil(80 * 1024 * 1024 / line.length); i < n; i++) fs.writeSync(fd, line);
  fs.writeSync(fd, JSON.stringify({ type: 'user', message: { role: 'user', content: 'latest' } }) + '\n');
  fs.closeSync(fd);
  return f;
}
const PRELOAD = path.join(W, 'rss.js');
fs.writeFileSync(PRELOAD, "process.on('exit',()=>{try{require('fs').writeFileSync(process.env.RSS_OUT,String(Math.round(process.resourceUsage().maxRSS/1024)))}catch(e){}});");
const rssSeen = [];
function run(tp, summary) {
  const home = fs.mkdtempSync(path.join(W, 'home-'));
  const stateDir = path.join(home, '.claude', 'cc-statusline', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'claude-summary-' + SID + '.txt'), summary + '\n');
  const rssOut = path.join(home, 'rss.txt');
  const before = fs.statSync(tp).size;
  const r = spawnSync(process.execPath, ['--max-old-space-size=64', '-r', PRELOAD, HOOK], {
    input: JSON.stringify({ session_id: SID, transcript_path: tp, hook_event_name: 'UserPromptSubmit', prompt: 'hello there' }),
    encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { USERPROFILE: home, HOME: home, RSS_OUT: rssOut }) });
  let rss = -1; try { rss = Number(fs.readFileSync(rssOut, 'utf8')); } catch (_) { /* crashed */ }
  rssSeen.push(rss);
  const added = fs.readFileSync(tp).subarray(before).toString('utf8');
  return { code: r.status, rss, added, oom: /heap out of memory|Allocation failed/i.test(r.stderr || '') };
}
const title = (t) => ({ type: 'custom-title', customTitle: t, sessionId: SID });
const ok = (r) => r.code === 0 && !r.oom && r.rss > 0 && r.rss < RSS_MAX;

let r = run(big('same.jsonl', [title('old one'), title('fix the build')]), 'fix the build');
check(ok(r) && r.added === '', 'latest title equals summary -> nothing appended (peak RSS < ' + RSS_MAX + ' MB)', JSON.stringify(r).slice(0, 200));
r = run(big('changed.jsonl', [title('fix the build')]), 'ship the release');
check(ok(r) && /"customTitle":"ship the release"/.test(r.added) && r.added.split('\n').filter(Boolean).length === 1, 'summary changed -> one title appended', JSON.stringify(r).slice(0, 200));
r = run(big('none.jsonl', [{ type: 'user', message: { role: 'user', content: 'first' } }]), 'brand new');
check(ok(r) && /"customTitle":"brand new"/.test(r.added), 'no title in transcript -> appended', JSON.stringify(r).slice(0, 200));

try { fs.rmSync(W, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log(pass + ' passed, ' + fail + ' failed; peak RSS ' + rssSeen.join('/') + ' MB' + (process.env.CC_HOOK ? ' (' + HOOK + ')' : ''));
process.exit(fail ? 1 : 0);
