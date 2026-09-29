#!/usr/bin/env node
/**
 * daily-draft-gate — deliver-report plugin 的 PreToolUse hook（Gmail 建立／更新草稿之前）
 *
 * 目的：日報的 MCP 草稿路徑補上機械閘。Gmail API 與 SMTP 兩條寄送路徑都經過
 *       skills/daily-report/scripts/send_common.prepare_send（內容閘 content_guard.py＋易讀性 check_doc.js），
 *       唯獨「用 MCP 直接建 Gmail 草稿」不經過任何腳本，兩道檢查只靠 AI 自己記得跑。
 *
 * 範圍：主旨含「工作日報」的草稿（daily-report 的主旨固定是「<前綴> <日期> 工作日報」）。
 *       其他草稿（deliver-report 的交付信等）不在本閘範圍，照舊由 gmail-draft-posttool-gate 檢查。
 * 動作：把草稿內文（body，沒有就用 htmlBody 去掉標籤）寫成暫存 .md，依序跑
 *         python skills/daily-report/scripts/content_guard.py <暫存檔> --project <cwd>
 *         node   skills/check-before/scripts/check_doc.js <暫存檔>
 *       任一不過 → 拒絕這次工具呼叫（permissionDecision: deny），並附兩支腳本的輸出。
 * 失敗處理：hook 自己讀不懂輸入（格式壞掉）→ 放行，不卡住 Gmail 工具；
 *           找不到 python／腳本、腳本讀不到內容 → 拒絕（與 send_common「閘缺失就拒寄」一致）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONTENT_GUARD = path.join(ROOT, 'skills', 'daily-report', 'scripts', 'content_guard.py');
const CHECK_DOC = path.join(ROOT, 'skills', 'check-before', 'scripts', 'check_doc.js');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { main(raw); } catch (_) { process.exit(0); }
});

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }), () => process.exit(0));
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// 在 transcript 裡找這份草稿（draftId）的主旨：建立／更新草稿的回傳內容含這個 id 的那次呼叫，取它帶的 subject
function lookupSubject(tp, draftId) {
  if (!tp || !draftId) return '';
  let raw;
  try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return ''; }
  const calls = new Map();   // tool_use id → subject
  let found = '';
  for (const l of raw.split('\n')) {
    if (!l || (l.indexOf('_draft') === -1 && l.indexOf(draftId) === -1)) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    const c = o && o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'tool_use' && /Gmail__(create|update)_draft$/.test(String(b.name)) && b.input) {
        calls.set(b.id, String(b.input.subject || ''));
      }
      if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        const s = calls.get(b.tool_use_id);
        if (txt.includes(draftId) && s) found = s;   // 取最後一次帶了主旨的
      }
    }
  }
  return found;
}

function run(cmd, args, cwd) {
  // 每支 25 秒：兩支合計壓在 hooks.json 的 90 秒以內（逾時的話 PreToolUse 不會擋，等於放行）
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 25000, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { code: r.error ? (r.error.code === 'ENOENT' ? 'ENOENT' : 'ERROR') : r.status,
           out: `${r.stdout || ''}${r.stderr || ''}`.trim(), err: r.error };
}

function main(input) {
  let p;
  try { p = JSON.parse(input || '{}'); } catch (_) { return process.exit(0); }
  const ti = (p && p.tool_input) || {};
  const isUpdate = /update_draft$/.test(String(p.tool_name || ''));
  const plain = typeof ti.body === 'string' ? ti.body : '';
  const html = typeof ti.htmlBody === 'string' ? stripHtml(ti.htmlBody) : '';
  // body 與 htmlBody 都要掃：同時提供時 htmlBody 才是對方實際看到的版本
  const body = [plain, html].filter((x) => x.trim()).filter((x, i, a) => a.indexOf(x) === i).join('\n\n');

  // update_draft 是合併更新：沒帶主旨就沿用原主旨，要從本 session 的 transcript 找回這份草稿的主旨；
  // 找不到時退一步看內文本身有沒有「工作日報」
  let subject = String(ti.subject || '');
  if (!subject && isUpdate && ti.draftId) subject = lookupSubject(p.transcript_path, String(ti.draftId));
  const isDaily = /工作日報/.test(subject) || (!subject && /工作日報/.test(body));
  // 更新別的 session 建的草稿、沒帶主旨、內文也看不出是不是日報：判斷不了就擋（失敗即擋），
  // 請帶上主旨再更新一次——放行的話，只改內文的日報更新會繞過兩道閘
  if (!isDaily && isUpdate && !subject && body.trim()) {
    return deny('這次 update_draft 沒帶主旨，也找不到這份草稿原本的主旨，無法判斷是不是日報草稿。請把主旨（subject）一起帶上再更新一次。');
  }
  if (!isDaily) return process.exit(0);   // 不是日報草稿：不在本閘範圍

  if (!body.trim()) {
    if (isUpdate) return process.exit(0);   // 只改收件人等欄位、內文沿用：建立時已檢查過
    return deny('日報草稿沒有內文，不建立草稿。');
  }

  const cwd = p.cwd || process.cwd();
  const tmp = path.join(os.tmpdir(), `daily-draft-${process.pid}-${Date.now()}.md`);
  // 先算完、刪掉暫存檔，之後才決定放行或拒絕：process.exit() 不會執行 finally，
  // 在 try 裡直接 exit 會把整份日報內文留在暫存目錄
  let problems;
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    problems = evaluate(tmp, cwd);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* 略過 */ }
  }
  if (problems.length) {
    return deny('日報草稿沒過寄送前的兩道閘，已拒絕建立草稿。改好內文後再建一次：\n\n' + problems.join('\n\n'));
  }
  return process.exit(0);
}

function evaluate(tmp, cwd) {
  const problems = [];
  for (const [name, script] of [['content_guard.py', CONTENT_GUARD], ['check_doc.js', CHECK_DOC]]) {
    if (!fs.existsSync(script)) problems.push(`找不到 ${name}——對應的機械閘缺失，拒絕建立日報草稿。`);
  }
  if (problems.length) return problems;

  let guard = null;
  for (const py of ['python', 'python3', 'py']) {
    guard = run(py, [CONTENT_GUARD, tmp, '--project', cwd], cwd);
    if (guard.code !== 'ENOENT') break;
  }
  if (guard.code === 'ENOENT') problems.push('找不到 python，無法跑內容閘（content_guard.py），拒絕建立日報草稿。');
  else if (guard.code !== 0) problems.push('【內容閘未通過（AI／工具鏈字眼、憑證、個資）】\n' + guard.out.split(tmp).join('日報草稿內文'));

  const doc = run(process.execPath, [CHECK_DOC, tmp], cwd);
  if (doc.code !== 0) problems.push(`【易讀性自檢未通過（exit ${doc.code}）】\n` + doc.out.split(tmp).join('日報草稿內文'));
  return problems;
}
