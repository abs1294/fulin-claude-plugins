#!/usr/bin/env node
/**
 * qa-early-nudge — qa-webwright plugin 的 PostToolUse hook（早期提醒）。
 *
 * 目的：他律只在 Stop 生效太晚——曾發生「99 次 playwright 呼叫打完、context 將滿才可能被擋」，
 *       只能逼重工、不能防浪費。這個 hook 在**第一次用瀏覽器工具、且尚未 scaffold（tests/e2e 不存在）**時，
 *       注入一句提示引導先走 qa-flow.sh bootstrap 落地流程，把浪費擋在發生前。
 *
 * 注入機制（官方文件證實）：PostToolUse 的 stdout
 *   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}
 *   會被當 system reminder 餵給模型讀。
 *
 * ★ 設計原則：
 *   - remind-once：以 session_id 為鍵在 tmpdir 放 marker，已提醒過即刻退出（避免每次瀏覽器呼叫的延遲稅）。
 *   - FAIL-OPEN / 零干擾：任何失敗、已提醒、已 scaffold → 靜默 exit 0（無輸出，不影響工具流程）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try {
    main(stdinData);
  } catch (_) {
    process.exit(0); // 任何未預期例外 → 靜默放行
  }
});

function silent() {
  process.exit(0);
}

function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return silent();
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sid = (input.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

  // remind-once：這個 session 已提醒過就退。marker 檢查/建立任何失敗 → 靜默退（寧可少提醒）。
  let marker;
  try {
    marker = path.join(os.tmpdir(), `qa-early-nudge-${sid}.done`);
  } catch (_) {
    return silent();
  }
  try {
    if (fs.existsSync(marker)) return silent();
  } catch (_) {
    return silent();
  }

  // cwd 本身不存在 = 環境異常（非「使用者還沒 scaffold」）→ 靜默不提醒。
  try {
    if (!cwd || !fs.existsSync(cwd)) return silent();
  } catch (_) {
    return silent();
  }
  // 已 scaffold（tests/e2e 存在）→ 已在落地流程上，不需提醒。
  // 存在性檢查失敗 → 保守靜默（不硬提醒）。
  let e2eExists;
  try {
    e2eExists = fs.existsSync(path.join(cwd, 'tests', 'e2e'));
  } catch (_) {
    return silent();
  }
  if (e2eExists) return silent();

  // 到這裡：用了瀏覽器工具（matcher 已限定）+ 尚未 scaffold + 本 session 未提醒過 → 提醒一次。
  // 先寫 marker（寫失敗也照樣提醒這一次，只是可能下次再提醒——無害）。
  try {
    fs.writeFileSync(marker, '1');
  } catch (_) {}

  const msg =
    '偵測到瀏覽器操作，但這個工作目錄尚未建立 tests/e2e/ 落地骨架。' +
    '若你正在做功能 QA（要留下可重跑的測試），請先走 qa-webwright 的 qa-flow.sh bootstrap → scaffold，' +
    '把每個檢查點沉澱成 pytest；否則測完無法沉澱、下次得整套重來。若只是瀏覽網頁 / 查資料可忽略。';

  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
      }),
      () => process.exit(0)
    );
  } catch (_) {
    process.exit(0);
  }
}
