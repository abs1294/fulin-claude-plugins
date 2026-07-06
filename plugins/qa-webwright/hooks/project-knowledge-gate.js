#!/usr/bin/env node
/**
 * project-knowledge-gate — qa-webwright plugin 的 PreToolUse hook（專案知識層硬擋）。
 *
 * 目的：SKILL.md 的「tests/Project_Detail/PROJECT.md 存在就必先讀」是 prompt 規範，擋不住；
 *       bootstrap 的 PROJECT-KNOWLEDGE 訊號是資訊，也擋不住。本 hook 在瀏覽器工具（matcher 限定）
 *       被呼叫、而 transcript 看不到 PROJECT.md 被讀過時，deny 該次呼叫並要求先讀——
 *       把「沒帶專案知識就開瀏覽器」擋在第一下。
 *
 * 機制：PreToolUse stdout 輸出
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 *    "permissionDecisionReason":"..."}}
 *   會擋下該次工具呼叫，reason 餵給模型（模型讀完 PROJECT.md 再呼叫即放行）。
 *
 * ★ 設計原則（對齊 qa-landing-gate）：
 *   - FAIL-OPEN：任何讀寫失敗 / 解析失敗 / 不確定 → 放行，絕不因 hook 自身問題卡死工具流程。
 *   - 硬擋計數上限 2：讀取偵測若失效（transcript 格式變動等），最多 deny 2 次即永久放行，
 *     不會無限迴圈；計數任何異常 → 當已達上限放行。
 *   - 通過即落 pass marker：之後的瀏覽器呼叫零成本放行（不再掃 transcript）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DENIES = 2;

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try {
    main(stdinData);
  } catch (_) {
    process.exit(0); // 任何未預期例外 → 放行
  }
});

function allow() {
  process.exit(0);
}

function markPass(marker) {
  try {
    fs.writeFileSync(marker, 'pass');
  } catch (_) {}
}

function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return allow();
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sid = (input.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

  let marker;
  try {
    marker = path.join(os.tmpdir(), `qa-pk-gate-${sid}`);
  } catch (_) {
    return allow();
  }

  // 已通過（或已達 deny 上限）→ 零成本放行
  let state = '';
  try {
    if (fs.existsSync(marker)) state = fs.readFileSync(marker, 'utf8').trim();
  } catch (_) {
    return allow();
  }
  if (state === 'pass') return allow();

  // 專案沒有知識層入口 → 本 session 永久放行（missing 的建檔建議由 bootstrap 訊號負責）
  const projectMd = path.join(cwd, 'tests', 'Project_Detail', 'PROJECT.md');
  try {
    if (!fs.existsSync(projectMd)) {
      markPass(marker);
      return allow();
    }
  } catch (_) {
    return allow();
  }

  // 掃 transcript 找「讀過 PROJECT.md」的證據：Read / Bash 工具呼叫行同時提及
  // Project_Detail 與 PROJECT.md。逐行掃、找到即停；任何失敗 → 放行（FAIL-OPEN）。
  // ★ 掃描範圍 = transcript_path 本檔 + 同名資料夾下 subagents/*.jsonl（對齊 qa-landing-gate）：
  //   新流程瀏覽器測試由 qa-engineer sub-agent 執行，它讀 PROJECT.md 的證據可能記在
  //   subagent transcript；hook 拿到的 transcript_path 也可能是主檔——兩種都要看到。
  let read = false;
  try {
    const tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow();
    const sources = [tp];
    try {
      const subDir = path.join(path.dirname(tp), path.basename(tp).replace(/\.jsonl$/i, ''), 'subagents');
      if (fs.existsSync(subDir)) {
        for (const e of fs.readdirSync(subDir)) {
          if (/\.jsonl$/i.test(e)) sources.push(path.join(subDir, e));
        }
      }
    } catch (_) {} // subagent 來源推導失敗 → 只掃主檔
    outer: for (const src of sources) {
      let content;
      try {
        content = fs.readFileSync(src, 'utf8');
      } catch (_) {
        continue; // 這個來源讀不到，試下一個
      }
      for (const line of content.split('\n')) {
        if (!line.includes('PROJECT.md') || !line.includes('Project_Detail')) continue;
        if (line.includes('"name":"Read"') || line.includes('"name":"Bash"')) {
          read = true;
          break outer;
        }
      }
    }
  } catch (_) {
    return allow();
  }

  if (read) {
    markPass(marker);
    return allow();
  }

  // 未讀 → deny（計數上限內）。計數讀寫任何異常 → 當已達上限放行。
  let denies = 0;
  try {
    denies = parseInt(state, 10) || 0;
  } catch (_) {
    return allow();
  }
  if (denies >= MAX_DENIES) {
    markPass(marker);
    return allow();
  }
  try {
    fs.writeFileSync(marker, String(denies + 1));
  } catch (_) {
    return allow(); // 計數寫不進去就別擋——否則每次都 deny，違反上限保證
  }

  const reason =
    '本專案有 QA 知識層：tests/Project_Detail/PROJECT.md（路由中心）。' +
    '操作瀏覽器測試前必須先用 Read 完整讀它，再依其路由表按需讀分層檔（環境啟動、UI 操作鐵則、測試設計知識）。' +
    '讀完後重新呼叫本工具即放行。';

  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
      () => process.exit(0)
    );
  } catch (_) {
    process.exit(0);
  }
}
