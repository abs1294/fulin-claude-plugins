#!/usr/bin/env node
// 審查者評測集：拿「已知有 bug 的歷史改動」與「已知沒問題的改動」去跑 C 軌審查者，
// 算該抓的有沒有抓到（召回）、乾淨的有沒有被誤擋（誤報）。改審查者的 prompt、規則或 agent 定義前後各跑一次，
// 分數掉了就不採用那次修改。
//
// 為什麼要有：審查者的規則檔、agent 定義改了之後，沒有任何東西證明「以前抓得到的現在還抓得到」；
// 只能等下一次事故才知道。做法是把過去的事故固定成案例，每次改完重跑。
//
// 案例放在專案自己的目錄（含客戶程式碼，不進本 plugin），一個案例一個資料夾，裡面一份 case.json：
//   {
//     "repo": "<相對 workspace 的 repo 目錄>",
//     "commit": "<修正 bug 的那顆 commit>",
//     "direction": "reverse" | "forward",   // reverse＝把修正反過來當成「引入 bug 的改動」；forward＝修正本身當乾淨案例
//     "paths": ["<只取這些路徑，選填；排除測試檔用>"],
//     "expect": {
//       "verdict": "BLOCK" | "PASS",
//       "hits": [{ "file": "<路徑結尾>", "lines": [起, 迄] }]   // BLOCK 案例：審查者的 Critical 至少要點中其中一處
//     },
//     "note": "<這個 bug 是什麼，給人看的>"
//   }
//
// 用法（在 workspace 根目錄跑）：
//   node review-eval.js build <案例根目錄>                       依 case.json 產生 case.diff 與 context/（改動後那一側的檔案全文）
//   node review-eval.js run   <案例根目錄> [--agent code-reviewer] [--model sonnet] [--only <案例名>] [--timeout-min 20]
//   node review-eval.js score <案例根目錄> [--run <結果資料夾名>]  算分；不帶 --run 取最新一次
// run 對每個案例起一個 headless 審查（claude -p --agent），回覆存到 <案例根目錄>/results/<時間>/<案例名>.txt。
// 一個案例要幾分鐘，整套跑完要半小時以上，建議背景執行。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HIT_SLACK = 5; // 行號容許誤差：審查者常指到函式開頭或相鄰一兩行

function die(msg) { process.stderr.write('ERROR: ' + msg + '\n'); process.exit(1); }

function git(repo, args, opts = {}) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) die(`git ${args.join(' ')} 失敗（${repo}）：${(r.stderr || '').trim()}`);
  return r.stdout;
}

function listCases(root, only) {
  if (!fs.existsSync(root)) die(`找不到案例根目錄：${root}`);
  const names = fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, 'case.json'))).sort();
  if (only) {
    if (!names.includes(only)) die(`沒有這個案例：${only}`);
    return [only];
  }
  if (!names.length) die(`${root} 底下沒有任何含 case.json 的案例資料夾`);
  return names;
}

function readCase(root, name) {
  const file = path.join(root, name, 'case.json');
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file} 不是合法 JSON：${e.message}`); }
  for (const k of ['repo', 'commit', 'direction', 'expect']) if (!c[k]) die(`${file} 缺 ${k}`);
  if (!['reverse', 'forward'].includes(c.direction)) die(`${file} 的 direction 只能是 reverse 或 forward`);
  if (!['BLOCK', 'PASS'].includes(c.expect.verdict)) die(`${file} 的 expect.verdict 只能是 BLOCK 或 PASS`);
  if (c.expect.verdict === 'BLOCK' && !(c.expect.hits || []).length) die(`${file} 是 BLOCK 案例，expect.hits 至少要一處`);
  for (const h of c.expect.hits || []) {
    const ok = h && typeof h.file === 'string' && h.file && Array.isArray(h.lines) && h.lines.length === 2
      && h.lines.every(Number.isInteger) && h.lines[0] <= h.lines[1];
    if (!ok) die(`${file} 的 expect.hits 每一項要是 { "file": "<路徑結尾>", "lines": [起, 迄] }（整數、起 ≤ 迄），收到：${JSON.stringify(h)}`);
  }
  return c;
}

function cmdBuild(root, opts) {
  for (const name of listCases(root, opts.only)) {
    const c = readCase(root, name);
    const repo = path.resolve(c.repo);
    const fix = git(repo, ['rev-parse', '--verify', c.commit + '^{commit}']).trim();
    const parent = git(repo, ['rev-parse', '--verify', fix + '^']).trim();
    // reverse：從修正後退回修正前＝「引入 bug」；審查者看到的上下文是有 bug 的那一側（parent）
    const [from, to] = c.direction === 'reverse' ? [fix, parent] : [parent, fix];
    const pathspec = c.paths && c.paths.length ? ['--', ...c.paths] : [];
    const diff = git(repo, ['diff', '--no-color', '--no-renames', from, to, ...pathspec]);
    if (!diff.trim()) die(`${name}：diff 是空的（commit 或 paths 寫錯？）`);
    const dir = path.join(root, name);
    fs.writeFileSync(path.join(dir, 'case.diff'), diff);
    const ctx = path.join(dir, 'context');
    fs.rmSync(ctx, { recursive: true, force: true });
    const files = git(repo, ['diff', '--name-only', '--no-renames', '--diff-filter=d', from, to, ...pathspec]).split('\n').filter(Boolean);
    for (const f of files) {
      const body = spawnSync('git', ['-C', repo, 'show', `${to}:${f}`], { maxBuffer: 256 * 1024 * 1024 });
      if (body.status !== 0) continue;
      const out = path.join(ctx, f);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, body.stdout);
    }
    console.log(`${name}：case.diff ${diff.split('\n').length} 行，context ${files.length} 個檔`);
  }
}

function reviewerPrompt(caseDir) {
  const p = caseDir.replace(/\\/g, '/');
  return [
    `請審查這份改動：${p}/case.diff（請先 cat 讀取）。本任務由你親自執行，不得再轉派給其他 agent。`,
    `需要上下文時，改動後的檔案全文在 ${p}/context/ 底下（路徑與 repo 內相同）。`,
    '不要去讀 workspace 裡各 repo 的同名檔——那是現行版本，跟這份改動不是同一個時間點，讀了會判錯。',
    '不得修改任何檔案、不得執行 git add／commit、不得起服務或跑測試。',
    '',
    '【驗收條件】',
    '- BLOCK：Critical（會壞功能或算錯資料、資安洞、違反架構原則、必錯邏輯）',
    '- PASS：沒有 Critical；Important／Minor 照列。',
    '- 極端情境不列 Critical，描述開頭標 [極端]。',
    '',
    '【回報格式】（嚴格遵守）',
    '第 1 行：`VERDICT: PASS` 或 `VERDICT: BLOCK`',
    '第 2 行起每行 `- <file>:<line> [<Critical|Important|Minor>] <短描述>`（file 寫 repo 內的相對路徑）',
    '不要分析段、標題、總結。',
  ].join('\n');
}

function cmdRun(root, opts) {
  const names = listCases(root, opts.only);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(root, 'results', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const agent = opts.agent || 'code-reviewer';
  const model = opts.model || 'sonnet';
  const timeoutMs = (Number(opts['timeout-min']) || 20) * 60 * 1000;
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({ agent, model, cases: names, started: new Date().toISOString() }, null, 2));
  for (const name of names) {
    readCase(root, name);
    const caseDir = path.resolve(root, name);
    if (!fs.existsSync(path.join(caseDir, 'case.diff'))) die(`${name} 還沒 build（缺 case.diff）`);
    const t0 = Date.now();
    // prompt 走 stdin：內容有反引號與換行，放命令列參數在 Windows 上會被 shell 拆壞
    const r = spawnSync('claude', ['-p', '--agent', agent, '--model', model], {
      input: reviewerPrompt(caseDir), encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const reply = (r.stdout || '') + (r.status === 0 ? '' : `\n[review-eval] exit ${r.status}${r.error ? ' ' + r.error.message : ''}\n${r.stderr || ''}`);
    fs.writeFileSync(path.join(outDir, name + '.txt'), reply);
    console.log(`${name}：${secs} 秒，exit ${r.status}`);
  }
  console.log(`結果：${outDir}`);
}

// 結論行規則跟 flow.sh 的 verdict_line 一致：第一個非空行是結論就取它，否則看最後一個非空行
function verdictOf(text) {
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.replace(/^[\s*_#>`]+/, '').replace(/[\s*_`]+$/, '')).filter(Boolean);
  const re = /^VERDICT:\s*(PASS|BLOCK)\b/;
  for (const l of [lines[0] || '', lines[lines.length - 1] || '']) { const m = l.match(re); if (m) return m[1]; }
  return 'NONE';
}

function findingsOf(text) {
  const out = [];
  const re = /^\s*-\s*`?([^\s:`]+):(\d+)(?:-(\d+))?`?\s*\[(Critical|Important|Minor)\]/i;
  for (const l of text.replace(/\r/g, '').split('\n')) {
    const m = l.match(re);
    if (m) out.push({ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), level: m[4][0].toUpperCase() + m[4].slice(1).toLowerCase() });
  }
  return out;
}

function hits(findings, expectHits, levels) {
  return expectHits.some(h => findings.some(f => levels.includes(f.level)
    && (f.file.endsWith(h.file) || h.file.endsWith(f.file))
    && f.line >= h.lines[0] - HIT_SLACK && f.line <= h.lines[1] + HIT_SLACK));
}

function cmdScore(root, opts) {
  const resRoot = path.join(root, 'results');
  if (!fs.existsSync(resRoot)) die('還沒有任何 run 結果');
  const run = opts.run || fs.readdirSync(resRoot).filter(n => fs.statSync(path.join(resRoot, n)).isDirectory()).sort().pop();
  const runDir = path.join(resRoot, run);
  const rows = [];
  for (const name of listCases(root)) {
    const f = path.join(runDir, name + '.txt');
    if (!fs.existsSync(f)) continue;
    const c = readCase(root, name);
    const text = fs.readFileSync(f, 'utf8');
    const v = verdictOf(text);
    const fs_ = findingsOf(text);
    let result;
    if (v === 'NONE') result = '沒有結論（沒跑完或格式不對）';
    else if (c.expect.verdict === 'BLOCK') {
      if (v === 'BLOCK' && hits(fs_, c.expect.hits, ['Critical'])) result = '抓到';
      else if (hits(fs_, c.expect.hits, ['Critical', 'Important', 'Minor'])) result = '有指出但沒擋';
      else if (v === 'BLOCK') result = '擋了但沒點中 bug';
      else result = '漏抓';
    } else result = v === 'PASS' ? '正確放行' : '誤擋';
    rows.push({ name, expect: c.expect.verdict, verdict: v, findings: fs_.length, result });
  }
  if (!rows.length) die(`${runDir} 裡沒有任何案例的回覆`);
  const bug = rows.filter(r => r.expect === 'BLOCK');
  const clean = rows.filter(r => r.expect === 'PASS');
  const summary = {
    run, recall: `${bug.filter(r => r.result === '抓到').length}/${bug.length}`,
    falseBlock: `${clean.filter(r => r.result === '誤擋').length}/${clean.length}`,
    noVerdict: rows.filter(r => r.verdict === 'NONE').length, rows,
  };
  fs.writeFileSync(path.join(runDir, 'score.json'), JSON.stringify(summary, null, 2));
  console.log(`run：${run}`);
  for (const r of rows) console.log(`  ${r.name.padEnd(28)} 預期 ${r.expect.padEnd(5)} 審查 ${r.verdict.padEnd(5)} 意見 ${String(r.findings).padStart(2)} 筆  → ${r.result}`);
  console.log(`抓到 ${summary.recall}｜誤擋 ${summary.falseBlock}｜沒有結論 ${summary.noVerdict}`);
  console.log(`明細：${path.join(runDir, 'score.json')}`);
}

function parseOpts(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(`${argv[i]} 後面缺值`);
    opts[argv[i].slice(2)] = argv[++i];
  }
  return opts;
}

if (require.main === module) {
  const [cmd, root, ...rest] = process.argv.slice(2);
  const usage = '用法：node review-eval.js build|run|score <案例根目錄> [選項]（見檔頭）';
  if (!cmd || !root) die(usage);
  const opts = parseOpts(rest);
  if (cmd === 'build') cmdBuild(root, opts);
  else if (cmd === 'run') cmdRun(root, opts);
  else if (cmd === 'score') cmdScore(root, opts);
  else die(usage);
}

module.exports = { verdictOf, findingsOf, hits };
