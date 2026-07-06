#!/usr/bin/env node
// UserPromptSubmit hook：每輪在送給模型的上下文注入一行提醒，降低 tool call XML 格式錯誤。
// 背景：模型偶爾輸出未收尾的 <invoke>/<parameter> 標籤 → 解析層退回 malformed。malformed 在解析層
// 就掛、形不成有效 tool call，PostToolUse/Stop hook 都觸發不到 → 唯一能穩定生效的是「事前提醒」。
// 輸出：UserPromptSubmit hook 印到 stdout 的文字會被當 additionalContext 注入（對使用者不可見）。

// kill-switch：旗標檔存在即整組 self-heal 靜默（使用者說「終止 self-heal」時由模型建立；「恢復」= 刪檔）。
// 檢查失敗照常提醒（fail-open）——提醒多印無害，寧可多不可斷。
try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (fs.existsSync(path.join(os.homedir(), '.claude', 'self-heal.off'))) process.exit(0);
} catch (e) {}

const REMINDER = [
  '<system-reminder>',
  '寫工具呼叫時，務必確認每個 <invoke> 與 <parameter> 標籤都正確收尾',
  '（每個開標籤都有對應的閉標籤）。長參數（JSON、多行字串、含角括號的程式碼）尤其容易漏收尾，',
  '送出前檢查一遍。寧可拆成多個小呼叫，也不要送出可能 malformed 的大呼叫。',
  '改含 JSX/HTML（含 < > 角括號）的檔時，優先用 Node 腳本做字串替換，避開工具 XML 的角括號衝突。',
  '</system-reminder>',
].join('');

process.stdout.write(REMINDER);
process.exit(0);
