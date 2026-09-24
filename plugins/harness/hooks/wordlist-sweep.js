#!/usr/bin/env node
// PreToolUse(Skill)：骨架改動 commit 前的「污染詞表維護」表態閘（引擎側，只在改 harness plugin 本身時觸發）。
//
// 為什麼要有：污染詞表（skills/init/pollution-wordlist.txt）是黑名單，只擋已知的詞，
// 而且它本身就是來源專案的技術棧指紋。從新的實例回收條款進骨架時，新的來源專案詞不會自己進表——
// 改骨架的那個 session 正是最可能漏想的人。純紀律（健檢清單）30 天才跑一次，
// 而污染一旦發布就進了別人的實例。所以綁在「改了骨架要 commit」這個時機，形狀仿沉澱閘：
//   - 放行條件＝git-commit 的 args 帶 `詞表=<答案>` 表態（答「無」零成本，漏答才擋；只驗有沒有表態，不判內容對錯）
//   - 同時把已知詞的命中列出來（機械部分），讓表態有東西可對照
//   - 答案進 transcript，使用者當場可否決
// 觸發範圍：staged 檔含 plugins/harness/skills/init/references/、plugins/harness/hooks/templates/、
//   或詞表本身。其他 repo、其他改動一律直接放行——所以裝了 harness plugin 的一般專案不會被這支擋到。
// fail-open：任何例外放行但印錯。
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const SKELETON_RE = /(^|\/)plugins\/harness\/(skills\/init\/(references\/|pollution-wordlist\.txt)|hooks\/templates\/)/;

function loadWordlist() {
  const p = path.join(__dirname, '..', 'skills', 'init', 'pollution-wordlist.txt');
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  const input = JSON.parse(raw || '{}');
  const ti = input.tool_input || {};
  const skill = String(ti.skill || ti.command || '').split(':').pop();
  if (skill !== 'git-commit') process.exit(0);

  const args = String(ti.args || '');
  if (/詞表\s*[=＝:：]\s*[^\s，,；;]+/.test(args)) process.exit(0);

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let staged = '';
  try {
    staged = execSync('git diff --cached --name-only', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { process.exit(0); } // 不是 git repo → 不管
  const files = staged.split('\n').map((x) => x.trim()).filter((f) => f && SKELETON_RE.test(f));
  if (files.length === 0) process.exit(0);

  // 機械部分：已知詞在 staged 內容中的命中（詞表檔本身跳過——它必然命中每個詞）。
  const words = loadWordlist();
  const re = new RegExp(words.join('|'), 'i');
  const hits = [];
  for (const f of files) {
    if (/pollution-wordlist\.txt$/.test(f)) continue;
    let content = '';
    try {
      // 檔名以參數陣列傳給 git、不經 shell：檔名含 $(…)／反引號時不會被當成指令執行
      content = execFileSync('git', ['show', ':' + f], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch { continue; } // 刪除的檔
    content.split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) hits.push(`  ${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }

  console.error(
    [
      '[wordlist-sweep] 本次 staged 含 harness 骨架檔，commit 前先回答污染詞表維護題：',
      '',
      ...files.slice(0, 15).map((f) => `  - ${f}`),
      files.length > 15 ? `  …共 ${files.length} 檔` : '',
      '',
      '題目：這次改動有沒有從某個專案實例帶進新的專案特徵詞（業務名詞、系統代號、專屬腳本名、port、技術棧名）？',
      '  有 → 補進 plugins/harness/skills/init/pollution-wordlist.txt，並把骨架裡的該詞參數化或刪除；',
      '  無 → 照實答無。',
      '',
      hits.length
        ? `已知詞命中（${hits.length} 處；changelog 出處標註可保留，其餘要清）：\n${hits.slice(0, 30).join('\n')}${hits.length > 30 ? '\n  …' : ''}`
        : '已知詞命中：0 處（注意：0 只代表沒有「已知」的詞，新詞要靠你自己判斷）。',
      '',
      '答完後重新呼叫 git-commit skill，args 帶表態，形狀：',
      '  詞表=無',
      '  詞表=已補3詞',
      '（答案內容不檢查，漏答才擋。答案會留在 transcript，使用者可否決。）',
    ].filter((x) => x !== '').join('\n')
  );
  process.exit(2);
} catch (e) {
  console.log(`[wordlist-sweep] ERROR: hook 故障——${e.message}（放行，但 hook 鏽蝕要修，勿靜默忽略）`);
  process.exit(0);
}
