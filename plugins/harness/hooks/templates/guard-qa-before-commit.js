#!/usr/bin/env node
// PreToolUse(Skill)：行為類改動 commit 前的 QA 表態提早提醒（另含選配的本機覆寫夾帶檢查）。
//
// 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治。
// 前提：目標專案有裝 git-commit plugin（commit 走 Skill "git-commit"，底層是它的 flow.sh）。沒裝就不要接這支。
// 接線（目標專案 .claude/settings.json）——只接 Skill：
//   "PreToolUse": [{ "matcher": "Skill", "hooks": [{ "type": "command",
//     "command": "node \"<專案絕對路徑>/.claude/hooks/guard-qa-before-commit.js\"", "timeout": 30 }] }]
//
// 病灶：pipeline 明訂「行為類先 QA 再 review」，但兩軌 review 都 PASS 時 commit 流程會自動往下走，
// QA 從未被派的改動照樣上線——審查者甚至寫了「沒加自動化測試」仍判 PASS。
// 靜態審查看不出跑起來才會出的錯；這套機制讓「沒 QA」從靜默變成必須表態。
//
// 分工：權威檢查在 git-commit 的 flow.sh（git-commit 0.11.0 以上＋專案有 `.claude/qa-gate.conf`，由 /harness:init 產生）——
// `flow.sh review-record` 自己看該 repo 的 staged，有行為類檔卻沒帶 `--qa "已QA…"`／`--qa "分流例外…"` 就拒絕記錄，
// 而 ship 沒有審查紀錄一律拒絕，所以不論從 skill 還是直接用 Bash 跑 flow.sh 都繞不過。
// 這支只是在呼叫 git-commit skill 之前提早提醒：staged 有行為類檔、args 沒帶 --qa-verified／--no-qa 就先擋下要求表態，
// 免得走到 review-record 才被 flow.sh 退回。表態（args 與 --qa 的值）同時進 transcript，使用者當場可否決。
// 只擋「staged diff 真的含行為類檔」的情形；純文件／設定／測試資產不擋。
// 每一輪 commit 都驗（不設 marker）——每個 commit 的 diff 都不同，一次表態不能覆蓋後續 commit。
//
// 為什麼不在 Bash 層攔：hook 只看得到指令文字，flow.sh 可以經函式、變數、陣列、source、Invoke-Expression、
// 字串拼接等方式間接呼叫，靜態分析原理上補不完；在 flow.sh 裡面檢查，不論怎麼呼叫到它都會被查。
//
// 本機覆寫夾帶檢查（CHECK_OVERRIDES，跟本機覆寫保護一起裝；預設關）：staged 裡混進
// `.claude/local-overrides.yml` 列的本機覆寫檔（本地連線字串、mock 開關、測試憑證…）就擋。
// 來源專案實際發生過 `git add -A` 把本機 hack 整檔混進 staged。權威檢查同樣在 flow.sh
// （qa-gate.conf 的 block_staged_overrides=1，review-record 拒絕記錄）；這裡是 skill 入口的提早提醒。
// 刻意不在這裡重寫 yml 解析——flow.sh 的 parse_overrides_for_repo 已處理工作樹 remote 名稱等細節，另寫一份必然漂移；
// 改呼叫 `flow.sh analyze <repo>`，讀它本來就會印的 `<檔> [STAGED, in overrides]` 標記。
// 副作用：analyze 會在 `.claude/` 建 `.git-commit-tmp/`、清單不存在時從範本建 local-overrides.yml（git-commit 自己也會）。
// 找不到 flow.sh 或 bash、analyze 失敗 → 這一項放行（提醒模型），不讓 hook 故障變擋路石。
//
// fail-open：hook 故障時放行但 loud 印錯，不得變成擋路石。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 要檢查 staged 的 repo（相對於專案根）。單 repo 專案＝['.']；多 repo workspace 列各 repo 資料夾名。
const REPOS = ['.'];
// 行為類副檔名（會被執行到的程式邏輯）。依 Phase 1 盤點的技術棧填，例：
//   Web 前後端：['js','ts','jsx','tsx','mjs','cjs','py','go','java','kt','cs','rb','php']＋前端框架單檔元件副檔名
//   行動 App：['swift','m','kt','java','dart']
const BEHAVIOR_EXTS = ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'go', 'java', 'kt', 'cs', 'rb', 'php'];
// 不算行為類的路徑（regex，比對 repo 內相對路徑）。測試資產本身不需要再 QA。
const EXCLUDE_PATTERNS = [/^tests?\//, /(^|\/)__tests__\//, /\.(test|spec)\.[a-z]+$/i];
// ↑ 這兩項與 `.claude/qa-gate.conf` 的 behavior_ext／exclude 是同一份盤點（init 一起填），改一邊要同步另一邊，
//   否則提早提醒與 flow.sh 的權威檢查對「什麼算行為類」判斷不一致。
// QA agent 名（訊息用）。
const QA_AGENT = 'qa-engineer';
// 本機覆寫夾帶檢查：裝了本機覆寫保護（hook-catalog 16–18）時 init 改成 true。
const CHECK_OVERRIDES = false;
// flow.sh 位置（相對專案根或絕對路徑；本機覆寫夾帶檢查用）。留空＝自動找：<專案根>/.claude/skills/git-commit/flow.sh → ~/.claude/plugins/installed_plugins.json 裡這個專案實際裝的 git-commit（專案層優先、其次使用者層）→ ~/.claude/plugins/cache 底下 git-commit 的 flow.sh（取最新修改的那支）。
const FLOW_SH = '';
// ────────────────────────────────────────────────────────────────────────────

const EXT_RE = new RegExp('\\.(' + BEHAVIOR_EXTS.join('|') + ')$', 'i');

function isBehaviorFile(f) {
  if (EXCLUDE_PATTERNS.some((re) => re.test(f))) return false;
  return EXT_RE.test(f);
}

// 放行但要讓模型知道的提醒（下一關要帶 --qa、某項檢查沒跑、hook 故障）：PreToolUse 以 exit 0 結束時，純文字 stdout 模型看不到
// （官方 hooks 文件），要包成 additionalContext（claude -p 實測 PreToolUse 的 additionalContext 會以 system reminder 送達）。
// 擋下（exit 2）時訊息走 stderr，提醒併進去，不走這裡。
function tellModel(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) + '\n');
}

function projectRoot(input) {
  // CLAUDE_PROJECT_DIR 不保證存在，退回「本檔在 <root>/.claude/hooks/」推回去；不是這個結構才用 payload 的 cwd。
  // cwd 排在後面：session 停在子目錄時 cwd 是子目錄，REPOS 會找不到 .git 而靜默放行。
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (path.basename(__dirname) === 'hooks' && path.basename(path.dirname(__dirname)) === '.claude') return path.resolve(__dirname, '..', '..');
  return (input && input.cwd) || path.resolve(__dirname, '..', '..');
}

// ── 本機覆寫夾帶檢查 ──────────────────────────────────────────────────────────
// Windows 上 PATH 裡的 `bash` 常是 WSL 的 bash.exe（實測：從 PowerShell 起的 node 叫 bash 會進 WSL 而失敗），
// flow.sh 要的是 Git Bash，所以先找 Git Bash。
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const cands = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) cands.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  try {
    const ep = execSync('git --exec-path', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // <Git>/mingw64/libexec/git-core → <Git>/bin/bash.exe
    if (ep) cands.push(path.resolve(ep, '..', '..', '..', 'bin', 'bash.exe'));
  } catch {}
  cands.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function findFlowSh(root) {
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (FLOW_SH) {
    const p = path.isAbsolute(FLOW_SH) ? FLOW_SH : path.resolve(root, FLOW_SH);
    return isFile(p) ? p : null;   // 填了就只認它：填錯要讓人看到提醒，不默默換別支
  }
  const local = path.join(root, '.claude', 'skills', 'git-commit', 'flow.sh');
  if (isFile(local)) return local;
  // 這個專案實際裝的版本：~/.claude/plugins/installed_plugins.json 裡 git-commit@… 的安裝紀錄，
  // 專案層（projectPath 等於專案根）優先，其次使用者層。cache 裡常同時留著好幾個舊版，取「最新修改」的不一定是這個專案在用的。
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const all = reg.plugins || reg;
    const norm = (p) => path.resolve(String(p || '')).toLowerCase();
    let user = null;
    for (const key of Object.keys(all)) {
      if (!/^git-commit@/.test(key)) continue;
      for (const e of [].concat(all[key] || [])) {
        const f = e && e.installPath ? path.join(e.installPath, 'skills', 'git-commit', 'flow.sh') : null;
        if (!f || !isFile(f)) continue;
        if (e.projectPath && norm(e.projectPath) === norm(root)) return f;
        if (e.scope === 'user' && !user) user = f;
      }
    }
    if (user) return user;
  } catch {}
  // 安裝紀錄讀不到才退回：~/.claude/plugins/cache/<marketplace>/git-commit/<版本>/skills/git-commit/flow.sh 取最新修改的。
  // 只在這個固定的淺層結構裡找（不遞迴掃描）。
  const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache');
  let best = null;
  try {
    for (const mk of fs.readdirSync(cache)) {
      const pdir = path.join(cache, mk, 'git-commit');
      let vers = [];
      try { vers = fs.readdirSync(pdir); } catch { continue; }
      for (const v of vers) {
        const f = path.join(pdir, v, 'skills', 'git-commit', 'flow.sh');
        try { const st = fs.statSync(f); if (st.isFile() && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs }; } catch {}
      }
    }
  } catch {}
  return best ? best.f : null;
}

// 回 { hits: [...] }（可能為空陣列）或 { error: '原因' }
function stagedOverrides(root, repo) {
  const flow = findFlowSh(root);
  if (!flow) return { error: '找不到 git-commit 的 flow.sh' + (FLOW_SH ? `（FLOW_SH 填的是 ${FLOW_SH}）` : '') };
  const bash = findBash();
  if (!bash) return { error: '找不到 Git Bash（flow.sh 要用它跑）' };
  const r = spawnSync(bash, [flow, 'analyze', repo], {
    cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  if (r.error || r.status !== 0) {
    return { error: `flow.sh analyze ${repo} 沒有正常結束（${r.error ? r.error.message : 'exit ' + r.status}）` };
  }
  const hits = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.includes('[STAGED, in overrides]')) hits.push(line.replace('[STAGED, in overrides]', '').trim());
  }
  return { hits };
}

function overrideBlockMessage(groups, howToProceed) {
  const lines = [
    '[qa-before-commit] ⛔ staged 內含 **本機覆寫清單（.claude/local-overrides.yml）上的檔**，這幾乎都是誤加：',
    '',
  ];
  for (const { repo, hits } of groups) {
    lines.push(...hits.slice(0, 20).map((f) => `  - ${repo === '.' ? '' : repo + '/'}${f}`));
    if (hits.length > 20) lines.push(`  …共 ${hits.length} 檔`);
  }
  lines.push(
    '',
    '這些檔是本機才用的設定（本地連線字串、mock 開關、測試憑證、收件人收斂…），推上去會把團隊環境改壞、或把測試憑證洩到遠端。',
    '',
    '處置二選一：',
    '  (a) 誤加 → `git restore --staged <檔>` 移出 staged 後重來；',
    '      該檔若「混有真改動」，用 `git diff` 切 hunk、`git apply --cached --recount` 只 stage 真改動那幾行，不要整檔 add。',
    '  (b) 確實要改團隊預設值 → 先跟使用者確認；' + howToProceed,
    '',
    '收據：來源專案曾因 `git add -A` 把本機覆寫整檔混進 staged。一律逐檔 prepare，不用 `git add -A`／`git add .`。',
  );
  return lines.join('\n');
}

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const ti = input.tool_input || {};
  // 只處理 Skill 入口；Bash／PowerShell 直接跑 flow.sh 的情形由 flow.sh 自己檢查（見檔頭「分工」）。
  if (input.tool_name !== 'Skill') process.exit(0);
  // plugin 安裝時 skill 名可能帶前綴（"git-commit:git-commit"），剝掉前綴再比對。
  const skill = String(ti.skill || ti.command || '').split(':').pop();
  if (skill !== 'git-commit') process.exit(0);

  const args = String(ti.args || '');
  const root = projectRoot(input);

  // 本機覆寫夾帶比「沒 QA」更嚴重，先查；而且排在 QA 表態放行之前——帶了 --qa-verified 不代表 staged 乾淨。
  const notes = [];
  const allow = (qaPassed) => {
    // 靠 --qa-verified／--no-qa 放行時提醒下一關：專案有 .claude/qa-gate.conf 時，flow.sh review-record 會強制要求 --qa
    if (qaPassed) notes.push('[qa-before-commit] 已放行 skill 入口。專案有 .claude/qa-gate.conf 時，流程裡記錄審查結果（flow.sh review-record）'
      + '那一步會由 flow.sh 強制要求 QA 表態，staged 含行為類檔卻沒帶就拒絕記錄：'
      + '--qa-verified 對應 `--qa "已QA：<報告或測試檔路徑＋綠的輸出行>"`，--no-qa 對應 `--qa "分流例外：<為何讀 code 就能確定>"`。');
    if (notes.length) tellModel(notes.join('\n'));
    process.exit(0);
  };
  if (CHECK_OVERRIDES && !/--allow-overrides|覆寫檔已確認/.test(args)) {
    const groups = [];
    for (const r of REPOS) {
      if (!fs.existsSync(path.join(path.resolve(root, r), '.git'))) continue;
      const ov = stagedOverrides(root, r);
      if (ov.error) notes.push(`[qa-before-commit] 本機覆寫夾帶檢查（${r}）這次沒跑（${ov.error}）——hook 鏽蝕要修，勿靜默忽略。`);
      else if (ov.hits.length) groups.push({ repo: r, hits: ov.hits });
    }
    if (groups.length) {
      console.error(overrideBlockMessage(groups,
        '重新呼叫 git-commit skill，args 帶 "--allow-overrides"，並在 commit 後把該筆從 .claude/local-overrides.yml 移除（否則下次又被排除）。'
        + '專案的 .claude/qa-gate.conf 設了 block_staged_overrides=1 時，flow.sh review-record 那一步也要帶 --allow-overrides "<理由>"，否則 flow.sh 拒絕記錄。'));
      process.exit(2);
    }
  }

  if (/--qa-verified|--no-qa|QA已驗|QA 已驗/.test(args)) allow(true);

  const hits = [];
  for (const r of REPOS) {
    const dir = path.resolve(root, r);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    let out = '';
    try {
      out = execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    for (const f of out.split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (isBehaviorFile(f)) hits.push(r === '.' ? f : `${r}/${f}`);
    }
  }

  if (hits.length === 0) allow(); // 無行為類 staged 檔 → 放行

  console.error(
    [
      '[qa-before-commit] 本次 staged diff 含行為類檔案，commit 前必須先回答 QA 狀態（pipeline 配套：行為類先 QA 再 review，見 04 模板五）：',
      '',
      ...hits.slice(0, 20).map((f) => `  - ${f}`),
      hits.length > 20 ? `  …共 ${hits.length} 檔` : '',
      '',
      '請在回覆中三選一明答，讓使用者可否決：',
      '  (a) 已 QA：貼出 QA 報告路徑或 codify 的測試檔路徑＋實跑綠的輸出行；',
      '  (b) 分流例外：純結構／文案／死碼等「靜態可確定等價」——一句話說明為何正確性只靠讀 code 就能確定；',
      `  (c) 尚未 QA：**不得走默許機制自動 commit** —— 依 04 模板六派 ${QA_AGENT} 實測，回來再 commit。`,
      '',
      '答完後重新呼叫 git-commit skill；判定是 (a) 或 (b) 時，args 帶 "--qa-verified" 即放行本次。',
      '（專案有 .claude/qa-gate.conf 時，flow.sh review-record 那一步要帶 --qa "已QA：…" 或 --qa "分流例外：…"，否則 flow.sh 拒絕記錄——直接用 Bash 跑 flow.sh 也一樣。）',
      ...notes,
    ].filter(Boolean).join('\n')
  );
  process.exit(2);
} catch (e) {
  tellModel(`[qa-before-commit] ERROR: hook 故障——${e.message}（放行 commit，但 hook 鏽蝕要修，勿靜默忽略）`);
  process.exit(0);
}
