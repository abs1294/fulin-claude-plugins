#!/usr/bin/env node
// harness-kind: cli（學習迴路的確定性落地；learn-reflect.js 以 require 呼叫，也能單獨當 CLI 跑，不是 hook、不接線）
/**
 * 確定性落地（無 LLM）：反思子程序回的提案陣列 → 驗證 → 分級 → 寫入／待看／待核 → ledger、pending、升格計數。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 不必接線：learn-reflect.js 以 require('./learn-promote.js').promote(...) 呼叫。
 * CLI（測試與人工重放用）：
 *   node learn-promote.js --proposals <提案 JSON 檔> --transcript <transcript 路徑> --range <起行>-<迄行> [--run <run id>]
 *   印出落地結果 JSON；結束碼 0 成功、1 取不到鎖或寫入失敗（請重跑）、2 用法錯。
 *
 * 等級（不信模型，由 kind＋action＋目標實況判定；設計稿第 4 節）：
 *   綠＝memory 新檔（目標不存在、category 不是 correction）／知識筆記 append（單人模式）→ 驗證過就寫入
 *   黃＝memory correction、memory update 或目標已存在、知識筆記 update、團隊模式的知識筆記 append → 寫入（先備份），進「待你看」
 *   紅＝kind 是 rule／hook／agent／claude-md／settings、目標落在 CLAUDE.md／.claude/harness/0*.md／.claude/hooks/／
 *       .claude/agents/／.claude/settings*.json、或內容命中破壞性指令樣式 → 不寫入，保存 content 進「待核」
 *   拒收＝格式、帳密、注入、外洩、出處、抄原文、矛盾未調和、超量、目標不合法、寫入失敗
 *
 * 自行決定的細節（設計稿沒寫到，選風險最小的做法）：
 * - 檢查順序：超量 → 欄位形狀 → 帳密 → 注入 → 外洩 → 出處 → 抄原文 → 矛盾 → 紅區判定 → 目標 → 各類格式 → 寫入。
 *   帳密／注入／外洩／出處／抄原文／矛盾對紅區一樣拒收（這幾項關乎安全與隱私，不能進 pending.json 存著）；
 *   紅區的「各類格式」不拒收，結果附在待核項目的 checks 欄。
 * - 知識筆記 action=create 當成 append（條目只會附加；學習迴路不建知識筆記檔本身）；memory 的 append 拒收 format。
 * - 知識筆記 update 不跑條目格式檢查（content 是替換片段，不一定是完整條目）；memory update 對替換後的整份檔跑格式檢查。
 * - memory 新建（綠或黃）都在 MEMORY.md 補索引行（只補綠區的話，黃區新檔不會被自動載入，等於沒寫）。
 * - 知識筆記的變更紀錄檔不存在就不補（不建檔），在 run 帳本 notes 記一句。
 * - 「第 2 次」計數：以「主題相同或目標 memory 檔相同」為同一件事；每筆 ledger 紀錄的出處集合跟先前已計的
 *   紀錄有任何重疊就不算新的一次（同一段被重讀、或一筆提案同時引兩行，都只算一次）。設計稿寫「不同出處數」，
 *   照字面會讓一筆引兩行的提案自己就升格，這裡取較保守的算法。
 * - 同一個 run 寫同一檔兩次時，備份檔名加 `~<序號>`，不互相覆蓋。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./learn-lib.js');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 一批最多收幾筆提案（第 MAX_PROPOSALS+1 筆起拒收 over-limit）。
const MAX_PROPOSALS = 5;
// 「不抄原文」門檻：去掉反引號片段後，連續幾個字與 transcript 片段相同就拒收。
const VERBATIM_MIN = 24;
// 每筆出處線索（clue）的字數上限。
const CLUE_MAX = 160;
// ────────────────────────────────────────────────────────────────────────────

const KINDS = ['memory', 'glossary', 'flows', 'qa-knowledge', 'rule', 'hook', 'agent', 'claude-md', 'settings'];
const ACTIONS = ['create', 'append', 'update'];
const CATEGORIES = ['correction', 'workaround', 'tool-pitfall', 'fact'];
const RED_KINDS = new Set(['rule', 'hook', 'agent', 'claude-md', 'settings']);
const KNOWLEDGE = new Set(['glossary', 'flows', 'qa-knowledge']);
const QA_SECTIONS = ['操作規則', '測試坑', '設計知識'];
const STARS = { correction: '⭐⭐⭐', 'tool-pitfall': '⭐⭐', workaround: '⭐⭐', fact: '⭐' };
const REASONS = ['format', 'secret', 'injection', 'exfil', 'evidence', 'verbatim', 'conflict', 'over-limit', 'target', 'io'];

function redPath(t) {
  const s = String(t || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return /(^|\/)CLAUDE\.md$/i.test(s) || /(^|\/)\.claude\/harness\/0[^/]*\.md$/i.test(s)
    || /(^|\/)\.claude\/(hooks|agents)\//i.test(s) || /(^|\/)\.claude\/settings[^/]*\.json$/i.test(s);
}
function eolOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }

// 在 heading 那一節的最後一行內容之後插入 block；heading 為 null 時插在檔尾（檔尾若是「變更紀錄見…」行就插在它前面）
function insertBlock(text, heading, block, blankBefore) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  let start = -1, end = lines.length;
  if (heading) {
    start = lines.findIndex((l) => heading.test(l));
    if (start < 0) return null;
    for (let j = start + 1; j < lines.length; j++) if (/^## /.test(lines[j]) || /^變更紀錄見/.test(lines[j])) { end = j; break; }
  } else {
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    if (last >= 0 && /^變更紀錄見/.test(lines[last])) end = last;
  }
  let k = end;
  while (k - 1 > start && !lines[k - 1].trim()) k--;
  const ins = (blankBefore ? [''] : []).concat(block.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n'));
  const after = lines.slice(k);
  if (after.length && after[0].trim()) ins.push('');
  return lines.slice(0, k).concat(ins, after).join(eol);
}

// ── 各類格式（回傳錯誤說明陣列；空陣列＝通過）──
function checkMemory(text, name) {
  const t = String(text).replace(/\r\n/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return ['沒有 frontmatter（--- 開頭與結尾）'];
  const fm = m[1], body = m[2], errs = [];
  const nm = fm.match(/^name:\s*(.+?)\s*$/m);
  if (!nm || !/^[a-z0-9][a-z0-9-]*$/.test(nm[1]) || nm[1] !== name) errs.push('name 要是 kebab-case 且等於檔名去 .md');
  const ds = fm.match(/^description:[ \t]*(.*?)\s*$/m);
  if (!ds || !ds[1] || /^[>|]/.test(ds[1])) errs.push('description 要是非空的單行');
  const ty = fm.match(/^metadata:[ \t]*\n[ \t]+type:[ \t]*(\S+)[ \t]*$/m);
  if (!ty || !['feedback', 'project', 'reference'].includes(ty[1])) errs.push('metadata.type 要是 feedback／project／reference');
  const bl = body.split('\n');
  const wi = bl.findIndex((l) => /^\*\*Why:\*\*/.test(l));
  if (bl.filter((l) => /^\*\*Why:\*\*/.test(l)).length !== 1 || bl.filter((l) => /^\*\*How to apply:\*\*/.test(l)).length !== 1) {
    errs.push('要有 **Why:** 與 **How to apply:** 各一行');
  }
  const facts = (wi < 0 ? bl : bl.slice(0, wi)).filter((l) => l.trim()).length;
  if (facts === 0) errs.push('本體是空的');
  if (facts > 10) errs.push('本體超過 10 行');
  return errs;
}
function checkEntry(kind, content, section) {
  const L = String(content).replace(/\r\n/g, '\n').trim().split('\n');
  if (kind === 'glossary') {
    const errs = [];
    if (!/^\*\*[^*\n]+\*\*\s*$/.test(L[0])) errs.push('第一行要是 **<詞>**');
    const ai = L.findIndex((l) => /^_避免_：/.test(l));
    if (ai < 0) errs.push('要有 _避免_： 行');
    const expl = L.slice(1, ai < 0 ? L.length : ai).join('').trim();
    if (!expl) errs.push('沒有說明');
    if ((expl.match(/[。！？!?]|\.(?=\s|$)/g) || []).length > 2) errs.push('說明超過 2 句');
    return errs;
  }
  if (kind === 'flows') {
    const errs = [];
    if (!/^## 鏈 /.test(L[0])) errs.push('要以「## 鏈 」開頭');
    if (!L.some((l) => /→|->/.test(l))) errs.push('要有箭頭流向行');
    if (!L.some((l) => /^\|\s*:?-{3,}/.test(l))) errs.push('要有層表');
    return errs;
  }
  if (kind === 'qa-knowledge') {
    const errs = [];
    if (L.length !== 1 || !/^- \*\*[^*]+\*\*/.test(L[0])) errs.push('要是一行、以「- **…**」開頭的列點');
    if (!QA_SECTIONS.includes(section)) errs.push('section 要是 ' + QA_SECTIONS.join('／') + ' 其一');
    return errs;
  }
  return [];
}

function promote(o) {
  // run id 會拼進備份路徑（backups/<run>/）：只收英數與連字號，免得 ../ 之類跳出 learning/
  if (typeof o.run !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(o.run)) throw new Error('run id 只能是英數與連字號（1～64 字）：' + JSON.stringify(o.run));
  const P = lib.paths(o.root);
  lib.ensureDir(P.learn);
  const run = o.run;
  const from = o.fromLine, to = o.toLine;
  // 片段裡實際抽出的紀錄行（使用者／助理文字、工具呼叫、工具錯誤）；出處必須指到其中一行。
  // 這只擋「指到空白行、meta 行、根本沒內容的行」的假出處；那一行是否真的支持提案內容無法機械判斷（不存原文），
  // 由開場回報列出每筆綠區寫入、learn-pending revert 可還原兜底。
  const entryLines = Array.isArray(o.entryLines) ? new Set(o.entryLines) : null;
  const res = { proposals: 0, written: 0, pendingReview: 0, pendingApproval: 0, rejected: 0, promotions: 0,
    rejectReasons: Object.fromEntries(REASONS.map((r) => [r, 0])), greenWrites: [], notes: [] };
  const list = Array.isArray(o.proposals) ? o.proposals : [];
  res.proposals = list.length;
  const set = lib.shingles(o.sourceText || '', VERBATIM_MIN);
  const team = lib.isTeam(P);
  let backupSeq = 0;
  const runRollbacks = [];   // 這次已寫入且登錄的每一筆：pending.json 最後寫不進去時整批回復

  const sources = (p) => (p && Array.isArray(p.evidence) ? p.evidence.map((e) => e && e.source).filter((s) => typeof s === 'string') : []);
  const memName = (p) => String((p && p.target) || '');
  const display = (p) => {
    if (!p || typeof p !== 'object') return '';
    if (p.kind === 'memory') return 'memory/' + memName(p);
    if (KNOWLEDGE.has(p.kind)) return lib.knowledgeRel(P, p.kind);
    return String(p.target || '');
  };
  const topicOf = (p) => (p && typeof p.topic === 'string' && p.topic) || (p && p.kind === 'memory' ? memName(p).replace(/\.md$/, '') : null);
  const basenameOf = (p) => path.basename(display(p).replace(/\\/g, '/')).toLowerCase();

  lib.withLock(P.learn, 'pending.json', () => {
    const pd = lib.readJson(P.pending, lib.emptyPending());
    pd.items = pd.items || [];

    const reject = (p, cls, reason) => {
      res.rejected++; res.rejectReasons[cls] = (res.rejectReasons[cls] || 0) + 1;
      lib.appendLedger(P, { run, action: 'reject', target: display(p), level: null, result: 'ok', reason, reasonClass: cls,
        evidence: sources(p), topic: topicOf(p), item: null });
    };
    const backupName = (enc) => 'backups/' + run + '/' + enc + '~' + (++backupSeq);
    const backupOf = (abs, enc) => {
      if (!fs.existsSync(abs)) return null;
      const b = backupName(enc);
      lib.ensureDir(path.dirname(path.join(P.learn, b)));
      fs.copyFileSync(abs, path.join(P.learn, b));
      return b;
    };
    const encRel = (abs) => path.relative(P.root, abs).replace(/[\\/]/g, '__').replace(/^(\.\.__)+/, 'ext__');

    const maybePromote = (p) => {
      const topic = topicOf(p);
      const memT = p.kind === 'memory' ? display(p) : null;
      const same = (r) => (topic && r.topic === topic) || (memT && r.target === memT);
      const all = lib.readLedger(P);
      // 回復紀錄以「run＋項目編號」對應：整批回復時 pending.json 沒存，同一天下一輪會重發同樣的編號
      const rolledBack = new Set(all.filter((r) => r.action === 'rollback' && r.item).map((r) => r.run + '|' + r.item));
      const recs = all.filter((r) => ['write', 'pending-review', 'pending-approval'].includes(r.action) && same(r) && !(r.item && rolledBack.has(r.run + '|' + r.item)));
      const seen = new Set(), occ = [];
      for (const r of recs) {
        const ev = Array.isArray(r.evidence) ? r.evidence : [];
        if (!ev.length) continue;
        const overlap = ev.some((s) => seen.has(s));
        ev.forEach((s) => seen.add(s));
        if (!overlap) occ.push(ev[0]);
      }
      if (occ.length < 2) return;
      const dup = pd.items.some((it) => it.type === 'promotion' && (it.status === 'pending' || it.status === 'approved')
        && ((topic && it.topic === topic) || (memT && it.target === memT)));
      if (dup) return;
      const id = lib.nextPendingId(pd.items);
      const label = topic || memT;
      const item = { id, run, level: 'red', type: 'promotion', status: 'pending', target: memT || label, topic: topic || null,
        summary: '主題 ' + label + ' 已出現 ' + occ.length + ' 次，依 05 §6 提議升格為條款／機械閘',
        content: '最近一次的提案摘要：' + String(p.summary || ''), evidence: occ.slice(0, 2), backup: null, afterHash: null,
        createdAt: lib.nowIso(), decidedAt: null, decisionNote: null };
      pd.items.push(item);
      res.promotions++;
      lib.appendLedger(P, { run, action: 'promotion-proposal', target: item.target, level: 'red', result: 'ok', reason: item.summary,
        reasonClass: '-', evidence: item.evidence, topic: item.topic, item: id });
      runRollbacks.push({ id, target: item.target, rollback: () => {} });
    };

    try {
      list.forEach((p, idx) => {
        try {
          // 1. 超量
          if (idx >= MAX_PROPOSALS) return reject(p, 'over-limit', '一批最多 ' + MAX_PROPOSALS + ' 筆，第 ' + (idx + 1) + ' 筆起拒收');
          // 2. 欄位形狀
          if (!p || typeof p !== 'object' || Array.isArray(p)) return reject({}, 'format', '提案不是物件');
          if (!KINDS.includes(p.kind)) return reject(p, 'format', 'kind 不合法');
          if (!ACTIONS.includes(p.action)) return reject(p, 'format', 'action 不合法');
          if (typeof p.summary !== 'string' || !p.summary.trim() || p.summary.includes('\n')) return reject(p, 'format', 'summary 要是非空的一行');
          if (typeof p.content !== 'string' || !p.content.trim()) return reject(p, 'format', 'content 是空的');
          if (p.kind === 'memory' ? !CATEGORIES.includes(p.category) : (p.category !== undefined && p.category !== null && !CATEGORIES.includes(p.category))) {
            return reject(p, 'format', 'category 不合法');
          }
          if (p.topic !== undefined && p.topic !== null && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(p.topic))) return reject(p, 'format', 'topic 要是 kebab-case');
          const ev = Array.isArray(p.evidence) ? p.evidence : [];
          const clues = ev.map((e) => (e && typeof e.clue === 'string' ? e.clue : ''));
          const scanText = [p.content, p.summary, p.replaces, p.target, p.section].filter((x) => typeof x === 'string').concat(clues).join('\n');
          // 3～5. 帳密、注入、外洩
          if (lib.scanSecrets(scanText).length) return reject(p, 'secret', '命中帳密樣式');
          if (lib.scanInjection(scanText)) return reject(p, 'injection', '命中指令注入樣式');
          if (lib.scanExfil(scanText)) return reject(p, 'exfil', '命中外洩樣式');
          // 6. 出處
          if (!ev.length) return reject(p, 'evidence', '沒有出處');
          for (const e of ev) {
            const m = e && typeof e.source === 'string' && e.source.match(/^(.+\.jsonl):(\d+)$/);
            if (!m || m[1] !== o.transcriptName) return reject(p, 'evidence', '出處要是 <本次 transcript 檔名>:<行號>');
            const ln = Number(m[2]);
            if (!(ln >= from && ln <= to)) return reject(p, 'evidence', '出處行號 ' + ln + ' 不在本次讀取範圍 ' + from + '-' + to);
            if (entryLines && !entryLines.has(ln)) return reject(p, 'evidence', '出處第 ' + ln + ' 行不是使用者／助理文字、工具呼叫或工具錯誤（沒有可引用的內容）');
            if (typeof e.clue !== 'string' || !e.clue.trim() || [...e.clue].length > CLUE_MAX) return reject(p, 'evidence', 'clue 要是 1～' + CLUE_MAX + ' 字');
          }
          // 7. 抄原文
          for (const s of [p.content, p.summary].concat(clues)) {
            if (lib.hasVerbatim(s, set, VERBATIM_MIN)) return reject(p, 'verbatim', '與 transcript 片段有連續 ' + VERBATIM_MIN + ' 字以上相同');
          }
          // 8. 矛盾調和
          if (p.conflicts_with) {
            const fm = String(p.conflicts_with).match(/^(.+?\.(?:md|json|js))(?::|$)/i);
            const want = fm ? path.basename(fm[1].replace(/\\/g, '/')).toLowerCase() : null;
            const ok = want && list.some((q, j) => j !== idx && j < MAX_PROPOSALS && q && typeof q === 'object' && basenameOf(q) === want);
            if (!ok) return reject(p, 'conflict', '與 ' + p.conflicts_with + ' 矛盾，但同一批沒有改舊條款的提案');
          }
          // 9. 紅區
          const destructive = lib.scanDestructive(p.content + '\n' + p.summary);
          const targetRed = p.kind === 'memory' || RED_KINDS.has(p.kind) ? redPath(p.target) : false;
          if (RED_KINDS.has(p.kind) || targetRed || destructive) {
            let checks = null;
            if (p.kind === 'memory') checks = checkMemory(p.content, memName(p).replace(/\.md$/, ''));
            else if (KNOWLEDGE.has(p.kind) && p.action !== 'update') checks = checkEntry(p.kind, p.content, p.section);
            const id = lib.nextPendingId(pd.items);
            pd.items.push({ id, run, level: 'red', type: 'proposal', status: 'pending', kind: p.kind, action: p.action,
              target: display(p), topic: topicOf(p), category: p.category || null, summary: p.summary, content: p.content,
              replaces: typeof p.replaces === 'string' ? p.replaces : null, section: p.section || null,
              evidence: sources(p), flags: destructive ? ['destructive'] : [], checks,
              backup: null, afterHash: null, createdAt: lib.nowIso(), decidedAt: null, decisionNote: null });
            res.pendingApproval++;
            lib.appendLedger(P, { run, action: 'pending-approval', target: display(p), level: 'red', result: 'ok',
              reason: destructive ? '內容含破壞性指令樣式，升紅區待核' : '紅區目標，只進待核', reasonClass: destructive ? 'destructive' : '-',
              evidence: sources(p), topic: topicOf(p), item: id });
            runRollbacks.push({ id, target: display(p), rollback: () => {} });
            maybePromote(p);
            return;
          }

          // 10. 目標與寫入
          let level, abs, newText, encName, addedLines = [], indexInfo = null, changelogInfo = null;
          if (p.kind === 'memory') {
            const name = memName(p);
            if (!/^[a-z0-9][a-z0-9-]{0,80}\.md$/.test(name) || name.toLowerCase() === 'memory.md') return reject(p, 'target', 'memory 檔名不合法');
            let realDir;
            try { realDir = fs.realpathSync(P.memoryDir); if (!fs.statSync(realDir).isDirectory()) throw new Error('not dir'); }
            catch { return reject(p, 'target', 'memory 目錄不存在'); }
            abs = path.join(realDir, name);
            const exists = fs.existsSync(abs);
            if (exists) {
              const rf = fs.realpathSync(abs);
              if (lib.normPath(path.dirname(rf)) !== lib.normPath(realDir) || !fs.statSync(rf).isFile()) return reject(p, 'target', 'memory 目標解析後不在 memory 目錄內');
            }
            if (p.action === 'append') return reject(p, 'format', 'memory 不支援 append（用 create 或 update）');
            if (p.action === 'update' && !exists) return reject(p, 'target', 'update 的 memory 檔不存在');
            const old = exists ? lib.readText(abs) : null;
            if (p.action === 'update' && typeof p.replaces === 'string' && p.replaces) {
              const parts = old.split(p.replaces);
              if (parts.length !== 2) return reject(p, 'target', 'replaces 在目標檔找不到或不唯一');
              newText = parts[0] + p.content + parts[1];
            } else newText = p.content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
            const errs = checkMemory(newText, name.replace(/\.md$/, ''));
            if (errs.length) return reject(p, 'format', 'memory 格式：' + errs.join('；'));
            level = (p.action === 'create' && !exists && p.category !== 'correction') ? 'green' : 'yellow';
            encName = 'memory__' + name;
            if (!exists) {
              const desc = (newText.match(/^description:[ \t]*(.*?)\s*$/m) || [])[1] || name;
              const head = [...desc].slice(0, 40).join('');
              indexInfo = { path: path.join(realDir, 'MEMORY.md'), line: '- ' + STARS[p.category] + ' [' + head + '](' + name + ') — ' + p.summary };
            }
          } else {
            const rel = lib.knowledgeRel(P, p.kind);
            abs = path.join(P.root, rel);
            if (!fs.existsSync(abs)) return reject(p, 'target', rel + ' 不存在（學習迴路不建知識筆記檔本身）');
            if (!lib.realInside(abs, [P.root]) || !fs.statSync(abs).isFile()) return reject(p, 'target', rel + ' 解析後不在專案內（symlink 指到外面），不寫');
            const old = lib.readText(abs);
            if (p.action === 'update') {
              if (typeof p.replaces !== 'string' || !p.replaces) return reject(p, 'target', 'update 要帶 replaces');
              const parts = old.split(p.replaces);
              if (parts.length !== 2) return reject(p, 'target', 'replaces 在目標檔找不到或不唯一');
              newText = parts[0] + p.content + parts[1];
              level = 'yellow';
            } else {
              const errs = checkEntry(p.kind, p.content, p.section);
              if (errs.length) return reject(p, 'format', p.kind + ' 條目格式：' + errs.join('；'));
              if (p.kind === 'glossary') newText = insertBlock(old, /^## 詞彙\s*$/, p.content.trim(), true) || insertBlock(old, null, p.content.trim(), true);
              else if (p.kind === 'flows') newText = insertBlock(old, null, p.content.trim(), true);
              else {
                const esc = p.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                newText = insertBlock(old, new RegExp('^## ' + esc), p.content.trim(), false);
                if (newText === null) return reject(p, 'format', rel + ' 找不到「## ' + p.section + '」節');
              }
              level = team ? 'yellow' : 'green';
            }
            encName = encRel(abs);
            const cl = lib.changelogOf(P, p.kind);
            const clAbs = path.join(P.root, cl.rel);
            if (fs.existsSync(clAbs) && !lib.realInside(clAbs, [P.root])) res.notes.push(cl.rel + ' 解析後不在專案內（symlink 指到外面），變更紀錄沒補');
            else if (fs.existsSync(clAbs)) {
              changelogInfo = { path: clAbs, section: cl.section,
                line: '- ' + lib.today() + ' 學習迴路' + (p.action === 'update' ? '修改' : '新增') + '：' + p.summary
                  + '（起因：反思 run ' + run + '；' + (level === 'green' ? '綠區' : '黃區自主') + '）' };
            } else res.notes.push(cl.rel + ' 不存在，' + rel + ' 的變更紀錄沒補');
          }

          // 寫入（先備份）；任何一步失敗，已寫的檔全部回復到寫入前（新建的刪掉），不留半套
          let backup, afterHash;
          const written = [];
          const rollback = () => {
            for (const w of written.reverse()) {
              try { if (w.backup) fs.copyFileSync(path.join(P.learn, w.backup), w.path); else fs.unlinkSync(w.path); }
              catch (e2) { res.notes.push('回復 ' + path.basename(w.path) + ' 失敗：' + e2.message); }
            }
          };
          try {
            backup = backupOf(abs, encName);
            written.push({ path: abs, backup });
            lib.writeAtomic(abs, newText);
            afterHash = lib.sha1(newText);
            if (indexInfo) {
              const cur = lib.readText(indexInfo.path);
              written.push({ path: indexInfo.path, backup: backupOf(indexInfo.path, 'memory__MEMORY.md') });
              lib.writeAtomic(indexInfo.path, (cur === null ? '' : cur.replace(/\n*$/, cur.trim() ? '\n' : '')) + indexInfo.line + '\n');
              addedLines.push({ path: indexInfo.path, line: indexInfo.line });
              const chars = lib.readText(indexInfo.path).length;
              if (chars > lib.MEMORY_INDEX_LIMIT) res.notes.push('MEMORY.md 已 ' + chars + ' 字元，超過上限 ' + lib.MEMORY_INDEX_LIMIT);
              else if (chars > lib.MEMORY_INDEX_LIMIT * 0.8) res.notes.push('MEMORY.md 已到上限的 ' + Math.round(chars * 100 / lib.MEMORY_INDEX_LIMIT) + '%');
            }
            if (changelogInfo) {
              const cur = lib.readText(changelogInfo.path);
              written.push({ path: changelogInfo.path, backup: backupOf(changelogInfo.path, encRel(changelogInfo.path)) });
              let next = changelogInfo.section
                ? insertBlock(cur, new RegExp('^## ' + changelogInfo.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), changelogInfo.line, false)
                : null;
              if (next === null) next = cur.replace(/\n*$/, '\n') + (changelogInfo.section ? '\n## ' + changelogInfo.section + '\n' : '') + changelogInfo.line + '\n';
              lib.writeAtomic(changelogInfo.path, next);
              addedLines.push({ path: changelogInfo.path, line: changelogInfo.line });
            }
          } catch (e) {
            rollback();
            return reject(p, 'io', '寫入失敗（已回復寫入前狀態）：' + e.message);
          }
          const id = lib.nextPendingId(pd.items);
          try {
            lib.appendLedger(P, { run, action: level === 'green' ? 'write' : 'pending-review', target: display(p), level, result: 'ok',
              reason: level === 'green' ? '綠區寫入' : '黃區寫入，待你看', reasonClass: '-', evidence: sources(p), topic: topicOf(p), item: id });
          } catch (e) {
            rollback();   // 沒有紀錄的寫入不留
            throw e;
          }
          pd.items.push({ id, run, level, type: level === 'green' ? 'write' : 'write-review', status: level === 'green' ? 'accepted' : 'pending',
            kind: p.kind, action: p.action, target: display(p), targetPath: abs, topic: topicOf(p), category: p.category || null,
            summary: p.summary, evidence: sources(p), backup, afterHash, addedLines,
            createdAt: lib.nowIso(), decidedAt: null, decisionNote: null });
          runRollbacks.push({ id, target: display(p), rollback });
          if (level === 'green') { res.written++; res.greenWrites.push({ topic: topicOf(p), summary: p.summary }); }
          else res.pendingReview++;
          maybePromote(p);
        } catch (e) {
          if (e && e.code === 'ELOCKED') throw e;
          reject(p, 'io', '處理失敗：' + (e && e.message));
        }
      });
      lib.writeJson(P.pending, pd);
    } catch (e) {
      // 中途丟出例外（取不到鎖、ledger 或待處理清單寫不進去）：這次寫入的檔都無從還原或核可，整批回復到寫入前，ledger 補記（盡力）
      for (const w of runRollbacks.reverse()) {
        w.rollback();
        try { lib.appendLedger(P, { run, action: 'rollback', target: w.target, level: null, result: 'ok', reason: '落地中途失敗，已回復寫入前狀態：' + (e && e.message), reasonClass: 'io', evidence: [], topic: null, item: w.id }); } catch {}
      }
      throw e;
    }
  });
  return res;
}

module.exports = { promote, checkMemory, checkEntry, insertBlock, redPath, MAX_PROPOSALS, VERBATIM_MIN };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const pf = get('--proposals'), tp = get('--transcript'), rg = get('--range');
  const m = rg && rg.match(/^(\d+)-(\d+)$/);
  if (!pf || !tp || !m) {
    console.error('用法：node learn-promote.js --proposals <提案 JSON 檔> --transcript <transcript 路徑> --range <起行>-<迄行> [--run <run id>]');
    process.exit(2);
  }
  try {
    const from = Number(m[1]), to = Number(m[2]);
    const proposals = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const lines = fs.readFileSync(tp, 'utf8').split('\n').slice(from - 1, to);
    const entries = lib.extractEntries(lines, from);
    const out = promote({ root: lib.rootOf(__dirname), run: get('--run') || lib.newRunId(), transcriptName: path.basename(tp),
      fromLine: from, toLine: to, proposals, sourceText: entries.map((e) => e.text).join('\n'), entryLines: entries.map((e) => e.line) });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    console.error('[learn-promote] ERROR: ' + (e && e.message) + (e && e.code === 'ELOCKED' ? '（請重跑）' : ''));
    process.exit(1);
  }
}
