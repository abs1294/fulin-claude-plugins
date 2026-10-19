#!/usr/bin/env node
'use strict';
/**
 * init-verify.js — /harness:init Phase 5 靜態驗收的機械項。
 *
 * 用法：node init-verify.js <落點> [--json]
 * 輸出：每項一行「<id> | PASS／FAIL／SKIP | <證據>」，最後一行合計；任一 FAIL → exit 1；參數錯 → exit 2。
 *
 * 腳本做不到、仍由模型做的語意項，清單在 references/phases/phase-5-verify.md。
 * 誤判的逃生口：答案檔的 verifyWaivers（init-flow.js waive 寫入，每筆要有理由）——
 * 命中內容含 match 字串的那幾筆不算 FAIL，但會在證據裡列出「豁免 N 筆」，收尾回報看得到。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./init-lib.js');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootArg = args.find((a) => !a.startsWith('--'));
if (!rootArg) { console.error('用法：node init-verify.js <落點> [--json]'); process.exit(2); }
const root = path.resolve(rootArg);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error(`落點不是目錄：${root}`); process.exit(2); }

const P = (...x) => path.join(root, ...x);
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => fs.readFileSync(p, 'utf8');
const ls = (d, re) => { try { return fs.readdirSync(d).filter((f) => !re || re.test(f)).map((f) => path.join(d, f)); } catch { return []; } };

// 不是 hook、不需要接線的檔：檔頭前 5 行標 `// harness-kind: module|cli`（與 probe-hooks.js 共用同一個判準）
function isNonHook(f) {
  try { return /^\/\/ harness-kind: (module|cli)/m.test(fs.readFileSync(f, 'utf8').split('\n').slice(0, 5).join('\n')); } catch { return false; }
}
// 不可豁免的檢查：沒有誤判空間，要修檔
const UNWAIVABLE = new Set(['V09-hook-syntax', 'V10-settings-json', 'V12-secrets', 'V19-hooks-commonjs']);
// 學習迴路的檔與接線（事件 → 必須接的 hook）
const LEARN_FILES = ['learn-lib.js', 'learn-trigger.js', 'learn-reflect.js', 'learn-promote.js', 'learn-session-report.js', 'learn-pending.js', 'learn-usage.js', 'learn-approve.js', 'learn-reflector-prompt.md'];
// matcher 空字串、沒寫或 * 等於全部工具；否則以 | 切開逐一比對工具名
function matcherCovers(m, tools) {
  const t = String(m == null ? '' : m).trim();
  if (t === '' || t === '*') return true;
  const names = t.split('|').map((x) => x.trim());
  return tools.every((n) => names.includes(n));
}
const LEARN_WIRING = [['PreToolUse', 'learn-trigger.js'], ['Stop', 'learn-trigger.js'], ['SessionEnd', 'learn-trigger.js'],
  ['PreToolUse', 'learn-usage.js'], ['Stop', 'learn-usage.js'], ['SessionStart', 'learn-session-report.js'],
  ['UserPromptSubmit', 'learn-approve.js'], ['PostToolUse', 'learn-approve.js']];
// 帳密樣式（掃已生成的實例檔；學習迴路 learn-lib.js 的 scanSecrets 掃提案文字，另含中文帳密寫法，兩邊不是同一套）；值是佔位或環境變數引用的不算
const SECRET_RES = [
  /AKIA[0-9A-Z]{16}/, /\bsk-[A-Za-z0-9]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/, /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*(?![`'"<$%{*])([^\s`'"、，。；;,)）<>]{6,})/i,
  /:\/\/[^\/\s:@`'"]+:(?![*<$%{])[^\/\s@`'"]{3,}@/,
];

// ── 讀答案檔 ──
const ansPath = L.answersPath(root);
let answers = null;
try { answers = L.readJson(ansPath); } catch {}
const A = (answers && answers.answers) || {};
const waivers = (answers && Array.isArray(answers.verifyWaivers)) ? answers.verifyWaivers : [];
// 路徑換成 / 分隔（與 L.listRuleFiles 同一種寫法），V03 找建立那一行、V21 對檔都用這份
const rulesSplit = (answers && Array.isArray(answers.rulesSplit)) ? answers.rulesSplit.filter((r) => r && r.file).map((r) => Object.assign({}, r, { file: L.normRulePath(r.file) })) : [];

// 處置表的 origin 對 Phase 0 快照核對：判準在 L.checkRuleOrigins（init-flow.js rules 寫入時也跑同一支）。
// keptOk＝核對過（或無快照可核對）的沿用檔：V03 才免建立那一行
const { hits: originHits, notes: originNotes, keptOk } = L.checkRuleOrigins(root, answers && answers.target, rulesSplit);

const results = [];
function report(id, hits, okMsg, opts = {}) {
  if (opts.skip) { results.push({ id, status: 'SKIP', evidence: opts.skip }); return; }
  const mine = UNWAIVABLE.has(id) ? [] : waivers.filter((w) => w.id === id);
  const waived = [];
  const left = hits.filter((h) => { const w = mine.find((x) => String(h).includes(x.match)); if (w) { waived.push(`${h}（豁免：${w.reason}）`); return false; } return true; });
  const tail = waived.length ? `；豁免 ${waived.length} 筆：${waived.join('；')}` : '';
  if (left.length) results.push({ id, status: 'FAIL', evidence: left.slice(0, 12).join('；') + (left.length > 12 ? `；…共 ${left.length} 筆` : '') + tail });
  else results.push({ id, status: 'PASS', evidence: okMsg + tail });
}

// ── 實例檔清單 ──
const glossary = exists(P('CONTEXT.md')) ? 'CONTEXT.md' : 'GLOSSARY.md';
const otherGlossary = glossary === 'CONTEXT.md' ? 'GLOSSARY' : 'CONTEXT';
const harnessMd = ls(P('.claude', 'harness'), /\.md$/).filter((f) => !/^(flow|install-report)\.md$/.test(path.basename(f)));
const harnessDocs = harnessMd.filter((f) => path.basename(f) !== 'CHANGELOG.md');
const agentMd = ls(P('.claude', 'agents'), /\.md$/).filter((f) => path.basename(f) !== 'CHANGELOG.md');
const initSkills = ls(P('.claude', 'skills')).filter((d) => {
  try { return /harness plugin \/harness:init/.test(read(path.join(d, 'CHANGELOG.md'))); } catch { return false; }
});
const hookJs = ls(P('.claude', 'hooks'), /\.js$/);
// .claude/rules/ 遞迴（Claude Code 也載入子目錄裡的 .md）
// 列檔與 init-flow.js rules 用同一支 L.listRuleFiles（跟符號連結、路徑 / 分隔、大小寫要相符）
const rulesFiles = L.listRuleFiles(root).map((r) => P(...r.split('/')));
const containers = [P(glossary), P('FLOWS.md'), P('tests', 'Project_Detail', 'PROJECT.md')].filter(exists);
const instructionFiles = [P('CLAUDE.md'), ...harnessDocs, ...agentMd, ...rulesFiles, ...containers, ...initSkills.map((d) => path.join(d, 'SKILL.md'))].filter(exists);
const changelogFiles = [P('CLAUDE.changelog.md'), P('.claude', 'harness', 'CHANGELOG.md'), P('.claude', 'agents', 'CHANGELOG.md'),
  P(glossary.replace(/\.md$/, '.changelog.md')), P('FLOWS.changelog.md'), P('tests', 'Project_Detail', 'CHANGELOG.md'),
  ...initSkills.map((d) => path.join(d, 'CHANGELOG.md'))].filter(exists);
const extraDocs = [P('.claude', 'git-commit-reviewer-addendum.md'), P('.claude', 'qa-gate.conf')].filter(exists);
const textFiles = [...new Set([...instructionFiles, ...changelogFiles, ...extraDocs, ...ls(P('.claude', 'harness'), /\.md$/).filter((f) => harnessMd.includes(f))])];

if (!exists(P('CLAUDE.md'))) { console.error(`落點沒有 CLAUDE.md，不像是 init 產出：${root}`); process.exit(2); }

// V01 {{ 殘留
{
  const hits = [];
  for (const f of [...textFiles, ...hookJs]) read(f).split('\n').forEach((l, i) => { if (l.includes('{{')) hits.push(`${rel(f)}:${i + 1}`); });
  report('V01-placeholder', hits, `${textFiles.length + hookJs.length} 個檔 0 處 {{`);
}

// V02 本體不留 changelog 節
{
  const hits = [];
  for (const f of instructionFiles) read(f).split('\n').forEach((l, i) => { if (/^## Changelog/.test(l)) hits.push(`${rel(f)}:${i + 1}`); });
  report('V02-changelog-body', hits, `${instructionFiles.length} 個指令檔本體 0 個 ## Changelog`);
}

// V03 每份建立的檔在它的紀錄檔有「建立」那一行
{
  const hits = [];
  const created = /^- \d{4}-\d{2}-\d{2} (建立|沿用)/;
  const section = (file, title) => {
    if (!exists(file)) return null;
    const lines = read(file).split('\n');
    const s = lines.findIndex((l) => l.replace(/\s+$/, '') === '## ' + title || l.startsWith('## ' + title + '（'));
    if (s < 0) return null;
    const out = [];
    for (let i = s + 1; i < lines.length && !/^## /.test(lines[i]); i++) out.push(lines[i]);
    return out;
  };
  const need = (file, title, label) => { const sec = section(file, title); if (!sec || !sec.some((l) => created.test(l))) hits.push(`${label}：${rel(file)} 的「## ${title}」節沒有建立那一行`); };
  const needLine = (file, label) => { if (!exists(file)) { hits.push(`${label}：缺 ${rel(file)}`); return; } if (!read(file).split('\n').some((l) => created.test(l))) hits.push(`${label}：${rel(file)} 沒有建立那一行`); };
  for (const f of harnessDocs) need(P('.claude', 'harness', 'CHANGELOG.md'), path.basename(f), rel(f));
  for (const f of agentMd) need(P('.claude', 'agents', 'CHANGELOG.md'), path.basename(f), rel(f));
  needLine(P('CLAUDE.changelog.md'), 'CLAUDE.md');
  if (exists(P(glossary))) needLine(P(glossary.replace(/\.md$/, '.changelog.md')), glossary);
  if (exists(P('FLOWS.md'))) needLine(P('FLOWS.changelog.md'), 'FLOWS.md');
  if (exists(P('tests', 'Project_Detail', 'PROJECT.md'))) need(P('tests', 'Project_Detail', 'CHANGELOG.md'), 'PROJECT.md', 'tests/Project_Detail/PROJECT.md');
  // 依路徑載入的規則檔（.claude/rules/）記在 CLAUDE.changelog.md：它們是從 CLAUDE.md 拆出去的同一層，目錄裡不能放 CHANGELOG（會被當成規則載入）
  // 沿用的既有規則檔（origin: kept）不是這次建的，不要求建立那一行——只限對得上 Phase 0 快照的（keptOk；無快照時照舊放行）
  for (const r of rulesSplit) {
    if (r.origin === 'kept' && keptOk.has(r.file)) continue;
    if (!exists(P('CLAUDE.changelog.md'))) break;
    if (!read(P('CLAUDE.changelog.md')).split('\n').some((l) => created.test(l) && l.includes(r.file))) hits.push(`${r.file}：CLAUDE.changelog.md 沒有提到它的建立那一行`);
  }
  for (const d of initSkills) {
    const sk = path.join(d, 'SKILL.md');
    if (!exists(sk)) { hits.push(`${rel(d)}：缺 SKILL.md`); continue; }
    const lines = read(sk).replace(/\s+$/, '').split('\n');
    if (!/變更紀錄見同目錄 `?CHANGELOG\.md`?/.test(lines[lines.length - 1])) hits.push(`${rel(sk)}：最後一行不是「變更紀錄見同目錄 CHANGELOG.md」`);
  }
  report('V03-changelog-created', hits, `${harnessDocs.length} 份 harness 檔、${agentMd.length} 支 agent、${containers.length} 份知識筆記、${initSkills.length} 支 skill、${rulesSplit.filter((r) => !(r.origin === 'kept' && keptOk.has(r.file))).length} 份新建規則檔都有建立那一行`);
}

// V04 05 節標題
{
  const f = P('.claude', 'harness', 'CHANGELOG.md');
  const ok = exists(f) && read(f).split('\n').some((l) => l.replace(/\s+$/, '') === '## 05-knowledge-protocol.md');
  report('V04-section-05', ok ? [] : [`${rel(f)} 沒有一字不差的「## 05-knowledge-protocol.md」節（健檢提醒只認這個標題）`], '有「## 05-knowledge-protocol.md」節');
}

// V05 污染詞表
{
  const words = read(path.join(L.SKILL_DIR, 'pollution-wordlist.txt')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const re = new RegExp(words.join('|'), 'i');
  const hits = [];
  for (const f of [...instructionFiles, ...extraDocs]) read(f).split('\n').forEach((l, i) => { const m = l.match(re); if (m) hits.push(`${rel(f)}:${i + 1}「${m[0]}」`); });
  report('V05-pollution', hits, `${words.length} 個詞、${instructionFiles.length + extraDocs.length} 個檔 0 命中（變更紀錄檔不掃）`);
}

// V06 詞彙表檔名只有一個
{
  const re = new RegExp(otherGlossary + '\\.(changelog\\.)?md');
  const files = [P('CLAUDE.md'), ...harnessDocs, ...agentMd, P('tests', 'Project_Detail', 'PROJECT.md'), P(glossary), P(glossary.replace(/\.md$/, '.changelog.md')),
    ...initSkills.map((d) => path.join(d, 'SKILL.md'))].filter(exists);
  const hits = [];
  for (const f of files) read(f).split('\n').forEach((l, i) => {
    if (!re.test(l)) return;
    if (path.basename(f).endsWith('.changelog.md') && /改名/.test(l)) return;   // 詞彙表變更紀錄裡記錄改名的那一行
    hits.push(`${rel(f)}:${i + 1}`);
  });
  report('V06-glossary-single', hits, `實際詞彙表 ${glossary}；另一個檔名 ${otherGlossary}.md 0 命中`);
}

// V07 引用路徑存在（CLAUDE.md、04、agent 檔裡反引號包住的相對路徑；settings 的 hook 指令路徑）
const settingsFiles = [P('.claude', 'settings.json'), P('.claude', 'settings.local.json')].filter(exists);
const settingsObjs = [];
for (const f of settingsFiles) { try { settingsObjs.push({ f, j: JSON.parse(read(f)) }); } catch {} }
const commands = [];
for (const { j } of settingsObjs) for (const [ev, arr] of Object.entries((j && j.hooks) || {})) for (const m of arr || []) for (const h of (m && m.hooks) || []) if (h && h.command) commands.push({ ev, cmd: String(h.command), matcher: m.matcher });
{
  const hits = [];
  const subdirs = ls(root).filter((d) => { try { return fs.statSync(d).isDirectory() && !path.basename(d).startsWith('.'); } catch { return false; } });
  const PHASE6 = /^(\.claude\/harness\/)?(flow(-\d+)?\.(html|json|md)|install-report\.md)$/;
  const resolvable = (t, from) => [root, P('.claude', 'harness'), path.dirname(from), ...subdirs].some((b) => exists(path.join(b, t)));
  const files = [P('CLAUDE.md'), P('.claude', 'harness', '04-delegation-templates.md'), ...agentMd].filter(exists);
  let n = 0;
  for (const f of files) read(f).split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/`([^`\s]+)`/g)) {
      let t = m[1].replace(/[：:]\d+(-\d+)?$/, '');
      if (!/^[A-Za-z0-9_.\-\/]+$/.test(t)) continue;
      if (!/\.(md|js|json|ya?ml|conf|html|txt)$/.test(t) && !t.endsWith('/')) continue;
      if (/^(https?:|~|\/)/.test(t) || PHASE6.test(t)) continue;
      if (/^\.claude\/harness\/learning(\/|$)/.test(t)) continue;   // 學習迴路的執行期資料夾：第一次背景整理才建立
      if (/^\.[A-Za-z]+$/.test(t)) continue;   // 只有副檔名（`.md`）不是路徑
      if (/(例[：:如]|例如|範例|e\.g\.)[^。；\n]{0,40}$/.test(l.slice(0, m.index))) continue;   // 「例：`config/app.yml:12`」這類舉例不是引用
      n++;
      if (!resolvable(t, f)) hits.push(`${rel(f)}:${i + 1} \`${t}\``);
    }
  });
  for (const { cmd } of commands) {
    for (const m of cmd.matchAll(/"([^"]+\.js)"|(\S+\.js)/g)) {
      let p = (m[1] || m[2]).replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, root).replace(/^["']|["']$/g, '');
      if (!path.isAbsolute(p)) p = path.join(root, p);
      n++;
      if (!exists(p)) hits.push(`settings 的 hook 指令指到不存在的檔：${p}`);
    }
  }
  report('V07-paths', hits, `${n} 條引用都找得到`);
}

// V08 03 的驗證指令本體存在
{
  const f = P('.claude', 'harness', '03-judgment-matrix.md');
  if (!exists(f)) report('V08-verify-cmds', [], '', { skip: '沒有 03-judgment-matrix.md' });
  else {
    const hits = []; let n = 0;
    const pkgDirs = [root, ...ls(root).filter((d) => exists(path.join(d, 'package.json')))];
    const scriptsOf = (d) => { try { return Object.keys(JSON.parse(read(path.join(d, 'package.json'))).scripts || {}); } catch { return []; } };
    read(f).split('\n').forEach((l, i) => {
      for (const m of l.matchAll(/`([^`]+)`/g)) {
        let c = m[1].trim(); let base = root;
        const cd = c.match(/^cd\s+([^\s&;]+)\s*(&&|;)\s*(.+)$/);
        if (cd) { base = path.resolve(root, cd[1]); c = cd[3]; }
        let mm;
        if ((mm = c.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/)) && !/^(install|ci|i|add|exec|init)$/.test(mm[1])) {
          n++; const name = mm[1] === 'test' || mm[1] === 't' ? 'test' : mm[1];
          const dirs = cd ? [base] : pkgDirs;
          if (!dirs.some((d) => scriptsOf(d).includes(name))) hits.push(`03:${i + 1} \`${m[1]}\`：package.json 沒有 ${name} 這個 script`);
        } else if ((mm = c.match(/^(?:node|bash|sh|python3?|pwsh|powershell(?:\.exe)?\s+-File)\s+([^\s]+\.(?:js|mjs|cjs|sh|py|ps1))/))) {
          n++; if (!exists(path.resolve(base, mm[1]))) hits.push(`03:${i + 1} \`${m[1]}\`：${mm[1]} 不存在`);
        } else if ((mm = c.match(/^(?:pytest|python3? -m pytest)\s+([^\s-][^\s]*)/))) {
          n++; if (!exists(path.resolve(base, mm[1]))) hits.push(`03:${i + 1} \`${m[1]}\`：${mm[1]} 不存在`);
        }
      }
    });
    report('V08-verify-cmds', hits, `${n} 條驗證指令的本體都存在`);
  }
}

// V09 hook 語法
{
  const hits = [];
  for (const f of hookJs) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) hits.push(`${rel(f)}：${String(r.stderr).split('\n').find((x) => /Error/.test(x)) || 'node --check 失敗'}`); }
  report('V09-hook-syntax', hits, `${hookJs.length} 支 node --check 通過`);
}

// V10 settings JSON 可解析
{
  const hits = [];
  for (const f of settingsFiles) { try { JSON.parse(read(f)); } catch (e) { hits.push(`${rel(f)}：${e.message}`); } }
  report('V10-settings-json', hits, `${settingsFiles.length} 份 settings 可解析`, settingsFiles.length ? {} : { skip: '沒有 .claude/settings.json 或 settings.local.json' });
}

// V11 檔尾完整（以換行結尾、沒有 NUL）
{
  const hits = [];
  for (const f of [...textFiles, ...hookJs]) { const b = fs.readFileSync(f); if (!b.length || b[b.length - 1] !== 0x0a) hits.push(`${rel(f)}：檔尾不是完整的一行`); if (b.includes(0)) hits.push(`${rel(f)}：含 NUL 位元組`); }
  report('V11-eof', hits, `${textFiles.length + hookJs.length} 個檔都以完整行結尾`);
}

// V12 帳密樣式
{
  const hits = [];
  const files = [P('CLAUDE.md'), P('tests', 'Project_Detail', 'PROJECT.md'), ...harnessMd, ...extraDocs, ansPath].filter(exists);
  for (const f of files) read(f).split('\n').forEach((l, i) => { for (const re of SECRET_RES) if (re.test(l)) { hits.push(`${rel(f)}:${i + 1}（樣式 ${re.source.slice(0, 24)}…）`); break; } });
  report('V12-secrets', hits, `${files.length} 個檔 0 處帳密樣式`);
}

// V13 專案概要四塊
{
  const t = read(P('CLAUDE.md'));
  const lines = t.split('\n');
  const s = lines.findIndex((l) => /^##\s.*專案概要/.test(l));
  const hits = [];
  if (s < 0) hits.push('CLAUDE.md 沒有「專案概要」節');
  else {
    let e = lines.length; for (let i = s + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { e = i; break; }
    const sec = lines.slice(s, e).join('\n');
    for (const k of ['用途', '外部系統與資料庫', '業務流程', '目前進度']) if (!new RegExp('\\*\\*' + k + '\\*\\*').test(sec)) hits.push(`專案概要缺「${k}」`);
    if (/\*\*外部系統與資料庫\*\*/.test(sec) && !/\|\s*系統\s*\|/.test(sec) && !/無/.test(sec.split('**外部系統與資料庫**')[1].split('\n').slice(0, 2).join(''))) hits.push('外部系統與資料庫既沒有表格也沒有寫「無」');
  }
  report('V13-overview', hits, '用途、外部系統與資料庫、業務流程、目前進度四塊都在');
}

// V14 詞條數與答案檔一致
{
  if (!answers || !A.U3) report('V14-glossary-count', [], '', { skip: '答案檔沒有 U3（V15 會報）' });
  else if (!exists(P(glossary))) report('V14-glossary-count', [`缺詞彙表 ${glossary}`], '');
  else {
    const d = A.U3.skipped ? { confirmedTerms: [], removedTerms: [], originalCount: 0 } : (A.U3.data || {});
    const expect = (d.originalCount || 0) + (d.confirmedTerms || []).length - (d.removedTerms || []).length;
    const hits = [];
    // 只數 `## 詞彙` 節裡、程式碼區塊外、整行是 **…** 的行（檔頭的格式範本與說明行不算）
    const gl = read(P(glossary)).split('\n');
    const gs = gl.findIndex((l) => /^## 詞彙/.test(l));
    if (gs < 0) hits.push(`${glossary} 沒有「## 詞彙」節`);
    const real = [];
    let fence = false;
    for (let k = gs < 0 ? gl.length : gs + 1; k < gl.length && !/^## /.test(gl[k]); k++) {
      if (/^```/.test(gl[k])) { fence = !fence; continue; }
      if (!fence && /^\*\*[^*]+\*\*\s*$/.test(gl[k]) && !/（示範）/.test(gl[k])) real.push(gl[k]);
    }
    if (real.length !== expect) hits.push(`${glossary} 真詞條 ${real.length} 條，答案檔算出應為 ${expect}（原有 ${d.originalCount || 0}＋確認 ${(d.confirmedTerms || []).length}－刪除 ${(d.removedTerms || []).length}）`);
    if (answers.headless && (d.confirmedTerms || []).length) hits.push('無人值守卻有 U3 確認新增的詞（沒人確認過的定義不算詞條）');
    for (const t of d.confirmedTerms || []) if (!real.some((l) => l.includes(t))) hits.push(`U3 確認的「${t}」不在 ${glossary}`);
    report('V14-glossary-count', hits, `${glossary} 真詞條 ${real.length} 條＝答案檔`);
  }
}

// V15 答案檔合法
{
  if (!answers) report('V15-answers-schema', [`沒有答案檔或讀不懂：${rel(ansPath)}`], '');
  else report('V15-answers-schema', L.checkAnswers(answers), `${rel(ansPath)} 通過 schema，必答題齊`);
}

// V16 形狀目錄逐列有去向
{
  const rows = L.catalogRows();
  const hits = [];
  if (!answers || !Array.isArray(answers.hookCatalog)) hits.push('答案檔沒有 hookCatalog');
  else {
    const byRow = new Map(answers.hookCatalog.map((x) => [x.row, x]));
    for (const r of rows) if (!byRow.has(r.row)) hits.push(`第 ${r.row} 列（${r.name}）沒有去向`);
    if (answers.hookCatalog.length !== rows.length) hits.push(`hookCatalog ${answers.hookCatalog.length} 列 ≠ 形狀目錄 ${rows.length} 列`);
    for (const x of answers.hookCatalog) {
      if (!x.reason || !String(x.reason).trim()) hits.push(`第 ${x.row} 列沒有理由`);
      if (x.decision === 'installed') for (const f of x.files || []) if (!exists(P('.claude', 'hooks', f))) hits.push(`第 ${x.row} 列標已裝，但 .claude/hooks/${f} 不存在`);
    }
  }
  report('V16-catalog', hits, `形狀目錄 ${rows.length} 列都有去向`);
}

// V17 已裝 hook 都有接線，而且接在對的（事件, matcher）上、指令路徑指到 .claude/hooks/ 底下那一支
// （2026-10-19 紅藍對抗 R4：原本只比檔名——crd 的 matcher 改成 Bash、PreToolUse 整段搬到 Stop、路徑指到 old/ 舊版都 PASS，閘靜默失效）。
// 期望接線照 hook-catalog.md「掛載」欄（同 tests/lib/golden.js 的 HOOKS 表）；一支 hook 列幾種就是「任一種成立即可」（guard-sediment-sweep 有 git-commit 接 Skill、否則 Stop）。
// tools 是 matcher 至少要涵蓋的工具（matcher 空字串或 * 等於全部）；不在表上的 hook（專案自加、沿用的原有 hook）只比檔名與路徑。
const EXPECTED_WIRING = {
  'check-agent-model.js': [{ ev: 'PreToolUse', tools: ['Agent'] }],
  'check-review-discipline.js': [{ ev: 'PreToolUse', tools: ['Agent'] }],
  'check-ask-discipline.js': [{ ev: 'PreToolUse', tools: ['AskUserQuestion'] }],
  'guard-qa-before-commit.js': [{ ev: 'PreToolUse', tools: ['Skill'] }],
  'guard-sediment-sweep.js': [{ ev: 'PreToolUse', tools: ['Skill'] }, { ev: 'Stop' }],
  'health-check-reminder.js': [{ ev: 'SessionStart' }],
  'memory-write-advisory.js': [{ ev: 'PostToolUse', tools: ['Write', 'Edit'] }],
  'guard-claude-dir-hygiene.js': [{ ev: 'PreToolUse', tools: ['Write'] }],
  'guard-report-output.js': [{ ev: 'PreToolUse', tools: ['Write'] }],
  'backup-local-hacks.js': [{ ev: 'PreToolUse', tools: ['Bash'] }],
  'guard-local-hack-destroy.js': [{ ev: 'PreToolUse', tools: ['Bash'] }],
  'check-local-hacks-alive.js': [{ ev: 'SessionStart' }],
  'remind-worktree-overrides.js': [{ ev: 'PreToolUse', tools: ['Bash'] }],
  'guard-test-asset-hygiene.js': [{ ev: 'PostToolUse', tools: ['Write'] }],
  'guard-risky-command.js': [{ ev: 'PreToolUse', tools: ['Bash'] }],
  'guard-test-preconditions.js': [{ ev: 'PreToolUse', tools: ['Bash'] }],
  'guard-full-disk-scan.js': [{ ev: 'PreToolUse', tools: ['Bash'] }],
  'guard-required-skill.js': [{ ev: 'PreToolUse', tools: ['Edit', 'Write'] }],
  'compact-snapshot.js': [{ ev: 'PreCompact' }],
  'compact-reinject.js': [{ ev: 'SessionStart' }],
  'compact-summary-log.js': [{ ev: 'PostCompact' }],
  'resume-stale-reminder.js': [{ ev: 'SessionStart' }],
  'learn-trigger.js': [{ ev: 'PreToolUse' }],
  'learn-usage.js': [{ ev: 'PreToolUse', tools: ['Read', 'Skill', 'Bash'] }],
  'learn-session-report.js': [{ ev: 'SessionStart' }],
  'learn-approve.js': [{ ev: 'UserPromptSubmit' }],
};
{
  const hits = [];
  const hooksDir = path.resolve(P('.claude', 'hooks'));
  // 指令裡每個 .js 路徑解析成絕對路徑（$CLAUDE_PROJECT_DIR → 落點；相對路徑以落點解析），對到哪支 hook 看 basename
  const cmdPaths = (cmd) => [...cmd.matchAll(/"([^"]+\.js)"|(\S+\.js)/g)].map((m) => {
    let p = (m[1] || m[2]).replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, root).replace(/^["']|["']$/g, '');
    if (!path.isAbsolute(p)) p = path.join(root, p);
    return path.resolve(p);
  });
  let checked = 0, nameOnly = 0;
  for (const f of hookJs) {
    const b = path.basename(f);
    if (isNonHook(f)) continue;
    const mine = commands.filter((c) => cmdPaths(c.cmd).some((p) => path.basename(p) === b));
    if (!mine.length) { hits.push(`.claude/hooks/${b} 沒有接進 settings`); continue; }
    const wrongPath = mine.map((c) => cmdPaths(c.cmd).find((p) => path.basename(p) === b)).filter((p) => path.resolve(path.dirname(p)) !== hooksDir);
    if (wrongPath.length) hits.push(`.claude/hooks/${b} 的接線指令指到別的路徑：${[...new Set(wrongPath.map((p) => rel(p)))].join('、')}（要指到 .claude/hooks/${b}）`);
    const want = EXPECTED_WIRING[b];
    if (!want) { nameOnly++; continue; }
    checked++;
    const ok = want.some((w) => mine.some((c) => c.ev === w.ev && (!w.tools || matcherCovers(c.matcher, w.tools))));
    if (!ok) {
      const got = mine.map((c) => `${c.ev}（matcher ${JSON.stringify(c.matcher == null ? '' : c.matcher)}）`).join('、');
      const exp = want.map((w) => `${w.ev}${w.tools ? `（matcher 要涵蓋 ${w.tools.join('、')}）` : ''}`).join(' 或 ');
      hits.push(`.claude/hooks/${b} 接錯：現在接在 ${got}，應接 ${exp}（hook-catalog 掛載欄）`);
    }
  }
  report('V17-wiring', hits, `${checked + nameOnly} 支 hook 都有接線、路徑指到 .claude/hooks/，其中 ${checked} 支（事件, matcher）對過 hook-catalog 掛載欄${nameOnly ? `、${nameOnly} 支不在表上只比檔名` : ''}（檔頭標 harness-kind 的模組與腳本不算）`);
}

// V18 學習迴路完整
{
  const installed = (answers && Array.isArray(answers.hookCatalog) && answers.hookCatalog.some((x) => /^learn-/.test(x.name) && x.decision === 'installed'))
    || hookJs.some((f) => /^learn-/.test(path.basename(f)));
  if (!installed) report('V18-learning', [], '', { skip: '沒有裝學習迴路' });
  else {
    const hits = [];
    for (const f of LEARN_FILES) if (!exists(P('.claude', 'hooks', f))) hits.push(`缺 .claude/hooks/${f}`);
    for (const [ev, f] of LEARN_WIRING) if (!commands.some((c) => c.ev === ev && c.cmd.includes(f))) hits.push(`${f} 沒有接在 ${ev}`);
    const usage = commands.find((c) => c.ev === 'PreToolUse' && c.cmd.includes('learn-usage.js'));
    // Bash／PowerShell 也要接：bypass 模式下約一半的 memory／skill 讀取走 shell，只計 Read 會把常用項目誤列成淘汰候選
    if (usage && !matcherCovers(usage.matcher, ['Read', 'Skill', 'Bash', 'PowerShell'])) hits.push('learn-usage.js 的 PreToolUse matcher 要含 Read、Skill、Bash、PowerShell 四個（shell 讀檔也算讀取）');
    const trig = commands.find((c) => c.ev === 'PreToolUse' && c.cmd.includes('learn-trigger.js'));
    if (trig && !['', '*'].includes(String(trig.matcher == null ? '' : trig.matcher).trim())) hits.push('learn-trigger.js 的 PreToolUse matcher 要是空字串或 *（每一次工具呼叫都要數）');
    // 開場回報叫 Claude 用 AskUserQuestion 問待核項目，選單答案靠這條接線才會生效；matcher 沒涵蓋 AskUserQuestion 等於選了也沒用
    const ask = commands.find((c) => c.ev === 'PostToolUse' && c.cmd.includes('learn-approve.js'));
    if (ask && !matcherCovers(ask.matcher, ['AskUserQuestion'])) hits.push('learn-approve.js 的 PostToolUse matcher 要含 AskUserQuestion');
    const team = A.Q4 && A.Q4.data && A.Q4.data.team;
    if (team) {
      const gi = exists(P('.gitignore')) ? read(P('.gitignore')) : '';
      if (!/\.claude\/harness\/learning/.test(gi)) hits.push('團隊模式：.gitignore 沒有排除 .claude/harness/learning/');
    }
    report('V18-learning', hits, '學習迴路的檔與六個事件的接線都在');
  }
}

// V19 hook 以 CommonJS 執行：Node 依最近的 package.json 決定 .js 的模組格式。專案根是 "type": "module"
// （Vite 專案常見）而 .claude/hooks 沒有自己的 package.json 時，每一支 hook 載入就丟 `require is not defined`
// ——錯在載入階段，hook 自己的 fail-open 接不到，等於全部靜默失效。所以 .claude/hooks 一定要有 "type": "commonjs" 的 package.json。
{
  if (!hookJs.length) report('V19-hooks-commonjs', [], '', { skip: '沒有 .js hook' });
  else {
    const hits = [];
    const pj = P('.claude', 'hooks', 'package.json');
    if (!exists(pj)) hits.push('.claude/hooks/package.json 不存在：hook 會沿用上層 package.json 的模組格式（上層是 "type": "module" 時全部 hook 載入失敗）');
    else {
      let type;
      try { type = JSON.parse(read(pj)).type; } catch (e) { hits.push('.claude/hooks/package.json 不是合法 JSON：' + e.message); }
      if (type !== undefined && type !== 'commonjs') hits.push(`.claude/hooks/package.json 的 type 是 ${JSON.stringify(type)}，要是 "commonjs"`);
      else if (type === undefined && !hits.length) hits.push('.claude/hooks/package.json 沒寫 "type": "commonjs"（沒寫雖然預設是 CommonJS，但要明寫，免得被人改成 module 時沒人發現）');
    }
    report('V19-hooks-commonjs', hits, `.claude/hooks/package.json 寫明 "type": "commonjs"，${hookJs.length} 支 .js 以 CommonJS 載入`);
  }
}

// ── V20～V22 共用：paths 的解析與比對用 guard-required-skill.js 匯出的同一份程式（實例有裝就用實例那支，跟 hook 實際判的一致）──
const GUARD_LOCAL = P('.claude', 'hooks', 'guard-required-skill.js');
const GUARD_TPL = path.join(L.PLUGIN_ROOT, 'hooks', 'templates', 'guard-required-skill.js');
// 實例那支可能是缺匯出的舊版或載入失敗：缺任何一個用到的函式就退回 plugin 範本，證據寫明用了哪一份與退回原因
const GUARD_FNS = ['walkFiles', 'validatePattern', 'matchPath', 'parsePaths', 'readSkills', 'fmValue', 'frontmatter', 'splitTopLevel'];
let G = null; let guardSrc = ''; let guardFallback = '';
for (const f of [GUARD_LOCAL, GUARD_TPL]) {
  if (G || !exists(f)) continue;
  const name = f === GUARD_LOCAL ? '.claude/hooks/guard-required-skill.js' : 'plugin 範本 hooks/templates/guard-required-skill.js';
  let m;
  try { m = require(f); } catch (e) { guardFallback = `${name} 載入失敗（${e.message.split('\n')[0]}）`; continue; }
  const missing = GUARD_FNS.filter((k) => !m || typeof m[k] !== 'function');
  if (missing.length) { guardFallback = `${name} 缺匯出 ${missing.join('、')}`; continue; }
  G = m;
  guardSrc = name + (f === GUARD_TPL && guardFallback ? `（${guardFallback}，退回範本）` : '');
}
const withGuardSrc = (hits) => { if (hits.length) hits[hits.length - 1] += `（判準：${guardSrc}）`; return hits; };
let projectFiles = null;
const filesOf = () => (projectFiles = projectFiles || G.walkFiles(root));
// 每條 glob：寫法合法、在專案裡至少命中一個檔（命中 0 的規則或 skill 永遠不會因為碰到檔案而載入）
function globProblems(label, globs) {
  const out = [];
  for (const g of globs) {
    const bad = G.validatePattern(g);
    if (bad) { out.push(`${label} 的 paths「${g}」${bad}`); continue; }
    if (!filesOf().some((f) => G.matchPath(g, f))) out.push(`${label} 的 paths「${g}」在專案裡命中 0 個檔（永遠不會被觸發）`);
  }
  return out;
}

// V20 .claude/rules/ 每份檔的 paths 合法、每條 glob 至少命中一個檔
{
  if (!rulesFiles.length) report('V20-rules-paths', [], '', { skip: '沒有 .claude/rules/' });
  else if (!G) report('V20-rules-paths', [guardFallback ? `guard-required-skill.js 不能用（${guardFallback}），無法比對 paths` : '找不到 guard-required-skill.js（實例與 plugin 範本都沒有），無法比對 paths'], '');
  else {
    const hits = []; let n = 0;
    for (const f of rulesFiles) { const globs = G.parsePaths(read(f)); n += globs.length; hits.push(...globProblems(rel(f), globs)); }
    report('V20-rules-paths', withGuardSrc(hits), `${rulesFiles.length} 份規則檔、${n} 條 glob 寫法合法且都命中檔案（判準：${guardSrc}）`);
  }
}

// V21 規則分層落地：每份規則檔在處置表（答案檔 rulesSplit）有一筆、處置表每筆的檔都在；每份規則檔有 paths 或在處置表標成啟動載入、
// 列在路由表或 harness README；處置表記下搬走的段落要在規則檔裡、不在 CLAUDE.md 裡（搬到沒人讀的地方等於刪除，留在 CLAUDE.md 等於沒搬）。
// 規則檔沒有紀錄時，CLAUDE.md 有沒有殘留已搬段落、建立那一行都無從查，所以缺紀錄本身就算沒過
{
  if (!rulesFiles.length && !rulesSplit.length) report('V21-rules-split', [], '', { skip: '沒有 .claude/rules/，處置表也沒有搬進規則檔的項目' });
  else {
    const hits = [];
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const claude = norm(read(P('CLAUDE.md')));
    const routes = read(P('CLAUDE.md')) + '\n' + (exists(P('.claude', 'harness', 'README.md')) ? read(P('.claude', 'harness', 'README.md')) : '');
    const bySplit = new Map(rulesSplit.map((r) => [r.file, r]));
    const unrecorded = [];
    for (const f of rulesFiles) {
      const r = rel(f);
      const hasPaths = G ? G.parsePaths(read(f)).length > 0 : /^paths\s*:/m.test(read(f));
      const entry = bySplit.get(r);
      if (!entry) unrecorded.push(r);
      if (!hasPaths && !(entry && entry.load === 'startup')) hits.push(`${r} 沒有 paths，處置表也沒標成啟動載入（沒有 paths 的檔每個 session 都整份載入；CHANGELOG、README 這類非規則檔不能放在 .claude/rules/）`);
      if (hasPaths && entry && entry.load === 'startup') hits.push(`${r} 處置表標成啟動載入，檔案卻有 paths`);
      if (!routes.includes(r)) hits.push(`${r} 沒有列在 CLAUDE.md 路由表或 .claude/harness/README.md`);
    }
    const fixCmd = `node init-flow.js rules "${(answers && answers.target) || root}" --file <JSON>`;
    if (unrecorded.length) hits.push(`${unrecorded.join('、')} 在答案檔 rulesSplit 沒有處置紀錄（漏跑 init-flow.js rules 時，CLAUDE.md 有沒有殘留已搬段落、建立那一行都查不到）：用 ${fixCmd} 重寫整份處置表，落點 .claude/rules/ 每份 .md 一筆，新建的記 load 與 moved，沿用的既有檔加 "origin":"kept"（moved 可為空）`);
    for (const e of rulesSplit) {
      if (!exists(P(e.file))) { hits.push(`處置表的 ${e.file} 不存在（檔被刪或改名了就同步處置表：用 ${fixCmd} 重寫，拿掉這筆或改成實際檔名）`); continue; }
      const body = norm(read(P(e.file)));
      for (const m of e.moved || []) {
        const t = norm(m.text);
        if (!body.includes(t)) hits.push(`${e.file} 找不到從 ${m.from} 搬來的「${t.slice(0, 30)}」`);
        if (claude.includes(t)) hits.push(`CLAUDE.md 仍有已搬到 ${e.file} 的「${t.slice(0, 30)}」（出自 ${m.from}）`);
      }
    }
    hits.push(...originHits);
    const moved = rulesSplit.reduce((k, e) => k + (e.moved || []).length, 0);
    const kept = rulesSplit.filter((e) => e.origin === 'kept').length;
    report('V21-rules-split', hits, `${rulesFiles.length} 份規則檔都在處置表有紀錄（沿用 ${kept} 份）、都有 paths 或標成啟動載入、都列在路由表；處置表 ${moved} 段已搬走（CLAUDE.md 不再有）；origin：${originNotes.join('；') || '沒有沿用檔，新建檔都不在 Phase 0 快照裡'}${G ? `（paths 解析：${guardSrc}）` : ''}`);
  }
}

// V22 skill 的 paths：合法、至少命中一個檔（判準與 guard-required-skill.js 同一份程式）；agent 定義檔 skills: 指到的專案 skill 存在
{
  const skills = G ? G.readSkills(root) : [];
  const withPaths = skills.filter((s) => s.paths.length);
  const agentRefs = [];
  for (const f of agentMd) {
    const v = G ? G.fmValue(G.frontmatter(read(f)), 'skills') : undefined;
    const list = v === undefined ? [] : (Array.isArray(v) ? v : G.splitTopLevel(v));
    for (const s of list) agentRefs.push({ f, s: String(s).trim() });
  }
  if (!G) report('V22-skill-paths', [guardFallback ? `guard-required-skill.js 不能用（${guardFallback}），無法比對 paths` : '找不到 guard-required-skill.js（實例與 plugin 範本都沒有），無法比對 paths'], '');
  else if (!withPaths.length && !agentRefs.length) report('V22-skill-paths', [], '', { skip: '沒有 skill 宣告 paths，agent 定義檔也沒有 skills:' });
  else {
    const hits = [];
    for (const s of withPaths) hits.push(...globProblems(`.claude/skills/${s.dir}/SKILL.md`, s.paths));
    for (const { f, s } of agentRefs) {
      if (s.includes(':')) continue;   // plugin 的 skill 不在專案裡
      if (!skills.some((k) => k.dir === s || k.name === s)) hits.push(`${rel(f)} 的 skills: 列了 ${s}，但 .claude/skills/ 沒有這支`);
    }
    const wired = commands.some((c) => c.cmd.includes('guard-required-skill.js'));
    const note = withPaths.length && !wired ? '；guard-required-skill 沒有接線：這些 paths 只會把 skill 名稱列進清單，不保證改檔前讀過' : '';
    report('V22-skill-paths', withGuardSrc(hits), `${withPaths.length} 支 skill 的 paths 寫法合法且都命中檔案、${agentRefs.length} 筆 agent 預載都指得到（判準：${guardSrc}）${note}`);
  }
}

// V23 每支 hook 有回歸：cases/<名>.json 或同名 cases/<名>.test.js；都沒有的要在答案檔 Q5 的 data.keptWithoutRegression 記「沿用、無回歸、理由」
// （phase-1-inventory.md「原有 hook」那一列；probe-hooks.js 認同一份清單）。這裡只對帳有沒有，實跑在 probe-hooks（Phase 5 第 8 項）
{
  const keptList = (((A.Q5 || {}).data || {}).keptWithoutRegression);
  const kept = new Map((Array.isArray(keptList) ? keptList : []).filter((x) => x && x.hook).map((x) => [String(x.hook), String(x.reason || '').trim()]));
  const hits = [];
  let json = 0, test = 0;
  const keptUsed = [];
  for (const f of hookJs) {
    if (isNonHook(f)) continue;
    const b = path.basename(f), stem = b.replace(/\.js$/, '');
    const hasJson = exists(P('.claude', 'hooks', 'cases', stem + '.json'));
    const hasTest = exists(P('.claude', 'hooks', 'cases', stem + '.test.js'));
    if (hasJson) json++;
    if (hasTest) test++;
    if (hasJson || hasTest) continue;
    if (!kept.has(b)) hits.push(`.claude/hooks/${b} 沒有回歸（cases/${stem}.json 或 cases/${stem}.test.js），答案檔 Q5 的 data.keptWithoutRegression 也沒記`);
    else if (!kept.get(b)) hits.push(`.claude/hooks/${b} 記成沿用、無回歸，但沒寫理由`);
    else keptUsed.push(b);
  }
  report('V23-hook-regression', hits, `有 .json 案例 ${json} 支、有 .test.js ${test} 支` + (keptUsed.length ? `；沿用、無回歸 ${keptUsed.length} 支（${keptUsed.join('、')}，收尾回報要列出）` : ''));
}

// V24 04 寫的標記名與必讀檔跟派工閘要求的一致（phase-5 第 14 列；04 填空時「沿用原有派工閘」與「換範本閘」兩個分支填的字樣不同，
// 填錯的話每張派工單都被擋，而且是 init 自己產的檔）。只用文字解析讀 hook，不執行它（與 /harness:review 的 review-collect.js 同一種讀法）。
// **逐模板區塊各自驗**（2026-10-19 紅藍對抗 R4：整份 04 includes 會被共通規則段的同字樣遮掉——模板六那格刪了【目標環境】、
// 模板二刪了 FLOWS 行，共通規則還寫著，整份看就 PASS，派工單照樣被擋）：04 每個「## 模板N」標題下第一個 ``` 區塊就是派工單原文，
// 閘要求的字樣要在**那個區塊裡**出現；共通規則段不算命中。模板一（只派 Explore／general-purpose）與模板五（pipeline，沒有派工單）不驗。
// 兩個來源都讀、取聯集（實例可能保留範本的表又另加逐條 if）：
//   REQUIRED_MARKERS 表（範本閘有）→ 表裡每條 pattern（regex 字串）對該 agent 對應的模板區塊要命中；填空區 when 欄引用的 const 開關是 false 的那幾條不驗。
//     agent 對到哪個模板：模板標題 agent type 寫到表裡的 key 就用它；沒寫（init 填成別名）時照角色——標題含「QA／測試」→ 表裡有【範圍展開】或
//     【測試資料來源】規則的 key；含「審查」→ 有【產出路徑】或【驗證方式】的 key；含「實作／重構」→ 有【開工前對齊】的 key；'*' 共用規則每個模板都驗
//   deny 訊息（自行演進的實例把檢查改寫成逐條 if、沒有表）→ 抽「必須含【X】／必須含「X」」的標記名、`miss.push('檔名（…）')` 與「缺：檔名.md」的必讀檔名；
//     哪些模板要有它，看那句 deny 訊息自己寫的「04 模板二、三、六」／「派 qa-engineer」「派審查型 agent」；都沒寫的＝每個派工模板都要；
//     標記的訊息寫「共通規則」或「對齊類」（有條件才要的格，例：【對照表】）只驗整份 04。檔名照 hook 自己的比法：反斜線轉正斜線、不分大小寫
// `--markers`：只印抽到的清單（來源、字樣、hook 行號、要在哪幾個模板），給 Phase 4 填 04 用——同一支程式、不吃 shell 與 locale
{
  const hook = P('.claude', 'hooks', 'check-review-discipline.js');
  const doc04 = P('.claude', 'harness', '04-delegation-templates.md');
  const onlyMarkers = args.includes('--markers');
  if (!exists(hook)) report('V24-delegation-markers', [], '', { skip: '沒裝 check-review-discipline.js（派工閘），04 不用對' });
  else if (!exists(doc04)) report('V24-delegation-markers', ['.claude/harness/04-delegation-templates.md 不存在：派工閘要求的標記名與必讀檔沒有地方對'], '');
  else {
    const src = read(hook);
    const t04 = read(doc04).replace(/\r\n/g, '\n');
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    const jsString = (lit) => lit.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));
    const norm = (s) => s.split('\\').join('/').toLowerCase();
    // ── 04 的模板區塊 ──
    const tpls = [];
    const headRe = /^## 模板([一二三四五六七八九十]+)[：:](.*)$/gm;
    let hm;
    while ((hm = headRe.exec(t04))) {
      const next = t04.indexOf('\n## ', hm.index + 1);
      const sec = t04.slice(hm.index, next < 0 ? t04.length : next);
      const a = sec.indexOf('```\n');
      const b = a < 0 ? -1 : sec.indexOf('\n```', a + 4);
      const title = hm[2];
      const at = /agent type[：:]([^；;]*)/.exec(title);
      const names = at ? [...at[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : [];
      const rest = at ? at[1].replace(/`[^`]*`/g, '').replace(/[（(][^）)]*[）)]/g, '').replace(/Explore|general-purpose|或|唯讀|[\s，,／/（）()]/g, '') : '';
      const builtin = names.every((n) => /^(Explore|general-purpose)$/.test(n));
      const managed = !!at && b >= 0 && !(builtin && !rest);
      const role = /QA|測試/.test(title) ? 'qa' : /審查|驗證型|review/i.test(title) ? 'review' : /實作|重構|功能/.test(title) ? 'impl' : 'other';
      tpls.push({ n: hm[1], title: title.replace(/（.*$/, '').trim(), body: b >= 0 ? sec.slice(a + 4, b) : '', names, managed, role });
    }
    const managedTpls = tpls.filter((t) => t.managed);
    const byRole = (r) => managedTpls.filter((t) => t.role === r);
    const label = (t) => `模板${t.n}（${t.title}）`;
    // 必讀類（表裡 name 以「必讀：」開頭、deny 訊息抽到的檔名）只看區塊裡【開工前必讀】那一段（到下一個行首【 為止）：
    // 比 hook 嚴——hook 對整張派工單比 regex，模板二回報格式的「鏈路同步：觸及 FLOWS.md」也會讓它放行，但必讀清單少了那一行 subagent 就不會去讀；
    // 區塊裡沒有【開工前必讀】段時退回整個區塊
    const readSection = (body) => { const m = /^【開工前必讀】[^\n]*\n([\s\S]*?)(?=^【|(?![\s\S]))/m.exec(body); return m ? m[1] : body; };
    const where = (t, isRead) => isRead ? readSection(t.body) : t.body;
    const hits = [], off = [], listed = [];
    let tblN = 0, denyN = 0;
    if (!managedTpls.length) hits.push('04 找不到任何派專案 agent 的模板區塊（「## 模板N：…（agent type：…）」標題下的 ``` 區塊）');
    // ── 來源一：REQUIRED_MARKERS 表 ──
    const tbl = src.match(/const REQUIRED_MARKERS = \{([\s\S]*?)\n\};/);
    if (tbl) {
      const flags = {};
      for (const f of src.matchAll(/^const ([A-Z_]+) = (true|false);/gm)) flags[f[1]] = f[2] === 'true';
      const table = {};
      const keyRe = /^\s{2}'([^']+)':\s*\[([\s\S]*?)^\s{2}\],?\s*$/gm;
      let k;
      while ((k = keyRe.exec(tbl[1]))) {
        table[k[1]] = [];
        for (const chunk of k[2].split(/(?=\bname:\s*')/).slice(1)) {
          const nm = /name:\s*('(?:[^'\\]|\\.)*')/.exec(chunk), pt = /pattern:\s*('(?:[^'\\]|\\.)*')/.exec(chunk), wh = /\bwhen:\s*([A-Z_]+)/.exec(chunk);
          if (!nm || !pt) continue;
          const name = jsString(nm[1]), pattern = jsString(pt[1]);
          if (wh && flags[wh[1]] === false) { off.push(name); continue; }
          table[k[1]].push({ name, pattern, line: lineOf(tbl.index + tbl[0].indexOf(chunk)) });
        }
      }
      const keys = Object.keys(table).filter((x) => x !== '*');
      const has = (key, s) => table[key].some((r) => r.pattern.includes(s));
      const roleKeys = {
        qa: keys.filter((key) => has(key, '範圍展開') || has(key, '測試資料來源')),
        review: keys.filter((key) => has(key, '產出路徑') || has(key, '驗證方式')),
      };
      roleKeys.impl = keys.filter((key) => !roleKeys.qa.includes(key) && !roleKeys.review.includes(key) && has(key, '開工前對齊'));
      for (const t of managedTpls) {
        const explicit = t.names.filter((n) => keys.includes(n.split(':').pop()));
        const useKeys = explicit.length ? explicit : (roleKeys[t.role] || []);
        const rules = [...(table['*'] || []).map((r) => Object.assign({ key: '*' }, r)), ...useKeys.flatMap((key) => table[key].map((r) => Object.assign({ key }, r)))];
        for (const r of rules) {
          tblN++;
          listed.push(`表 ${r.key}「${r.name}」 pattern ${r.pattern} → ${label(t)}`);
          let re;
          try { re = new RegExp(r.pattern, 'i'); } catch (e) { hits.push(`hook 的「${r.name}」pattern 不是合法 regex：${r.pattern}`); continue; }
          const isRead = /^必讀[：:]/.test(r.name);
          if (!re.test(where(t, isRead))) hits.push(`04 ${label(t)}那格${isRead ? '【開工前必讀】' : ''}缺派工閘表（${r.key}）要求的「${r.name}」字樣（pattern ${r.pattern}；hook:${r.line}）：共通規則段${isRead ? '與區塊裡其他段' : ''}寫了不算，派工單原文那個區塊${isRead ? '的必讀清單' : ''}要有`);
        }
      }
      if (!Object.values(table).some((rs) => rs.length) && !off.length) hits.push('hook 有 REQUIRED_MARKERS 表但一條規則都讀不到（name／pattern 不是單引號字面量？）');
    }
    // ── 來源二：deny 訊息 ──
    const want = new Map();   // 字樣 → { kind, line, scope }
    const stmtWindow = (idx, after) => {
      const starts = ['reasons.push(', '\n    {', 'const '].map((s) => src.lastIndexOf(s, idx)).filter((x) => x >= 0);
      const start = starts.length ? Math.max(...starts) : Math.max(0, idx - 300);
      let end = src.indexOf(');', idx);
      if (after) { const rp = src.indexOf('reasons.push(', idx); if (rp >= 0 && rp - idx < 1500) end = src.indexOf(');', rp); }
      const alt = src.indexOf('\n    },', idx);
      if (end < 0 || (alt >= 0 && alt < end)) end = alt;
      return src.slice(start, end < 0 ? idx + 700 : end);
    };
    const scopeOf = (win, kind) => {
      const nums = new Set();
      for (const m of win.matchAll(/模板([一二三四五六七八九十]+(?:[／/、，,]\s*[一二三四五六七八九十]+)*)/g)) for (const d of m[1].split(/[／/、，,]\s*/)) nums.add(d);
      if (nums.size) return managedTpls.filter((t) => nums.has(t.n));
      if (kind === '標記' && /共通規則|對齊類/.test(win)) return 'file';
      const roles = [];
      if (/qa-engineer|QA/i.test(win)) roles.push('qa');
      if (/審查/.test(win)) roles.push('review');
      if (/實作/.test(win)) roles.push('impl');
      const ts = roles.flatMap(byRole);
      return ts.length ? [...new Set(ts)] : managedTpls;
    };
    const add = (key, kind, idx, after) => { if (!want.has(key)) want.set(key, { kind, line: lineOf(idx), scope: scopeOf(stmtWindow(idx, after), kind) }); };
    for (const m of src.matchAll(/必須含(?:行首的)?([【「])([^】」\n]{1,30})[】」]/g)) add(m[1] === '【' ? `【${m[2]}】` : m[2], '標記', m.index, false);
    for (const m of src.matchAll(/miss\.push\(\s*['"]([^'"（(]+)/g)) add(m[1].trim(), '必讀檔', m.index, true);
    for (const m of src.matchAll(/缺：([A-Za-z0-9_][A-Za-z0-9_.\/\\-]*\.md)/g)) add(m[1], '必讀檔', m.index, false);
    for (const [key, v] of want) {
      denyN++;
      const found = (text) => v.kind === '標記' ? text.includes(key) : norm(text).includes(norm(key));
      const scopeTxt = v.scope === 'file' ? '整份 04（有條件才要的格）' : v.scope.map(label).join('、') || '（沒有模板）';
      listed.push(`deny 訊息「${key}」（${v.kind}，hook:${v.line}）→ ${scopeTxt}`);
      if (v.scope === 'file') { if (!found(t04)) hits.push(`04 找不到派工閘 deny 訊息要求的${v.kind}「${key}」（.claude/hooks/check-review-discipline.js:${v.line}）`); continue; }
      for (const t of v.scope) if (!found(where(t, v.kind === '必讀檔'))) hits.push(`04 ${label(t)}那格${v.kind === '必讀檔' ? '【開工前必讀】' : ''}缺派工閘 deny 訊息要求的${v.kind}「${key}」（.claude/hooks/check-review-discipline.js:${v.line}）：共通規則段寫了不算，派工單原文那個區塊${v.kind === '必讀檔' ? '的必讀清單' : ''}要有`);
    }
    if (!tblN && !denyN) hits.push('hook 沒有 REQUIRED_MARKERS 表，deny 訊息裡也抽不到「必須含【X】」／miss.push／「缺：檔名.md」：人工比對後用 waive 登記');
    if (onlyMarkers) {
      console.log(`派工閘 ${rel(hook)} 要求的字樣（${tbl ? 'REQUIRED_MARKERS 表＋' : '沒有 REQUIRED_MARKERS 表，'}deny 訊息抽出）；04 的派工模板：${managedTpls.map(label).join('、') || '（無）'}`);
      for (const l of listed) console.log('- ' + l);
      if (off.length) console.log(`- 表裡開關關閉不驗：${off.join('、')}`);
      process.exit(0);
    }
    report('V24-delegation-markers', hits, `${managedTpls.length} 個派工模板（${managedTpls.map((t) => '模板' + t.n).join('、')}）逐格對：${tbl ? `REQUIRED_MARKERS 表 ${tblN} 條` : '沒有 REQUIRED_MARKERS 表（自行演進的實例）'}＋deny 訊息 ${denyN} 條標記名／必讀檔都在該模板區塊找得到`
      + (off.length ? `；表裡開關關閉不驗 ${off.length} 條（${off.join('、')}）` : ''));
  }
}

// V25 詞彙表自動載入三方一致（2026-10-19 紅藍對抗 R4）：Q10 答「匯入」↔ CLAUDE.md 行首 `@<詞彙表>` ↔ 派工閘 `REQUIRE_GLOSSARY_READ` 開關。
// 範本閘預設不驗必讀詞彙表的前提是「詞彙表以 @ 匯入、subagent 啟動時自動帶到」；Q10 答不匯入的專案這個前提不成立，開關要填 true（phase-4-hooks 填法），
// 否則主對話不載入、閘不要求列、04 說不列也過——subagent 永遠拿不到詞彙表，而且三處各說各話沒人報錯。
{
  const q10 = ((A.Q10 || {}).data || {});
  const hook = P('.claude', 'hooks', 'check-review-discipline.js');
  if (typeof q10.import !== 'boolean') report('V25-glossary-autoload', [], '', { skip: '答案檔 Q10 沒有 data.import（V15 另報）' });
  else {
    const hits = [];
    const claude = read(P('CLAUDE.md'));
    const at = claude.match(/^@(\S+)$/m);
    const hasAt = !!at && new RegExp(`^@(?:\\./)?${glossary.replace(/\./g, '\\.')}$`, 'm').test(claude);
    if (q10.import && !hasAt) hits.push(`答案檔 Q10 答「匯入」（data.import=true），但 CLAUDE.md 沒有行首 \`@${glossary}\`${at ? `（只有 \`${at[0]}\`）` : ''}：加上那一行，或把 Q10 改答不匯入`);
    if (!q10.import && hasAt) hits.push(`答案檔 Q10 答「不匯入」（data.import=false），但 CLAUDE.md 有行首 \`@${glossary}\`：兩邊矛盾，照使用者的答案擇一改`);
    let flagNote = '';
    if (exists(hook)) {
      const f = /^const REQUIRE_GLOSSARY_READ = (true|false);/m.exec(read(hook));
      if (!f) flagNote = '；派工閘沒有 REQUIRE_GLOSSARY_READ 開關（沿用的原有閘），不比';
      else {
        flagNote = `；派工閘 REQUIRE_GLOSSARY_READ=${f[1]}`;
        if (!q10.import && f[1] === 'false') hits.push('答案檔 Q10 答「不匯入」（主對話不自動載入詞彙表），但派工閘 REQUIRE_GLOSSARY_READ 是 false（不要求派工單列詞彙表）：subagent 兩邊都拿不到詞彙表，開關改 true（phase-4-hooks 填法）');
      }
    } else flagNote = '；沒裝派工閘';
    report('V25-glossary-autoload', hits, `Q10 import=${q10.import}、CLAUDE.md ${hasAt ? '有' : '沒有'}行首 @${glossary}${flagNote}`);
  }
}

const fail = results.filter((r) => r.status === 'FAIL').length;
if (asJson) console.log(JSON.stringify({ root, results }, null, 2));
else {
  for (const r of results) console.log(`${r.id} | ${r.status} | ${r.evidence}`);
  console.log(`合計 PASS ${results.filter((r) => r.status === 'PASS').length} / FAIL ${fail} / SKIP ${results.filter((r) => r.status === 'SKIP').length}`);
}
process.exit(fail ? 1 : 0);
