#!/usr/bin/env node
/**
 * guard-ruler-pasted 不得整份讀 transcript 的回歸測試（2026-11-11）——跑法：node hooks/tests/transcript-tail.test.js
 *
 * Why：Stop 時整份 transcript 讀成字串，360 MB 的檔峰值約 1.1 GB；與其他 Stop hook 同時跑就
 * heap out of memory（使用者回報五則）。改成從檔尾往回讀到本回合起點（最後一則真人輸入）就停。
 *
 * 80 MB transcript（填充在前、本回合在後），子程序限 64 MB heap＋量峰值 RSS：
 *   ① 本回合跑了 ruler.js 沒貼標尺 → 照擋（exit 2）
 *   ② 跑了也貼滿 → 放行
 *   ③ 本回合沒跑標尺、但很早的回合跑過沒貼 → 放行（只看本回合）
 * 整份讀的舊版峰值約 280 MB 以上（RSS 上限擋得到）。驗舊版：WTF_HOOK=<舊版 guard-ruler-pasted.js 路徑>。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(process.env.WTF_HOOK || path.join(__dirname, '..', 'guard-ruler-pasted.js'));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wtf-tail-'));
const RSS_MAX = 150;   // 2026-11-11 實測：新版 47 MB；整份讀的舊版在 64 MB heap 下 heap out of memory
let pass = 0, fail = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  → ' + detail)); };

const human = (t) => ({ type: 'user', message: { role: 'user', content: t } });
const runRuler = (id) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'node "C:/x/skills/wtf/ruler.js" 80' } }] } });
const res = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '────┤10' }] } });
const say = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const RULER = ['─────────┤10', '───────────────────┤20', '─────────────────────────────┤30'].join('\n');

function big(name, head, tail) {
  const f = path.join(W, name);
  const fd = fs.openSync(f, 'w');
  for (const r of head) fs.writeSync(fd, JSON.stringify(r) + '\n');
  const line = JSON.stringify({ type: 'x-filler', data: 'a'.repeat(60000) }) + '\n';
  for (let i = 0, n = Math.ceil(80 * 1024 * 1024 / line.length); i < n; i++) fs.writeSync(fd, line);
  for (const r of tail) fs.writeSync(fd, JSON.stringify(r) + '\n');
  fs.closeSync(fd);
  return f;
}
const PRELOAD = path.join(W, 'rss.js');
fs.writeFileSync(PRELOAD, "process.on('exit',()=>{try{require('fs').writeFileSync(process.env.RSS_OUT,String(Math.round(process.resourceUsage().maxRSS/1024)))}catch(e){}});");
function run(tp, lastMsg) {
  const rssOut = path.join(W, 'rss-' + Math.random().toString(36).slice(2) + '.txt');
  const input = { transcript_path: tp, stop_hook_active: false };
  if (lastMsg !== undefined) input.last_assistant_message = lastMsg;
  const r = spawnSync(process.execPath, ['--max-old-space-size=64', '-r', PRELOAD, HOOK], { input: JSON.stringify(input), encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { RSS_OUT: rssOut }) });
  let rss = -1; try { rss = Number(fs.readFileSync(rssOut, 'utf8')); } catch (_) { /* 異常結束 */ }
  return { code: r.status, rss, oom: /heap out of memory|Allocation failed/i.test(r.stderr || ''), err: (r.stderr || '').slice(0, 120) };
}
const rssSeen = [];
function t(label, tp, lastMsg, wantCode) {
  const r = run(tp, lastMsg);
  rssSeen.push(r.rss);
  check(r.code === wantCode && !r.oom && r.rss > 0 && r.rss < RSS_MAX, label + '（峰值 RSS < ' + RSS_MAX + ' MB）', r.oom ? 'heap out of memory' : JSON.stringify(r));
}
const early = [human('很早的問題'), runRuler('t0'), res('t0'), say('沒貼')];
t('本回合跑了 ruler.js 沒貼標尺 → 擋', big('a.jsonl', [human('早')], [human('對齊一下'), runRuler('t1'), res('t1'), say('好了')]), '好了', 2);
t('本回合跑了也貼滿 → 放行', big('b.jsonl', [human('早')], [human('對齊一下'), runRuler('t1'), res('t1'), say(RULER)]), RULER, 0);
t('只有很早的回合跑過沒貼、本回合沒跑 → 放行', big('c.jsonl', early, [human('別的事'), say('好')]), '好', 0);

try { fs.rmSync(W, { recursive: true, force: true }); } catch (_) { /* 清不掉不影響 */ }
console.log(pass + ' passed, ' + fail + ' failed；峰值 RSS ' + rssSeen.join('／') + ' MB' + (process.env.WTF_HOOK ? '（' + HOOK + '）' : ''));
process.exit(fail ? 1 : 0);
