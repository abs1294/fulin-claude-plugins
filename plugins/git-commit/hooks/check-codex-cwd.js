#!/usr/bin/env node
// 攔 codex 系 subagent 派工：prompt 必須明寫「先 cd 到一個真的 git repo 目錄」。
//
// 為什麼要機械擋：codex CLI 拒絕在非 git 目錄啟動，直接回
//   Not inside a trusted directory and --skip-git-repo-check was not specified.
// 然後退出。subagent 的預設 cwd 可能不是 git repo（例如多 repo 的 workspace 根），
// 所以不指定 cd 就必死——而且死狀與「還在算」完全相同
// （只送一次 idle、無 VERDICT、程序悄悄消失），無從分辨。
//
// 接線（本 plugin 的 hooks/hooks.json）：
//   "PreToolUse": [{ "matcher": "Agent|Task", "hooks": [{ "type": "command",
//     "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/check-codex-cwd.js\"", "timeout": 10 }] }]
//
// 判準（通用版，不比對寫死的 repo 名清單）：
//   ① prompt 內須有明確的 cd 指示（`cd <path>` 字面或「先 cd 到 <path>」之類的中文敘述）
//   ② 抓出的目標路徑（相對於 payload.cwd 解析）必須存在
//   ③ 該路徑本身是 git repo，或位於某個 git repo 內（往上找得到 .git）
// 三者缺一即擋。找不到路徑本身用檔案系統就能查證，不依賴 repo 名單。
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const fs = require('fs');
  const path = require('path');
  let reason = null;
  try {
    const input = JSON.parse(raw);
    const ti = input.tool_input || {};
    const type = String(ti.subagent_type || '');

    // 只管 codex 系（codex:codex-rescue 等），其餘 agent 不受影響
    if (!/(^|:)codex/i.test(type)) { process.exit(0); }

    const prompt = String(ti.prompt || '');
    const baseCwd = String(input.cwd || process.cwd());

    // 找 cd 指示：字面 `cd <path>`（含反引號/引號包裹，中間可能夾中文「到」/「進」），
    // 或純中文「先 cd 到 <path>」。中文變體要先試，否則泛用版會把「到」/「進」本身誤判成路徑。
    // path 的取法：
    //   有成對引號（"…"、'…'、「…」、『…』、反引號）→ 取引號內整段，含空白的路徑（C:/Users/User Name/repo）靠這條；
    //   沒有引號 → 到下一個空白、引號、反引號，或全形標點（，。、；：！？（）【】）為止——
    //   中文句子常把說明括號直接接在路徑後面（「先 cd 到 C:/repo（codex exec 一律加…）」），不停就會把括號吃進路徑。
    //   沒加引號又含空白的路徑無從判斷斷點，只驗得到第一個空白前的那段：那段不存在或不在 repo 內就擋
    //   （擋下訊息提示加引號）；那段剛好是個 repo 則放行——驗到的是前綴，不是完整目標。
    const PATH_PART = '(?:"([^"\\n]+)"|\'([^\'\\n]+)\'|「([^」\\n]+)」|『([^』\\n]+)』|`([^`\\n]+)`'
      + '|([^\\s"\'`「」『』，。、；：！？（）【】]+))';
    const cdPatterns = [
      new RegExp('先\\s*cd\\s*(?:到|進)\\s*' + PATH_PART, 'i'),
      new RegExp('\\bcd\\s*(?:到|進)?\\s*' + PATH_PART, 'i'),
    ];

    let targetRaw = null;
    for (const re of cdPatterns) {
      const m = prompt.match(re);
      const hit = m && m.slice(1).find((g) => g);
      if (hit) { targetRaw = hit.trim(); break; }
    }

    if (!targetRaw) {
      reason = buildReason(type, prompt,
        '沒有找到 cd 指示。prompt 必須明寫「執行任何 codex 指令前先 cd 到 <目錄> 目錄」，並指名一個實際存在的 git repo 路徑。');
    } else {
      // 相對路徑相對於 payload.cwd 解析；絕對路徑原樣使用
      const targetPath = path.isAbsolute(targetRaw) ? targetRaw : path.resolve(baseCwd, targetRaw);

      if (!fs.existsSync(targetPath)) {
        reason = buildReason(type, prompt,
          'cd 指向的路徑「' + targetRaw + '」（解析為 ' + targetPath + '）不存在。');
      } else if (!fs.statSync(targetPath).isDirectory()) {
        // 檔案 cd 不進去，照樣必死
        reason = buildReason(type, prompt,
          'cd 指向的路徑「' + targetRaw + '」是檔案，不是目錄。');
      } else if (!isInsideGitRepo(targetPath, fs, path)) {
        reason = buildReason(type, prompt,
          'cd 指向的路徑「' + targetRaw + '」存在，但它不是 git repo、也不在任何 git repo 底下（往上找不到 .git）。');
      }
    }
  } catch (e) {
    // fail-open：自身錯誤一律放行，絕不把人鎖在無法派工的狀態
    process.exit(0);
  }

  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
  process.exit(0);
});

function isInsideGitRepo(dirPath, fs, path) {
  try {
    // 往上找 .git 直到磁碟根（path.dirname(根) === 根，迴圈必然結束）。
    // 只驗 .git 存在，不驗它是否有效——那要真的跑 git 才知道，超出本閘「用檔案系統查證」的範圍。
    let cur = dirPath;
    for (;;) {
      if (fs.existsSync(path.join(cur, '.git'))) return true;
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  } catch (e) {
    return false;
  }
}

function buildReason(type, prompt, detail) {
  return '[codex 必死坑] 派 codex 系 agent（' + type + '）的 prompt 必須明寫「執行任何 codex 指令前先 cd 到 <repo> 目錄」，' +
    '且該目錄要是一個真的 git repo。' + detail +
    '\n原因：codex 拒絕在非 git 目錄啟動，會回 "Not inside a trusted directory and --skip-git-repo-check was not specified." 直接退出；' +
    'subagent 的預設 cwd 不一定是 git repo，故不指定就必死。' +
    '死狀與「還在算」完全相同（只送 idle、無 VERDICT），曾因此白等超過 1 小時。' +
    '請在 prompt 補上 cd 指示（指向一個實際存在的 git repo 路徑；路徑含空白時用引號包住，例如 先 cd 到 "C:/Users/User Name/repo"）後重發同一個 agent，不得改派其他 agent type 繞過本檢查。' +
    '（詳見 skill git-commit SKILL.md 的 B 軌章節）';
}
