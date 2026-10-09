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
const UNWAIVABLE = new Set(['V09-hook-syntax', 'V10-settings-json', 'V12-secrets']);
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
  ['UserPromptSubmit', 'learn-approve.js']];
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
const containers = [P(glossary), P('FLOWS.md'), P('tests', 'Project_Detail', 'PROJECT.md')].filter(exists);
const instructionFiles = [P('CLAUDE.md'), ...harnessDocs, ...agentMd, ...containers, ...initSkills.map((d) => path.join(d, 'SKILL.md'))].filter(exists);
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
  for (const d of initSkills) {
    const sk = path.join(d, 'SKILL.md');
    if (!exists(sk)) { hits.push(`${rel(d)}：缺 SKILL.md`); continue; }
    const lines = read(sk).replace(/\s+$/, '').split('\n');
    if (!/變更紀錄見同目錄 `?CHANGELOG\.md`?/.test(lines[lines.length - 1])) hits.push(`${rel(sk)}：最後一行不是「變更紀錄見同目錄 CHANGELOG.md」`);
  }
  report('V03-changelog-created', hits, `${harnessDocs.length} 份 harness 檔、${agentMd.length} 支 agent、${containers.length} 份知識筆記、${initSkills.length} 支 skill 都有建立那一行`);
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

// V17 已裝 hook 都有接線
{
  const hits = [];
  const all = commands.map((c) => c.cmd).join('\n');
  for (const f of hookJs) { const b = path.basename(f); if (isNonHook(f)) continue; if (!all.includes(b)) hits.push(`.claude/hooks/${b} 沒有接進 settings`); }
  report('V17-wiring', hits, `${hookJs.filter((f) => !isNonHook(f)).length} 支 hook 都有接線（檔頭標 harness-kind 的模組與腳本不算）`);
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
    if (usage && !matcherCovers(usage.matcher, ['Read', 'Skill'])) hits.push('learn-usage.js 的 PreToolUse matcher 要含 Read 與 Skill');
    const trig = commands.find((c) => c.ev === 'PreToolUse' && c.cmd.includes('learn-trigger.js'));
    if (trig && !['', '*'].includes(String(trig.matcher == null ? '' : trig.matcher).trim())) hits.push('learn-trigger.js 的 PreToolUse matcher 要是空字串或 *（每一次工具呼叫都要數）');
    const team = A.Q4 && A.Q4.data && A.Q4.data.team;
    if (team) {
      const gi = exists(P('.gitignore')) ? read(P('.gitignore')) : '';
      if (!/\.claude\/harness\/learning/.test(gi)) hits.push('團隊模式：.gitignore 沒有排除 .claude/harness/learning/');
    }
    report('V18-learning', hits, '學習迴路的檔與五個事件的接線都在');
  }
}

const fail = results.filter((r) => r.status === 'FAIL').length;
if (asJson) console.log(JSON.stringify({ root, results }, null, 2));
else {
  for (const r of results) console.log(`${r.id} | ${r.status} | ${r.evidence}`);
  console.log(`合計 PASS ${results.filter((r) => r.status === 'PASS').length} / FAIL ${fail} / SKIP ${results.filter((r) => r.status === 'SKIP').length}`);
}
process.exit(fail ? 1 : 0);
