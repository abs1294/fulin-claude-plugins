#!/usr/bin/env node
'use strict';
/**
 * init-flow.js — /harness:init 的階段狀態機。Phase 順序與「沒過不准往下」由這支腳本檢查，不靠自律。
 *
 * 狀態檔：<目標>/.claude/harness/.init-state.json（目標＝跑 init 的 workspace 根）
 * 答案檔：<落點>/.claude/harness/init-answers.json（Q4 答完前落點＝目標；格式見 references/init-answers.schema.json）
 * 本 plugin 的 Stop hook（hooks/init-stop-gate.js）讀狀態檔：還沒 done／aborted 時擋下「安裝完成」這類宣稱。
 *
 * 用法：
 *   node init-flow.js start   <目標> [--headless] [--reference] [--resume|--restart]   Phase 0 拍完快照後跑
 *   node init-flow.js mode    <目標> normal|reference                        Phase 0-2 判定後跑
 *   node init-flow.js answer  <目標> <題號> (--file <檔> | --json - | --json '<JSON>')   每答一題跑一次
 *   node init-flow.js catalog <目標> (--file <檔> | --json - | --json '<JSON 陣列>')    形狀目錄逐列去向（Phase 4 推導完）
 *   node init-flow.js waive   <目標> <檢查 id> --match <命中內容的一段> --reason <理由>   init-verify 誤判的豁免
 *   node init-flow.js advance <目標> <N>                                      進入 Phase N 前跑（只能 +1）
 *   node init-flow.js status  <目標>                                          現在在哪、下一步缺什麼
 *   node init-flow.js abort   <目標> --reason "<理由>"                         使用者要中止
 *   node init-flow.js done    <目標>                                          Phase 6 收尾
 * 結束碼：0＝成功；1＝條件不符（印出缺什麼）；2＝用法錯誤或狀態檔不存在。
 *
 * 傳 JSON 最穩的是 --file 或 stdin（--json -）：PowerShell 5.1 傳參會剝掉雙引號、Bash 遇到單引號會截斷。
 * answer／catalog 寫入後會把解析結果印回來，請核對內容是不是你要寫的。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./init-lib.js');

const PHASES = ['前置檢查', '盤點', '攤開核對', '訪談', '生成', '驗收', '流程圖與收尾'];
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const argv = process.argv.slice(2);
const [cmd, targetArg] = argv;
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const USAGE = '用法見檔頭：node init-flow.js <start|mode|answer|catalog|advance|status|abort|done> <目標> …';
if (!cmd || !targetArg) die(USAGE);
const target = path.resolve(targetArg);
const SP = L.statePath(target);

function loadState() {
  if (!fs.existsSync(SP)) die(`找不到 init 狀態檔：${SP}\n先跑：node init-flow.js start "${target}"`);
  return L.readJson(SP);
}
function saveState(s) { L.writeJsonAtomic(SP, s); }
function log(s, event, note) { s.history.push({ at: new Date().toISOString(), event, phase: s.phase, note: note || '' }); }
function loadAnswers(s) {
  const p = L.answersPath(s.landing);
  if (fs.existsSync(p)) {
    const a = L.readJson(p);
    if (a.runId === s.runId) return a;   // 上一次 init 留下的答案檔不沿用（重裝的預設答案從備份讀）
  }
  return { version: 1, harnessVersion: L.pluginVersion(), runId: s.runId, target: s.target, landing: s.landing,
    mode: s.mode, headless: s.headless, answers: {} };
}
function saveAnswers(s, a) {
  a.mode = s.mode; a.headless = s.headless; a.target = s.target; a.landing = s.landing; a.updatedAt = new Date().toISOString();
  L.writeJsonAtomic(L.answersPath(s.landing), a);
}
function readPayload() {
  const j = opt('--json'); const f = opt('--file');
  if (j === undefined && f === undefined) die('要給 --file <檔>、--json -（從 stdin 讀）或 --json \'<JSON>\'');
  try { return JSON.parse(f !== undefined ? fs.readFileSync(f, 'utf8') : (j === '-' ? fs.readFileSync(0, 'utf8') : j)); }
  catch (e) { die('JSON 解析失敗：' + e.message, 1); }
}

// 進入 Phase n 之前，前一個 Phase 的出關條件；回傳缺項清單（空＝可以進）
function gate(s, n) {
  const miss = [];
  const land = s.landing;
  if (n === 1) {
    if (!fs.existsSync(L.snapshotPath(target)) && !fs.existsSync(L.snapshotPath(land))) {
      miss.push(`沒有 Phase 0 的快照。跑：node ${path.join(__dirname, 'check-flow-diagram.js')} snapshot "${target}"`);
    }
  }
  if (n === 4) {
    const p = L.answersPath(land);
    if (!fs.existsSync(p)) miss.push(`沒有答案檔 ${p}：訪談每答一題要跑 init-flow.js answer`);
    else {
      const a = L.readJson(p);
      if (a.runId !== s.runId) miss.push(`答案檔 ${p} 是上一次 init 留下的（runId 不同）：這次的訪談答案還沒寫進去`);
      else {
        miss.push(...L.checkAnswers(a));
        if (s.mode === 'reference') for (const id of ['Q0', 'Q8']) if (!a.answers[id]) miss.push(`參考模式要有 ${id} 的答案或跳過理由`);
      }
    }
  }
  if (n === 5) {
    if (!fs.existsSync(path.join(land, 'CLAUDE.md'))) miss.push(`落點沒有 CLAUDE.md：${land}`);
    // 參考模式下 CLAUDE.md 與 .claude/harness/ 本來就在，只看存在會永遠成立：要看這次生成真的寫過 harness 的變更紀錄
    const cl = path.join(land, '.claude', 'harness', 'CHANGELOG.md');
    const p4 = [...s.history].reverse().find((h) => h.event === 'advance' && h.phase === 4);
    if (!fs.existsSync(cl)) miss.push(`落點沒有 .claude/harness/CHANGELOG.md：Phase 4 的文件層還沒生成`);
    else if (p4 && fs.statSync(cl).mtimeMs < Date.parse(p4.at)) miss.push('.claude/harness/CHANGELOG.md 的修改時間早於進入 Phase 4 的時間：這次 init 還沒生成文件層（參考模式下舊檔一直都在）');
    const p = L.answersPath(land);
    const a = fs.existsSync(p) ? L.readJson(p) : {};
    const rows = L.catalogRows();
    if (!Array.isArray(a.hookCatalog)) miss.push('答案檔沒有 hookCatalog（形狀目錄逐列去向）：跑 init-flow.js catalog');
    else if (a.hookCatalog.length !== rows.length) miss.push(`hookCatalog 有 ${a.hookCatalog.length} 列，形狀目錄有 ${rows.length} 列`);
  }
  if (n === 6) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'init-verify.js'), land], { encoding: 'utf8' });
    if (r.status !== 0) miss.push(`init-verify.js 沒過（exit ${r.status}）：\n` + String(r.stdout || '').split('\n').filter((l) => /\| FAIL \|/.test(l)).join('\n') + (r.stderr ? '\n' + r.stderr : ''));
  }
  if (n === 7) {   // done
    // Phase 6 之後還能改答案、形狀目錄與豁免：進 Phase 6 那次的驗收不算數，done 前重跑一次
    const rv = spawnSync(process.execPath, [path.join(__dirname, 'init-verify.js'), land], { encoding: 'utf8' });
    if (rv.status !== 0) miss.push(`init-verify.js 沒過（exit ${rv.status}）：\n` + String(rv.stdout || '').split('\n').filter((l) => /\| FAIL \|/.test(l)).join('\n') + (rv.stderr ? '\n' + rv.stderr : ''));
    const hd = path.join(land, '.claude', 'harness');
    const flows = [1, 2, 3].map((i) => path.join(hd, `flow-${i}.json`)).filter((f) => fs.existsSync(f));
    const md = path.join(hd, 'flow.md');
    const diagrams = flows.length ? flows : (fs.existsSync(md) ? [md] : []);
    if (!diagrams.length) miss.push('沒有流程圖（flow-1..3.json 或 flow.md）');
    else {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'check-flow-diagram.js'), 'check', land, ...diagrams], { encoding: 'utf8' });
      if (r.status !== 0) miss.push(`流程圖完整性檢查沒過（exit ${r.status}）：\n${String(r.stdout || '').slice(-1500)}${String(r.stderr || '').slice(-500)}`);
    }
    if (!fs.existsSync(path.join(hd, 'install-report.md'))) miss.push('沒有收尾回報 .claude/harness/install-report.md');
  }
  return miss;
}

function printMiss(miss) { for (const m of miss) console.log('  - ' + m); }

if (cmd === 'start') {
  if (fs.existsSync(SP)) {
    const old = L.readJson(SP);
    if (old.status === 'running' && flag('--resume')) {
      log(old, 'resume'); saveState(old);
      console.log(`[init-flow] 接續進行中的 init：Phase ${old.phase} ${PHASES[old.phase]}。先跑 status 看下一步缺什麼。`);
      process.exit(0);
    }
    if (old.status === 'running' && !flag('--restart')) {
      die(`這個目標已有進行中的 init（Phase ${old.phase} ${PHASES[old.phase]}）。要接著做加 --resume；要從頭來加 --restart；要中止跑 abort。`, 1);
    }
  }
  const s = { version: 1, runId: 'i-' + Date.now().toString(36), target, landing: target, mode: flag('--reference') ? 'reference' : 'normal',
    headless: flag('--headless'), phase: 0, status: 'running', history: [], gateBlocks: 0 };
  log(s, 'start');
  saveState(s);
  console.log(`[init-flow] 開始：Phase 0 ${PHASES[0]}（${s.mode === 'reference' ? '參考模式' : '一般模式'}${s.headless ? '、無人值守' : ''}）。狀態檔 ${SP}`);
  console.log('注意：.claude/harness/ 裡只有 .init-state.json 這一個檔時，是本腳本剛建的，Phase 0-2 不算既有設定。');
  process.exit(0);
}

const s = loadState();

// 寫答案、形狀目錄、豁免都有固定的階段：提早寫等於在訪談或生成之前就預填，繞過階段閘
function requirePhase(min, what) {
  if (s.status !== 'running') die(`init 狀態是 ${s.status}，不能再${what}（要重來跑 start --restart）`, 1);
  if (s.phase < min) die(`還在 Phase ${s.phase}，要到 Phase ${min} ${PHASES[min]} 以後才能${what}（先跑 status 看下一步）`, 1);
}

if (cmd === 'mode') {
  const m = argv[2];
  if (!['normal', 'reference'].includes(m)) die('mode 只能是 normal 或 reference');
  if (s.status !== 'running') die(`init 狀態是 ${s.status}，不能再切模式`, 1);
  if (s.phase >= 3) die(`已經在 Phase ${s.phase}，訪談開始後不能切模式（要重來跑 start --restart）`, 1);
  s.mode = m; log(s, 'mode', m); saveState(s);
  console.log(`[init-flow] 模式：${m === 'reference' ? '參考模式' : '一般模式'}`);
  process.exit(0);
}

if (cmd === 'answer') {
  requirePhase(3, '寫訪談答案');
  const id = argv[2];
  if (!/^(Q0|U1|U2|U3|Q1|Q2|Q3|Q4|Q5|Q6|Q7|Q8|Q9|Q10|Q11|Q12)$/.test(id || '')) die('題號要是 Q0、U1～U3、Q1～Q12 其一');
  const p = readPayload();
  const entry = { asked: p.asked, date: L.today(), delegated: !!p.delegated };
  if ('answer' in p) entry.answer = p.answer;
  if (p.skipped) entry.skipped = p.skipped;
  if (p.data) entry.data = p.data;
  const schema = L.loadSchema();
  const errs = L.validate(schema.$defs.answer, entry, schema, id);
  if (!entry.skipped && !('answer' in entry)) errs.push(`${id}: 要有 answer 或 skipped`);
  const dr = L.DATA_REQUIRED[id];
  if (dr && !entry.skipped) {
    const fake = { version: 1, harnessVersion: '0.0.0', target: 'x', landing: 'x', mode: 'normal', headless: false, answers: { [id]: entry } };
    errs.push(...L.checkAnswers(fake, { requireAll: false }).filter((e) => !e.startsWith('schema ')));
  }
  if (errs.length) { console.log(`[init-flow] ${id} 沒寫入，格式不符：`); printMiss(errs); process.exit(1); }
  const ans = loadAnswers(s);
  const oldLanding = s.landing;
  if (id === 'Q4' && entry.data) {
    const nl = p.landing ? path.resolve(target, p.landing) : target;
    if (path.resolve(nl) !== path.resolve(oldLanding)) {
      s.landing = path.resolve(nl);
      log(s, 'landing', s.landing);
      try { fs.unlinkSync(L.answersPath(oldLanding)); } catch {}
    }
  }
  ans.answers[id] = entry;
  saveAnswers(s, ans);
  log(s, 'answer', id); saveState(s);
  console.log(`[init-flow] 已寫入 ${id} → ${L.answersPath(s.landing)}${s.landing !== oldLanding ? `（落點改為 ${s.landing}）` : ''}`);
  console.log('  寫入的內容（請核對）：' + JSON.stringify(entry));
  process.exit(0);
}

if (cmd === 'catalog') {
  requirePhase(3, '寫形狀目錄去向');
  const list = readPayload();
  const schema = L.loadSchema();
  const errs = L.validate(schema.properties.hookCatalog, list, schema, 'hookCatalog');
  const rows = L.catalogRows();
  if (Array.isArray(list)) {
    const seen = new Set(list.map((x) => x && x.row));
    for (const r of rows) if (!seen.has(r.row)) errs.push(`形狀目錄第 ${r.row} 列（${r.name}）沒有去向`);
    if (list.length !== rows.length) errs.push(`給了 ${list.length} 列，形狀目錄有 ${rows.length} 列`);
  }
  if (errs.length) { console.log('[init-flow] hookCatalog 沒寫入：'); printMiss(errs); process.exit(1); }
  const ans = loadAnswers(s);
  ans.hookCatalog = list;
  saveAnswers(s, ans);
  log(s, 'catalog', `${list.length} 列`); saveState(s);
  console.log(`[init-flow] 已寫入形狀目錄逐列去向 ${list.length} 列`);
  process.exit(0);
}

if (cmd === 'waive') {
  requirePhase(4, '登記 init-verify 豁免');
  const id = argv[2]; const match = opt('--match'); const reason = opt('--reason');
  if (!/^V\d\d-/.test(id || '') || !match || !reason) die('用法：waive <目標> <檢查 id，例 V07-paths> --match <命中內容的一段> --reason <為什麼是誤判>');
  if (/^V(09|10|12)-/.test(id)) die(`${id} 不可豁免（hook 語法、settings JSON、帳密樣式沒有誤判空間，要修檔）`, 1);
  const ans = loadAnswers(s);
  ans.verifyWaivers = (ans.verifyWaivers || []).filter((w) => !(w.id === id && w.match === match));
  ans.verifyWaivers.push({ id, match, reason, date: L.today() });
  saveAnswers(s, ans);
  log(s, 'waive', `${id} ${match}`); saveState(s);
  console.log(`[init-flow] 已登記豁免 ${id}「${match}」：${reason}（收尾回報要列出這筆）`);
  process.exit(0);
}

if (cmd === 'advance') {
  const n = Number(argv[2]);
  if (!Number.isInteger(n) || n < 1 || n > 6) die('advance 的 Phase 要是 1～6');
  if (s.status !== 'running') die(`init 狀態是 ${s.status}，不能再前進（要重來跑 start --restart）`, 1);
  if (n !== s.phase + 1) die(`只能依序前進：目前在 Phase ${s.phase}，下一個是 Phase ${s.phase + 1}，不能跳到 Phase ${n}`, 1);
  const miss = gate(s, n);
  if (miss.length) { console.log(`[init-flow] 還不能進 Phase ${n} ${PHASES[n]}——Phase ${s.phase} 的出關條件沒過：`); printMiss(miss); process.exit(1); }
  s.phase = n; s.gateBlocks = 0; log(s, 'advance'); saveState(s);
  console.log(`[init-flow] 進入 Phase ${n} ${PHASES[n]}。先讀 references/phases/ 底下對應的細節檔。`);
  process.exit(0);
}

if (cmd === 'status') {
  console.log(`[init-flow] 狀態 ${s.status}｜Phase ${s.phase} ${PHASES[s.phase]}｜${s.mode === 'reference' ? '參考模式' : '一般模式'}${s.headless ? '｜無人值守' : ''}`);
  console.log(`  目標 ${s.target}`);
  console.log(`  落點 ${s.landing}`);
  if (s.status === 'running') {
    const next = s.phase < 6 ? s.phase + 1 : 7;
    const miss = gate(s, next);
    console.log(next === 7 ? '  收尾（done）還缺：' : `  進 Phase ${next} ${PHASES[next]} 還缺：`);
    if (miss.length) printMiss(miss); else console.log('  （無，可以 ' + (next === 7 ? 'done' : `advance ${next}`) + '）');
  }
  process.exit(0);
}

if (cmd === 'abort') {
  const reason = opt('--reason');
  if (!reason) die('abort 要帶 --reason "<理由>"');
  if (s.status !== 'running') die(`init 狀態是 ${s.status}，不能再中止（只有進行中的 init 能 abort）`, 1);
  s.status = 'aborted'; log(s, 'abort', reason); saveState(s);
  console.log(`[init-flow] 已中止（Phase ${s.phase}）：${reason}`);
  process.exit(0);
}

if (cmd === 'done') {
  if (s.status !== 'running') die(`init 狀態是 ${s.status}，不能 done`, 1);
  if (s.phase !== 6) die(`還在 Phase ${s.phase}，要先走到 Phase 6 才能 done`, 1);
  const miss = gate(s, 7);
  if (miss.length) { console.log('[init-flow] 還不能收尾：'); printMiss(miss); process.exit(1); }
  s.status = 'done'; log(s, 'done'); saveState(s);
  console.log('[init-flow] init 完成。');
  process.exit(0);
}

die(USAGE);
