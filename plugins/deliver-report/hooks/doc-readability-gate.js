#!/usr/bin/env node
/**
 * doc-readability-gate — deliver-report plugin 的 Stop hook
 *
 * 目的：把 references/document-readability.md 的鐵則中「機器判得準」的那幾條，
 *       做成交付前的最後一道機械閘。純 prompt 規範擋不住——實證：該文件寫完
 *       鐵則 8「修完一類要全文重掃」之後，作者接著又在同一批文件犯了三次同類問題。
 *
 * 判得準（會擋）：
 *   鐵則 3  編號連續性：缺號、小數點式編號（四之二）
 *   鐵則 4  未定義代號：§N / #N / 字母-數字 / S,V 編號，且全文無定義句
 *   鐵則 5  異動紀錄用語：本次查核／本文件初版／原文件／改版／第 N 輪
 *   鐵則 8  交叉引用失效：見第N節／見步驟X 指不到
 *   鐵則 9  樣式一致性：同級標題字級不一、主標小於子標、⚠※◆ 樣式分歧
 *   鐵則 9d 表格窄欄塞長字（<1500 dxa 放 >10 字，會擠成直排）
 *
 * 判不準（只提醒，不擋）：
 *   鐵則 1 兩邊對照 / 2 資訊放一起 / 6 能自查卻丟給讀者 / 10 該腳本化
 *   鐵則 13 內部推導痕跡：同一個金額在「折後 320,000」要擋、在「總價 320,000」是
 *              必要欄位，正則分不出——誤判會訓練使用者忽略警告，比漏抓難補救
 *   鐵則 14 公文式敬稱：中文沒有詞邊界，「貴司」命中「貴司機」、「本中心」命中
 *              「成本中心」（ERP/會計標準名詞）、「本司」命中「本司法/本司令」。
 *              實測全組 19 條、28 個誘餌全部誤判，逐條加負向前瞻是打地鼠
 *              （對「本司」加了兩次排除仍漏「本司令」）。故**掃描但只提醒、不擋**
 *
 * 觸發條件：本回合（最後一則使用者輸入之後的區段）有調用 deliver-report skill 才啟動。
 *   ——不是「session 動過 docx」。舊版用後者，導致改過文件之後每一句話都跑檢查、
 *   連跟文件無關的對話都被擋。交付檢查該綁「交付動作」，不是綁「檔案存在」。
 *
 * ★ 最高原則：FAIL-OPEN。任何讀檔失敗、解析例外、判斷不確定 → 一律放行。
 *   這 hook 會影響 session 能不能結束，寧可漏擋，絕不卡死。
 * ★ 不設擋下次數上限：觸發條件已收窄成「本回合調用過本 skill」，
 *   每次交付都該檢查。舊版的「擋 2 次就放行」會讓第三次交付沒人把關。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let stdinData = '';
process.stdin.on('data', (c) => (stdinData += c));
process.stdin.on('end', () => {
  try { main(stdinData); } catch (_) { allow(); }
});

function allow() { process.exit(0); }
function writeThenExit(obj) {
  let json;
  try { json = JSON.stringify(obj); } catch (_) { return allow(); }
  try { process.stdout.write(json, () => process.exit(0)); } catch (_) { allow(); }
}
function block(reason) { writeThenExit({ decision: 'block', reason }); }
function warn(msg) { writeThenExit({ systemMessage: msg }); }
const NL = String.fromCharCode(10);   // 避免以工具寫檔時跳脫序列被寫成字面值

function main(raw) {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return allow(); }

  const cwd = payload.cwd || process.cwd();

  // 只在「本回合調用過 deliver-report skill」時才啟動。
  // 判不出來（沒有 transcript_path、讀檔失敗、解析失敗）一律放行。
  if (calledSkillThisTurn(payload.transcript_path) !== true) return allow();

  const docs = recentDocx(cwd);
  if (!docs.length) return allow();

  let findings = [];    // 擋下用
  let advisories = [];  // 只提醒用
  for (const d of docs) {
    let r;
    // docx 走原本的 scan（段落 <20 視為不像交付文件）；確認清單 md 走 scanFile（多驗標題編號連續）
    try { r = d.toLowerCase().endsWith('.docx') ? scan(d) : scanFile(d); } catch (_) { continue; }   // 單檔失敗 → 略過該檔
    if (!r) continue;
    const name = path.basename(d);
    if (r.bad && r.bad.length) findings.push({ file: name, items: r.bad });
    if (r.notes && r.notes.length) advisories.push({ file: name, items: r.notes });
  }

  // 沒有硬缺陷時：有提醒就 warn（不擋），否則直接放行。
  // 為什麼分流：誤判會訓練使用者忽略警告，比漏抓更難補救——所以判不準的只提醒。
  if (!findings.length) {
    if (!advisories.length) return allow();
    const w = ['【交付前提醒】以下是判不準的項目，請自行確認（不影響結束）：', ''];
    for (const a of advisories) {
      w.push(`■ ${a.file}`);
      for (const it of a.items) w.push(`   · ${it}`);
      w.push('');
    }
    return warn(w.join(NL));
  }

  const lines = [];
  lines.push('【交付前機械閘】文件易讀性檢查未通過，請修正後再結束：');
  lines.push('');
  for (const f of findings) {
    lines.push(`■ ${f.file}`);
    for (const it of f.items) lines.push(`   · ${it}`);
    lines.push('');
  }
  if (advisories.length) {
    lines.push('另有判不準的提醒（不擋，請自行確認）：');
    for (const a of advisories) {
      for (const it of a.items) lines.push(`   · ${a.file}：${it}`);
    }
    lines.push('');
  }
  lines.push('依據：deliver-report plugin 的 references/document-readability.md');
  lines.push('');
  lines.push('機器判不了、需你自己確認的四條：');
  lines.push('  1 讀者是否要兩邊對照才能做完一件事？');
  lines.push('  2 同一項要改的東西是否散在正文與備註兩處？');
  lines.push('  6 有沒有「待確認」其實你自己查得到？');
  lines.push(' 10 有沒有機械性步驟該寫成腳本而不是叫人手動做？');
  block(lines.join('\n'));
}

// ---------- 掃描判準（共用模組，check-before skill 也用同一份）----------
const { scan, scanFile } = require('./lib/readability-scan.core.js');


// 本 plugin 中「會產出交付文件」的 skill 名單。
// deliver-report 產交付訊息、test-report-docx 產報告 DOCX、to-checklist 產確認清單（md 原稿＋PDF）。
// daily-report 不列：它的日報寫在家目錄、不在 cwd，且寄送腳本自有 content_guard 硬閘。
// ⚠ 這裡曾經是 indexOf('deliver-report') 的子字串比對——skill 一旦改名或新增，
//   閘門會靜默失效（看起來還在，實際沒守）。改成明確清單，新增 skill 請一併加進來。
const GATED_SKILLS = ['deliver-report', 'test-report-docx', 'to-checklist'];

// skill 名可能帶 plugin 前綴（如 'deliver-report:test-report-docx'），
// 故用「結尾比對或完全相等」而非寬鬆子字串。
function isGatedSkill(name) {
  return GATED_SKILLS.some((n) => name === n || name.endsWith(':' + n) || name.endsWith('/' + n));
}

// ---------- 找出這個 session 動過的 .docx ----------
function calledSkillThisTurn(tp) {
  // 回傳 true = 本回合確實調用了 deliver-report skill；
  //       false = 確實沒有；null = 判不出來（呼叫端一律放行）。
  if (!tp) return null;
  let raw;
  try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return null; }

  const lines = raw.split('\n');
  // 由後往前找最後一則「真正的使用者輸入」——那是本回合的起點，之後的行都算本回合。
  //
  // ★ 切回合用行位置，不能拿 promptId 去比對 assistant 行。實測本機 transcript
  //   （2026-09-15，Claude Code 2.x）：**assistant 行沒有 promptId 欄位**——
  //   65 個 tool_use 全部沒有，只有工具回傳所在的 user 行有。舊版用
  //   `o.promptId !== pid` 過濾，結果一個 tool_use 都抓不到，本 hook 形同沒作用；
  //   而語法檢查與靜態掃描全部會過——只有實跑抓得到。
  //
  // 起點判準見 isUserPromptLine()（三個條件缺一不可，各有實測重現的失效案例）。
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (isUserPromptLine(o)) { start = i; break; }
  }
  if (start < 0) return null;

  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    // 先用字串快篩，避免每行都 JSON.parse（transcript 可達數十 MB）
    if (!GATED_SKILLS.some((n) => l.indexOf(n) !== -1)) continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;   // 合法 JSON 的 null/字串/數字：防 TypeError
    if (o.isSidechain === true) continue;   // subagent 的呼叫不算本回合
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use' && b.name === 'Skill' &&
          b.input && typeof b.input.skill === 'string' &&
          isGatedSkill(b.input.skill)) {
        return true;
      }
    }
  }
  return false;
}

function recentDocx(cwd) {
  const out = [];
  const mds = [];   // checklist-*.md 另外計數，不佔 docx 的 4 份額度（docx 的挑選結果必須與舊版相同）
  const seen = new Set();
  const cutoff = Date.now() - 6 * 3600 * 1000;   // 6 小時內改過的
  const dirs = [cwd, path.join(cwd, '_work'), path.join(cwd, 'docs'), path.join(cwd, 'output')];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      const ln = n.toLowerCase();
      // docx，或 to-checklist 的原稿 checklist-*.md（只認這個檔名，避免 README 之類的 md 被誤擋）
      if (!ln.endsWith('.docx') && !(ln.startsWith('checklist-') && ln.endsWith('.md'))) continue;
      if (n.startsWith('~$')) continue;              // Word 暫存檔
      const p = path.join(dir, n);
      if (seen.has(p)) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff && st.size > 0) { (ln.endsWith('.md') ? mds : out).push(p); seen.add(p); }
      } catch (_) { /* 略過 */ }
    }
  }
  return out.slice(0, 4).concat(mds.slice(0, 2));   // docx 最多 4 份（同舊版）、md 另計最多 2 份，避免逾時
}


// ---------- 擋次計數 ----------

/**
 * 這一行是不是「真正的使用者輸入」＝ 本回合的起點。
 *
 * 三個條件都不可少（2026-09-15 對抗審查後補強，三項皆已實測重現）：
 *   1. type==='user' 且有 promptId
 *   2. **沒有 toolUseResult 這個「欄位」**——用 `in` 判存在，不能用 `!o.toolUseResult`
 *      判真假值：實測 `toolUseResult: null` 的工具回傳行會被假值判定誤當成使用者輸入，
 *      於是起點落在工具回傳上，本回合前半段的 tool_use 全被漏掉。
 *   3. **不是 sidechain**——subagent 的 user 行若當上起點，主線的 tool_use 會被切在
 *      起點之前而漏掉。收集階段跳過 isSidechain 還不夠，起點搜尋也要排除。
 *
 * 另外對 o 做完整防護：transcript 裡若出現一行合法 JSON 的 `null`（或字串、陣列），
 * `o.type` 會直接拋 TypeError。雖然外層 try/catch 會接住而 fail-open（exit 0），
 * 但那代表**這支閘從該行起靜默停止檢查**——正是本 plugin 最想避免的失效形狀。
 */
function isUserPromptLine(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.type !== 'user' || !o.promptId) return false;
  if ('toolUseResult' in o) return false;
  if (o.isSidechain === true) return false;
  return true;
}
