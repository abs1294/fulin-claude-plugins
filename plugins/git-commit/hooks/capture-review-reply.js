#!/usr/bin/env node
// SubagentStop：把 git-commit 審查代理的回覆原文存回那個 repo，flow.sh 以它為準。
//
// 為什麼要 hook：兩軌審查在 flow.sh 外面跑，flow.sh 原本只看得到 AI 拿去 review-record 的東西——
// 收到 BLOCK 不記類別、直接 prepare --redo，腳本分不出「真的還沒送審」；極端情境也由 AI 自己用 --edge 宣稱。
// 這支在代理結束時自己抓最後一則回覆，不靠審查代理配合寫檔，也不靠主對話轉貼。
//
// 接線（本 plugin 的 hooks/hooks.json）：
//   "SubagentStop": [{ "hooks": [{ "type": "command",
//     "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/capture-review-reply.js\"", "timeout": 10 }] }]
//
// 判準（全部成立才寫檔，任何一項不成立就什麼都不做）：
//   ① 代理的派工內容（agent_transcript_path 第一則使用者訊息）有「[git-commit 審查單 gcf-<16 hex> <軌>]」
//      軌＝codex（B 軌）／reviewer（C 軌）／arbiter（極端情境仲裁）
//   ② 登記處（~/.claude/git-commit-tickets/<id>，flow.sh prepare 寫的）找得到這張審查單，
//      指向的狀態目錄名稱是 git-commit-flow，而且那個目錄目前的審查單就是這張（舊的一律不收）
//   ③ 代理種類對得上：codex／arbiter 軌要是 codex 系代理，reviewer 軌不能是 codex 系
//   ④ 回覆的第一個或最後一個非空行是結論行：codex／reviewer 軌 VERDICT: PASS|BLOCK，arbiter 軌 RULING: EDGE|GENERAL
//      （Codex 習慣把 VERDICT 放最後一行；UNAVAILABLE 或沒有結論行＝沒審完，不寫）
// 寫到 <狀態目錄>/reply-<id>-<軌>，前幾行是 ticket／track／verdict／agent_type／captured_at，接 --- 與回覆原文。
// 同一張審查單同一軌重派時以最後一次為準（覆寫）；仲裁例外，只收第一份有結論的回覆——
// 仲裁就是最終判定，判 GENERAL 後再派一次換到 EDGE 不算數。
//
// 範圍：防手滑、不防故意繞（派工不帶審查單、自己寫檔，這支擋不到）。
// fail-open：任何錯誤都靜默結束、exit 0，絕不擋住代理結束，也不輸出 decision。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TICKET_RE = /\[git-commit 審查單 (gcf-[0-9a-f]{16}) (codex|reviewer|arbiter)\]/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  }
  return '';
}

// 派工內容＝代理自己 transcript 的第一則使用者訊息；最後一則回覆在 payload 沒給時從 transcript 補。
function readTranscript(p) {
  const out = { prompt: '', lastReply: '' };
  if (!p) return out;
  const file = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    const msg = o && o.message;
    if (!msg) continue;
    if (!out.prompt && o.type === 'user') out.prompt = textOf(msg.content);
    if (o.type === 'assistant') {
      const t = textOf(msg.content);
      if (t.trim()) out.lastReply = t;
    }
  }
  return out;
}

function verdictOf(text, track) {
  // 規則要跟 flow.sh 的 verdict_line／classify_verdict 一致（結論字後面只能接空白或行尾）：
  // 這裡收、flow.sh 不收的寫法（例如「VERDICT: BLOCK.」），抓到的 BLOCK 會用原文記不進去而卡住下一輪
  const re = track === 'arbiter' ? /^RULING:\s*(EDGE|GENERAL)(?=\s|$)/ : /^VERDICT:\s*(PASS|BLOCK)(?=\s|$)/;
  const lines = String(text).replace(/\r/g, '').split('\n')
    .map((l) => l.replace(/^[\s*_#>`]+/, '').replace(/[\s*_`]+$/, ''))
    .filter((l) => l);
  if (!lines.length) return null;
  for (const l of [lines[0], lines[lines.length - 1]]) {
    const m = l.match(re);
    if (m) return m[1];
  }
  return null;
}

function readKv(file) {
  const kv = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

function main(raw) {
  const input = JSON.parse(raw);
  if (input.hook_event_name && input.hook_event_name !== 'SubagentStop') return;
  const agentType = String(input.agent_type || '');
  const tr = readTranscript(input.agent_transcript_path);
  const m = tr.prompt.match(TICKET_RE);
  if (!m) return;
  const id = m[1];
  const track = m[2];

  const isCodex = /codex/i.test(agentType);
  if ((track === 'codex' || track === 'arbiter') && !isCodex) return;
  if (track === 'reviewer' && isCodex) return;

  // flow.sh 用 bash 的 $HOME；Windows 上它可能跟 Node 的 homedir（USERPROFILE）不同，兩個都試
  const dirs = process.env.GIT_COMMIT_TICKET_DIR
    ? [process.env.GIT_COMMIT_TICKET_DIR]
    : [os.homedir(), process.env.HOME].filter(Boolean).map((h) => path.join(h, '.claude', 'git-commit-tickets'));
  const reg = dirs.map((d) => path.join(d, id)).find((f) => fs.existsSync(f));
  if (!reg) return;
  const stateDir = readKv(reg).state_dir;
  if (!stateDir || path.basename(stateDir) !== 'git-commit-flow' || !fs.existsSync(stateDir)) return;
  const cur = path.join(stateDir, 'ticket');
  if (!fs.existsSync(cur) || readKv(cur).id !== id) return;

  const reply = typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()
    ? input.last_assistant_message : tr.lastReply;
  const verdict = verdictOf(reply, track);
  if (!verdict) return;

  const out = path.join(stateDir, 'reply-' + id + '-' + track);
  if (track === 'arbiter' && fs.existsSync(out)) return;
  const body = 'ticket=' + id + '\ntrack=' + track + '\nverdict=' + verdict + '\nagent_type=' + agentType
    + '\ncaptured_at=' + new Date().toISOString() + '\n---\n' + reply + (reply.endsWith('\n') ? '' : '\n');
  const tmp = out + '.tmp' + process.pid;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, out);
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try { main(raw); } catch (e) { /* fail-open */ }
  process.exit(0);
});
