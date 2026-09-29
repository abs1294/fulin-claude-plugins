#!/usr/bin/env node
/**
 * visual-view-gate.js 單元測試：用合成的 transcript 實跑 hook（不是只測函式），檢查擋／放行。
 * 用法：node hooks/tests/visual-view-gate.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'visual-view-gate.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-vvg-'));
let pass = 0, fail = 0;

function manifest(name, n, src) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const images = [];
  for (let i = 1; i <= n; i++) images.push(path.join(dir, `page-00${i}.png`));
  const m = path.join(dir, 'visual-manifest.json');
  fs.writeFileSync(m, JSON.stringify({ file: src || path.join(tmp, name + '.pptx'), images, overview: path.join(dir, 'overview.png') }));
  return { m, images };
}
const user = (text) => ({ type: 'user', promptId: 'p1', message: { role: 'user', content: text } });
const bashResult = (text, extra = {}) => ({ type: 'user', promptId: 'p1', toolUseResult: { stdout: text },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] }, ...extra });
const read = (p, extra = {}) => ({ type: 'assistant', message: { role: 'assistant',
  content: [{ type: 'tool_use', name: 'Read', input: { file_path: p } }] }, ...extra });

function run(label, lines, expectBlock, expectCount) {
  const tp = path.join(tmp, label.replace(/\W+/g, '_') + '.jsonl');
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: tp }), encoding: 'utf8' });
  const blocked = !!(r.stdout && r.stdout.trim() && JSON.parse(r.stdout).decision === 'block');
  let ok = blocked === expectBlock && r.status === 0;
  if (ok && expectCount != null) {
    const m = JSON.parse(r.stdout).reason.match(/還有 (\d+) 張/);
    ok = !!m && Number(m[1]) === expectCount;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (blocked=${blocked}, exit=${r.status}, out=${(r.stdout || '').slice(0, 200)})`}`);
  ok ? pass++ : fail++;
}

const A = manifest('a', 3);
run('沒有視覺檢查 → 放行', [user('hi'), bashResult('檢查完成，沒問題')], false);
run('三張都看過 → 放行', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m), ...A.images.map((p) => read(p))], false);
run('少看一張 → 擋，列 1 張', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m), read(A.images[0]), read(A.images[2])], true, 1);
run('只看總覽 → 擋，列 3 張', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m), read(path.join(tmp, 'a', 'overview.png'))], true, 3);
run('清單出現之前看的不算 → 擋', [user('check'), ...A.images.map((p) => read(p)), bashResult('VISUAL_MANIFEST: ' + A.m)], true, 3);
run('上一回合看過、這回合重跑 → 擋', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m), ...A.images.map((p) => read(p)),
  user('再跑一次'), bashResult('VISUAL_MANIFEST: ' + A.m)], true, 3);

const B1 = manifest('b1', 2, path.join(tmp, 'deck.pptx'));
const B2 = manifest('b2', 2, path.join(tmp, 'deck.pptx'));
run('同一份檔跑兩次，只認最後一次', [user('check'), bashResult('VISUAL_MANIFEST: ' + B1.m), bashResult('VISUAL_MANIFEST: ' + B2.m),
  ...B2.images.map((p) => read(p))], false);

const jsonOut = JSON.stringify({ file: 'x', visual: { manifest: A.m } }, null, 2);
run('--json 輸出（路徑被跳脫）也認得 → 擋', [user('check'), bashResult(jsonOut)], true, 3);
run('--json 輸出，全看過 → 放行', [user('check'), bashResult(jsonOut), ...A.images.map((p) => read(p))], false);

run('subagent 的 Read 不算 → 擋', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m),
  ...A.images.map((p) => read(p, { isSidechain: true }))], true, 3);
run('清單檔不存在 → 放行（fail-open）', [user('check'), bashResult('VISUAL_MANIFEST: ' + path.join(tmp, 'nope', 'visual-manifest.json'))], false);
if (process.platform === 'win32') {
  run('Windows 路徑大小寫、正反斜線不同也算看過', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m),
    ...A.images.map((p) => read(p.replace(/\\/g, '/').toUpperCase()))], false);
}
run('transcript 壞行、null 行不影響判斷 → 擋', [user('check'), bashResult('VISUAL_MANIFEST: ' + A.m), null, 'x'], true, 3);

// 壞 JSON 輸入 → 放行
const bad = spawnSync('node', [HOOK], { input: '{not json', encoding: 'utf8' });
if (bad.status === 0 && !bad.stdout.trim()) { console.log('PASS  壞輸入 → 放行'); pass++; }
else { console.log('FAIL  壞輸入 → 放行'); fail++; }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
