#!/usr/bin/env node
// Stop：/harness:init 進行中卻宣稱「裝好了」時擋下。
//
// 接線：本 plugin 的 hooks/hooks.json（Stop）。不複製進實例——只在跑 init 的那段期間有意義。
//
// 只在這四件事同時成立時擋：
//   ① 找得到 init 狀態檔 .claude/harness/.init-state.json（從 CLAUDE_PROJECT_DIR 與 payload 的 cwd 往上找）
//   ② 狀態不是 done／aborted（init-flow.js done 或 abort 之後一律放行），而且最後一筆紀錄在 24 小時內
//      （做到一半關掉、沒 abort 的舊狀態檔不再擋；改由本 plugin 的 SessionStart 提醒有未完成的 init）
//   ③ 已經到 Phase 4（生成）以後——之前還沒有東西可以「裝好」，盤點時跑 npm ci 這類「依賴安裝完成」最容易誤擋
//   ④ 本回合最後一則助理文字宣稱 init 完成（「安裝完成」「裝好了」「init 完成」「setup is complete」這類），
//      且那一句不是否定、未來式、疑問句，也不是在講依賴套件
// 訪談中一般的回合結束（問完一題等回答、核對表送出）不擋——那些話不會講「裝好了」。
// 同一個 Phase 連續擋 3 次後放行並在 stderr 警告（防無限迴圈；次數記在狀態檔的 gateBlocks，advance 時歸零）。
//
// fail-open：讀檔、解析出錯一律放行，stderr 印錯。
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BLOCKS = 3;
const STALE_MS = 24 * 3600 * 1000;
const MIN_PHASE = 4;
// 宣稱完成的寫法。刻意寫窄：「核對完成」「盤點完成」這類階段性完成不算，只認講「裝／安裝／init／harness」整體完成的說法
const CLAIM = /(安裝|裝設)(已經|已)?(完成|完畢|好了)|(已經|已|都|全部)裝好|裝好了|裝完了|(init|harness)\s*(已經|已)?\s*(安裝|裝)?\s*(完成|裝好|結束)|\b(setup|installation|install|harness|init)\b.{0,24}\b(is |was |has been )?(complete|completed|done|finished)\b/i;
// 同一句裡有這些字＝否定、未來式或條件句，或點名某個 Phase 的階段性進度，不算宣稱。
// 已知極限：「hook 都裝好了」這種只講一部分、又沒點名 Phase 的進度句仍會被當宣稱（每個 Phase 最多誤擋 3 次後放行）。
const NOT_CLAIM = /未|尚未|還沒|沒有|不算|無法|不能|之後|以後|才|會|將|等.{0,8}(完成|好)|完成前|完成後|完成度|後[，,、 ]|後再|嗎|？|\?|依賴|套件|相依|npm|pip|node_modules|解析器|plugin|Phase\s*\d|第\s*\d\s*(個)?(階段|步)|階段\s*\d|\b(not|never|yet|will|once|after|before)\b/i;

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function findState(dirs) {
  for (const d0 of dirs) {
    if (!d0) continue;
    let d = path.resolve(d0);
    for (let i = 0; i < 40; i++) {
      const p = path.join(d, '.claude', 'harness', '.init-state.json');
      if (fs.existsSync(p)) return p;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}
function isRealUser(e) {
  if (!e || e.type !== 'user' || !e.message) return false;
  const c = e.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  return !c.some((b) => b && b.type === 'tool_result') && c.some((b) => b && b.type === 'text');
}

// 本回合（最後一則真正的使用者訊息之後）最後一則有文字的助理訊息
function lastAssistantText(input) {
  if (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) return input.last_assistant_message;
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return '';
  const lines = fs.readFileSync(tp, 'utf8').split('\n');
  const entries = [];
  for (const l of lines) { if (!l.trim()) continue; try { entries.push(JSON.parse(l)); } catch {} }
  let lastUser = -1;
  entries.forEach((e, i) => { if (isRealUser(e)) lastUser = i; });
  for (let i = entries.length - 1; i > lastUser; i--) {
    const e = entries[i];
    if (e && e.type === 'assistant' && e.message) {
      const t = textOf(e.message.content);
      if (t.trim()) return t;
    }
  }
  return '';
}

function claimsDone(text) {
  // 逗號也切：「harness 已裝好，之後每次 commit 會…」的後半句有「會」，整句判會把前半句的宣稱放過
  for (const s of String(text).split(/[。！!\n，,；;]+/)) {
    if (CLAIM.test(s) && !NOT_CLAIM.test(s)) return s.trim();
  }
  return null;
}

try {
  const input = readInput();
  const sp = findState([process.env.CLAUDE_PROJECT_DIR, input.cwd]);
  if (!sp) process.exit(0);
  let state;
  try { state = JSON.parse(fs.readFileSync(sp, 'utf8')); }
  catch (e) { process.stderr.write(`[init-stop-gate] ERROR: 狀態檔讀不懂，放行（${sp}：${e.message}）\n`); process.exit(0); }
  if (!state || state.status === 'done' || state.status === 'aborted') process.exit(0);
  if (Number(state.phase) < MIN_PHASE) process.exit(0);
  const hist = Array.isArray(state.history) ? state.history : [];
  // 過期看最後一筆「真的有在做事」的紀錄：本 hook 自己寫的 gate-block 不算，否則每擋一次就把期限往後延
  const work = hist.filter((h) => h && h.event !== 'gate-block');
  const last = work.length ? Date.parse(work[work.length - 1].at) : NaN;
  if (Number.isFinite(last) && Date.now() - last > STALE_MS) process.exit(0);   // 過期的狀態檔：開場提醒接手，不再擋
  const said = claimsDone(lastAssistantText(input));
  if (!said) process.exit(0);
  const blocks = Number(state.gateBlocks || 0);
  if (blocks >= MAX_BLOCKS) {
    process.stderr.write(`[init-stop-gate] 已連續擋 ${blocks} 次，這次放行；init 狀態檔仍顯示未完成（Phase ${state.phase}）。\n`);
    process.exit(0);
  }
  state.gateBlocks = blocks + 1;
  (state.history = state.history || []).push({ at: new Date().toISOString(), event: 'gate-block', phase: state.phase, note: said.slice(0, 80) });
  try {
    const tmp = sp + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sp);
  } catch (e) {
    // 計數寫不進去就沒有「連擋 3 次放行」的出口，擋下去可能永遠出不來：放行
    process.stderr.write(`[init-stop-gate] ERROR: 狀態檔寫不進去，放行（${sp}：${e && e.message}）\n`);
    process.exit(0);
  }
  const flow = path.join(__dirname, '..', 'skills', 'init', 'scripts', 'init-flow.js');
  const target = state.target || path.dirname(path.dirname(path.dirname(sp)));
  const reason = `[harness init] 你說「${said.slice(0, 60)}」，但 init 狀態檔顯示還在 Phase ${state.phase}（狀態 ${state.status}），還沒走完。\n`
    + `先跑 node "${flow}" status "${target}" 看下一步缺什麼，照它補完；全部做完要跑 init-flow.js done 才算裝好。\n`
    + `使用者要中止的話跑 node "${flow}" abort "${target}" --reason "<理由>"。`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
} catch (e) {
  process.stderr.write(`[init-stop-gate] ERROR: ${e && e.message}（放行）\n`);
  process.exit(0);
}
