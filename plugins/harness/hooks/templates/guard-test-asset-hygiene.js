#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit)：測試資產衛生閘——寫入測試檔當下跑專案的稽核工具，新增違規就把訊息推回模型。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
// 形狀目錄 E 類：專案**已有**對應的稽核工具才裝（沒有工具，這支 hook 無事可做）；
// 還沒長出工具時，init 把它寫進 05 升格協議的「可升格機械閘」清單，不裝。
// 接線（目標專案 .claude/settings.json）：
//   "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-test-asset-hygiene.js\"", "timeout": 120 }] }]
//
// 病灶：派工模板早就寫了「禁止硬編業務資料 Id／依賴外部種子資料」，但整條鏈沒有任何一點會因為硬編而擋下來——
//   派工閘只驗派工單「有沒有寫測試資料來源這幾個字」，驗不到實際寫出來的測試碼；
//   commit 前的 QA 閘把測試檔明文排除在外。結果一次全庫掃描掃出數百處阻擋類違規。
//   實際代價：兩組測試各自寫死不同的測試身分，而受測服務一次只能是一個身分——同一輪不可能兩邊都綠，
//   症狀是「自己造了資料但列表查不到」，看起來像鏈路斷了或產品缺陷，實際只是身分與種子對不上。
// 稽核工具自己的說明講得最準：「沒有強制點，規則等於不存在」。人（含 AI）不會為印出來的警告停手，只有閘會。
//
// 來源專案接了四類稽核（範本不綁工具，由 CHECKERS 填）：
//   ① 測試資料硬編（寫死代碼／直接寫業務主體表／寫死人員帳號）
//   ② 情境登記漂移（測試寫了沒登記／登記了沒測試／情境欄還是待補）
//   ③ 顯示文字定位（用畫面上的中文找元素，切語系即全數逾時）
//   ④ skip 假綠（沒資料就跳過——跑一百次一百次綠，一次都沒真的測）
//
// 為什麼掛寫入當下（PostToolUse）而不是 commit 閘：來源專案的測試目錄不受版控，測試碼永遠不會出現在
// staged diff 裡，掛在 commit 上的閘對它結構上無效——首版就是這樣設計錯的，實查後改掛寫入當下。
// 寫完立刻收到回饋，也比 commit 時才發現便宜。測試有進版控的專案同樣適用。
//
// ⚠ 稽核工具應採「基線制」（--baseline：只回報本次**新增**的違規，存量走豁免）：
//   存量不可能一次清完，全量零容忍會變成永遠告警，最後一定被忽略＝等於沒有閘。
//   存量清掉一批就重寫基線讓水位下降（只降不升）。
//   反面：基線制下「閘沉默」不代表水位是 0——曾有人把「沒有新增」讀成「乾淨」而誤報，
//   所以擋下訊息與工具說明都要寫清楚「要看真實水位，跑不帶 --baseline 的那次」。
//   init 裝這支之前，先確認專案的稽核工具有基線模式；沒有的話，cmd 要自己帶上等效的只看新增的參數。
//
// 行為：
//   · 寫入的路徑（相對專案根、正斜線）命中 TEST_FILE 才動作；其餘一律放行。
//   · 依序跑 CHECKERS 的每支指令（{file} 會換成該檔的絕對路徑，自動加引號；工作目錄＝專案根）。
//   · 任一支回非 0 → 彙整輸出＋修法寫到 stderr、exit 2：PostToolUse 擋不住已發生的寫入，
//     但 exit 2 會把訊息推回模型要它修正。不用 exit 1——非 0／2 不阻擋，等於靜默。
//   · 稽核指令本身起不來或逾時（沒有結束碼）＝工具故障，不擋，只印提醒。
//     ⚠ Windows 的 cmd.exe 對「找不到指令」也回 1，與「有違規」無法區分——init 裝之前必須先實跑一次每支 cmd。
// fail-open：解析失敗或任何例外一律放行（exit 0）＋印訊息，不讓 hook 鏽蝕變成擋路石。

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 測試檔樣式（字串 regex，比對相對專案根、正斜線的路徑；= Phase 1 盤點到的測試目錄與命名慣例）。
// 稽核工具自己所在的目錄（本來就會有違規樣本）要排除在外。
const TEST_FILE = String.raw`^(?!.*(?:^|/)tools/)(?:.*(?:^|/)(?:tests?|__tests__|spec|e2e)/.+|.*\.(?:test|spec)\.[A-Za-z]+|.*(?:^|/)test_[^/]+\.py|.*_test\.(?:go|py))$`;
// 稽核指令表（= Phase 1 盤點到的既有稽核工具，每支一列）：
//   { name: '顯示用名稱', cmd: '可含 {file} 佔位的指令（應帶基線參數）', fix: '修法說明（可多行）' }
// 預設空陣列＝不做任何稽核。
const CHECKERS = [];
// 單支稽核指令的逾時（毫秒）。
const CHECK_TIMEOUT_MS = 90000;
// 擋下訊息開頭的標籤（只影響訊息文字）。
const LABEL = 'test-asset-hygiene';
// ────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  if (!/^(Write|Edit|MultiEdit)$/.test(String(input.tool_name || ''))) process.exit(0);
  if (!CHECKERS.length) process.exit(0);

  const ti = input.tool_input || {};
  const given = String(ti.file_path || ti.path || '');
  if (!given) process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  const abs = path.resolve(input.cwd || root, given);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('../') || !new RegExp(TEST_FILE, 'i').test(rel)) process.exit(0);

  const failures = [];
  const notes = [];
  for (const c of CHECKERS) {
    if (!c || !c.cmd) continue;
    const cmd = String(c.cmd).split('{file}').join('"' + abs + '"');
    try {
      execSync(cmd, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS,
        // 工具若是 Python，Windows 預設以系統碼頁輸出，node 以 utf8 讀會變亂碼、訊息等於沒報。
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      });
    } catch (e) {
      if (typeof e.status !== 'number') {
        notes.push('稽核「' + (c.name || c.cmd) + '」沒有正常結束（' + (e.code || e.signal || e.message) + '），本次未判——工具故障要修，勿靜默忽略。');
        continue;
      }
      const out = (String(e.stdout || '') + String(e.stderr || '')).trim().split(/\r?\n/).slice(0, 30);
      failures.push({ c, cmd, code: e.status, out });
    }
  }

  if (notes.length) process.stdout.write('[' + LABEL + '] ' + notes.join('\n') + '\n');
  if (!failures.length) process.exit(0);

  const msg = ['[' + LABEL + '] 剛寫入的 ' + rel + ' 出現新增的稽核違規：', ''];
  for (const f of failures) {
    msg.push('── ' + (f.c.name || f.c.cmd) + '（結束碼 ' + f.code + '）──', '');
    msg.push(...f.out.map((l) => '  ' + l));
    msg.push('', '重跑：' + f.cmd);
    if (f.c.fix) msg.push('', ...String(f.c.fix).split('\n'));
    msg.push('');
  }
  msg.push('⚠ 稽核走基線制（只擋新增、存量豁免），所以它沉默不代表水位是 0；要看真實水位，跑不帶基線參數的那次。');
  msg.push('稽核表在 .claude/hooks/guard-test-asset-hygiene.js 的 CHECKERS；判斷是工具誤判就回報使用者，不要改測試去迎合工具的字面。');
  process.stderr.write(msg.join('\n') + '\n');
  process.exit(2);
} catch (e) {
  process.stdout.write('[' + LABEL + '] hook 故障——' + e.message + '（放行，但 hook 鏽蝕要修，勿靜默忽略）\n');
  process.exit(0);
}
