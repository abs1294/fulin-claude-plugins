#!/usr/bin/env node
// harness-kind: cli（學習迴路的背景反思；由 learn-trigger.js 以 detached 子程序啟動，不是 hook、不接線）
/**
 * 背景反思：取 reflect 鎖 → 讀 transcript 水位線之後的片段 → 組輸入 → `claude -p`（sonnet，只有 Read/Grep/Glob）
 * → 解析 JSON 陣列 → learn-promote（同程序 require）→ 更新水位線 → 寫 run 帳本／last-run → 放鎖。
 *
 * 【範本】由 /harness:init 複製到目標專案 `.claude/hooks/`，之後歸該專案自治（可自改；plugin 更新不會自動同步）。
 * 不必接線：learn-trigger.js 在 Stop／SessionEnd 達門檻時以
 *   node learn-reflect.js --transcript <路徑> --session <id> --trigger stop-threshold|session-end
 * 背景啟動（env 帶 HARNESS_LEARN_CHILD=1）。手動跑同一行也可以（trigger 用 manual）。
 * 自我檢查（init Phase 5 探針 P6）：node .claude/hooks/learn-reflect.js --self-test
 *   在系統暫存目錄建假專案、自產假 claude、跑一次完整反思並逐項印 PASS/FAIL；全過 exit 0。不碰呼叫者的專案、不叫真的模型。
 *
 * 子程序隔離（設計稿第 6 節）：cwd＝系統暫存目錄底下的 harness-learn-<run>/ 沙箱，只放既有內容的複本；
 * `--tools Read,Grep,Glob`、`--setting-sources local`、`--strict-mcp-config`、`--disable-slash-commands`、
 * `--no-session-persistence`、`--system-prompt`（整段取代預設系統提示）、`--max-budget-usd` 封頂；
 * 清掉 CLAUDECODE、CLAUDE_CODE_ENTRYPOINT，設 HARNESS_LEARN_CHILD=1；跑完刪沙箱。
 * 讀不到沙箱外靠的是 Claude Code 的權限邊界：`-p` 沒有人能核可，讀工作目錄以外的路徑一律被拒；`--setting-sources local`
 * 讓使用者層與專案層的 allow 規則不生效，`--permission-mode default` 不吃任何設定裡的預設模式。
 * 實測（2026-10-09，Claude Code 2.1.294，同一組參數）：Read 沙箱內檔成功；Read、Grep、Glob 指向沙箱外的路徑三筆都回
 * 「Claude requested permissions to read from …, but you haven't granted it yet.」並列在 permission_denials。
 * 找執行檔：HARNESS_CLAUDE_BIN（.js 結尾用 node 跑）→ ~/.local/bin/claude(.exe) → Windows `where claude`（優先 .exe）→ claude。
 *
 * 失敗語義：子程序失敗或解析失敗 → 水位線不前進並標 failed；連續 2 次 → learning/pause.json 暫停到隔天；
 * 每天最多 MAX_RUNS_PER_DAY 次叫模型；片段裡沒有使用者文字也沒有工具錯誤 → 不叫模型（prefilter），水位線照樣前進。
 * 每次先處理一份別的 transcript 留下的 failed 尾段（最舊的一份，trigger＝catch-up），再處理本次的。
 *
 * 自行決定的細節（設計稿沒寫到，選風險最小的做法）：
 * - last-run.json 只在「真的叫了模型」的 run 更新（locked／paused／daily-cap／prefilter 只寫 runs/<run>.json），
 *   免得一次沒事的預篩把還沒回報的上一輪結果蓋掉。
 * - 水位線之後沒有完整的一行（還沒有換行）→ 記 skipped: prefilter，水位線不動。
 * - 暫停到期後連續失敗次數歸零（到期後再失敗一次不會立刻又暫停）。
 * - `where claude` 只找到 npm 的 claude.cmd 時，先找同目錄 node_modules/@anthropic-ai/claude-code/cli.js 用 node 直接跑
 *   （不經 cmd.exe，參數不必跳脫）；找不到才以 shell: true 執行，此時系統提示的換行換成空白、雙引號換成單引號
 *   （cmd.exe 的參數不能含換行）——**HYPOTHESIS**：shell 路徑沒有實測過。
 * - 輸出解析：先找最後一個 ```json 區塊；沒有就找最後一個「不被其他陣列包住」、能解析成陣列的 [...]。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./learn-lib.js');

// ── init 填空區 ──────────────────────────────────────────────────────────────
// 反思模型（不用 haiku）。
const MODEL = 'sonnet';
// 每天最多叫幾次模型；每次子程序的花費上限（美元）；子程序逾時（毫秒）。
const MAX_RUNS_PER_DAY = 6;
const MAX_BUDGET_USD = 0.5;
const CHILD_TIMEOUT = 300000;
// transcript 片段：每筆截斷字數、總量上限（超過保留最新的，捨掉的行數記 droppedLines）。
const ENTRY_MAX = 500;
const TOTAL_MAX = 60000;
// 連續幾次失敗就暫停到隔天。
const PAUSE_AFTER_FAILURES = 2;
// reflect.lock 多舊算殘留（毫秒）。
const REFLECT_LOCK_STALE_MS = 15 * 60 * 1000;
// 輸入裡 MEMORY.md 的字數上限、既有主題標籤最多幾個。
const MEMORY_INDEX_MAX = 8000;
const TOPICS_MAX = 100;
// ────────────────────────────────────────────────────────────────────────────

const PROMPT_FILE = path.join(__dirname, 'learn-reflector-prompt.md');

function findClaude() {
  const env = process.env.HARNESS_CLAUDE_BIN;
  if (env) return /\.js$/i.test(env) ? { cmd: process.execPath, pre: [env], shell: false } : { cmd: env, pre: [], shell: /\.(cmd|bat)$/i.test(env) };
  const local = path.join(os.homedir(), '.local', 'bin', lib.IS_WIN ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return { cmd: local, pre: [], shell: false };
  if (lib.IS_WIN) {
    const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    const found = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = found.find((f) => /\.exe$/i.test(f));
    if (exe) return { cmd: exe, pre: [], shell: false };
    const cmd = found.find((f) => /\.(cmd|bat)$/i.test(f));
    if (cmd) {
      const cli = path.join(path.dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli], shell: false };
      return { cmd, pre: [], shell: true };
    }
  }
  return { cmd: 'claude', pre: [], shell: false };
}

// 字串感知的括號配對：回傳與 s[i] 的 '[' 配對的 ']' 位置，配不上回 -1
function matchBracket(s, i) {
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return ch === ']' ? k : -1; if (depth < 0) return -1; }
  }
  return -1;
}
function extractArray(text) {
  const s = String(text || '');
  const fences = [...s.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) { try { const v = JSON.parse(fences[i][1]); if (Array.isArray(v)) return v; } catch {} }
  const cands = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue;
    const j = matchBracket(s, i);
    if (j < 0) continue;
    try { const v = JSON.parse(s.slice(i, j + 1)); if (Array.isArray(v)) cands.push({ i, j, v }); } catch {}
  }
  const outer = cands.filter((c) => !cands.some((d) => d !== c && d.i <= c.i && d.j >= c.j));
  return outer.length ? outer[outer.length - 1].v : null;
}

function headingsOf(text, re) { return String(text || '').split('\n').filter((l) => re.test(l)).map((l) => l.trim()); }
function sectionTwoOf05(text) {
  const lines = String(text || '').split('\n');
  const s = lines.findIndex((l) => /^## 2\./.test(l));
  if (s < 0) return '';
  const out = [lines[s]];
  for (let i = s + 1; i < lines.length && !/^## /.test(lines[i]); i++) out.push(lines[i]);
  return out.join('\n');
}
function harnessFile(P, prefix) {
  try { const f = fs.readdirSync(P.harness).find((x) => x.startsWith(prefix) && x.endsWith('.md')); return f ? path.join(P.harness, f) : null; } catch { return null; }
}

// 建沙箱（只放複本）並回傳 { dir, files }
function buildSandbox(P, run) {
  const dir = path.join(os.tmpdir(), 'harness-learn-' + run);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const copy = (src, rel) => {
    try { if (!fs.statSync(src).isFile()) return; } catch { return; }
    if (!lib.realInside(src, [P.root, P.memoryDir])) return;   // 被做成 symlink 指到專案與 memory 目錄以外的檔不複製
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    files.push(rel.replace(/\\/g, '/'));
  };
  try { for (const f of fs.readdirSync(P.memoryDir)) if (/\.md$/i.test(f)) copy(path.join(P.memoryDir, f), path.join('memory', f)); } catch {}
  for (const k of ['glossary', 'flows', 'qa-knowledge']) { const rel = lib.knowledgeRel(P, k); copy(path.join(P.root, rel), path.basename(rel)); }
  for (const pre of ['03-', '05-']) { const f = harnessFile(P, pre); if (f) copy(f, path.join('harness', path.basename(f))); }
  return { dir, files };
}

function buildPrompt(P, seg, sandboxFiles) {
  const mem = lib.readTextInside(P, path.join(P.memoryDir, 'MEMORY.md')) || '(沒有 MEMORY.md)';
  const f03 = harnessFile(P, '03-'), f05 = harnessFile(P, '05-');
  const t03 = f03 ? lib.readTextInside(P, f03) : '';
  const heads03 = String(t03 || '').split('\n').map((l) => {
    const m = l.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
    if (m && /^[A-Z]+\d+/.test(m[1])) return '| ' + m[1] + ' | ' + m[2] + ' |';
    return /^### /.test(l) ? l.trim() : null;
  }).filter(Boolean);
  const kh = [];
  for (const k of ['glossary', 'flows', 'qa-knowledge']) {
    const rel = lib.knowledgeRel(P, k);
    const t = lib.readTextInside(P, path.join(P.root, rel));
    if (t === null) continue;
    kh.push('## 檔：' + path.basename(rel), ...headingsOf(t, /^#{2,3} |^\*\*[^*]+\*\*\s*$/));
  }
  const topics = [...new Set(lib.readLedger(P).map((r) => r.topic).filter(Boolean))].slice(-TOPICS_MAX);
  return [
    '=== transcript 片段（檔名 ' + seg.name + '，行 ' + seg.fromLine + '–' + seg.toLine + '；每筆前綴 L<行號>'
      + (seg.droppedLines ? '；超過總量上限，捨掉較舊的 ' + seg.droppedLines + ' 行' : '') + '）===',
    seg.text,
    '=== MEMORY.md 索引 ===',
    mem.length > MEMORY_INDEX_MAX ? mem.slice(0, MEMORY_INDEX_MAX) + '\n…（以下截斷）' : mem,
    '=== 沙箱檔案清單（可用 Read／Grep／Glob 讀）===',
    sandboxFiles.length ? sandboxFiles.join('\n') : '(空)',
    '=== 03 條款標題 ===',
    heads03.length ? heads03.join('\n') : '(沒有 03)',
    '=== 知識筆記的節與條目標題 ===',
    kh.length ? kh.join('\n') : '(沒有知識筆記)',
    '=== 05 §2 踩坑紀錄格式（memory 提案照這個格式）===',
    (f05 && sectionTwoOf05(lib.readTextInside(P, f05))) || '(沒有 05)',
    '=== 既有主題標籤（同一件事沿用）===',
    topics.length ? topics.join(', ') : '(無)',
    '',
    '依系統提示的規則，最後只回一個 JSON 陣列（沒有值得記的就回 []）。',
  ].join('\n');
}

// 讀 transcript 水位線之後到最後一個換行的片段
function readSegment(tp, wm) {
  const buf = fs.readFileSync(tp);
  let byte = wm.byte || 0, line = wm.line || 0;
  if (buf.length < byte) { byte = 0; line = 0; } // 被輪替或截斷：從頭讀
  const rest = buf.subarray(byte);
  const nl = rest.lastIndexOf(0x0a);
  if (nl < 0) return { empty: true, fromByte: byte, toByte: byte, fromLine: line + 1, toLine: line };
  const text = rest.subarray(0, nl + 1).toString('utf8');
  const lines = text.split('\n'); lines.pop();
  const fromLine = line + 1, toLine = line + lines.length;
  const entries = lib.extractEntries(lines.map((l) => l.replace(/\r$/, '')), fromLine);
  const hasUser = entries.some((e) => e.kind === 'user'), hasError = entries.some((e) => e.kind === 'error');
  // 總量上限：從最新的往回收，超過就停；被捨掉的筆所在行數記 droppedLines
  const fmt = entries.map((e) => 'L' + e.line + ' [' + lib.KIND_LABEL[e.kind] + '] ' + ([...e.text].length > ENTRY_MAX ? [...e.text].slice(0, ENTRY_MAX).join('') + '…' : e.text));
  let total = 0, keepFrom = fmt.length;
  for (let i = fmt.length - 1; i >= 0; i--) { if (total + fmt[i].length + 1 > TOTAL_MAX) break; total += fmt[i].length + 1; keepFrom = i; }
  const dropped = new Set(entries.slice(0, keepFrom).map((e) => e.line));
  for (const e of entries.slice(keepFrom)) dropped.delete(e.line);
  return { empty: false, fromByte: byte, toByte: byte + nl + 1, fromLine, toLine, hasUser, hasError,
    text: fmt.slice(keepFrom).join('\n'), droppedLines: dropped.size, inputEntries: entries.length,
    sourceText: entries.map((e) => e.text).join('\n'), entryLines: entries.slice(keepFrom).map((e) => e.line), name: path.basename(tp) };
}

function runChild(P, run, prompt) {
  const sys = lib.readText(PROMPT_FILE);
  if (sys === null) return { ok: false, error: '找不到 learn-reflector-prompt.md' };
  const sb = buildSandbox(P, run);
  const t0 = Date.now();
  try {
    const bin = findClaude();
    const fullPrompt = prompt.replace('=== 沙箱檔案清單（可用 Read／Grep／Glob 讀）===\n(空)', '=== 沙箱檔案清單（可用 Read／Grep／Glob 讀）===\n' + (sb.files.join('\n') || '(空)'));
    let args = ['-p', '--model', MODEL, '--tools', 'Read,Grep,Glob', '--permission-mode', 'default', '--setting-sources', 'local', '--strict-mcp-config',
      '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json',
      '--max-budget-usd', String(MAX_BUDGET_USD), '--system-prompt', sys];
    if (bin.shell) args = args.map((a) => '"' + a.replace(/\r?\n/g, ' ').replace(/"/g, "'") + '"');
    const env = Object.assign({}, process.env, { HARNESS_LEARN_CHILD: '1' });
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const r = spawnSync(bin.cmd, bin.pre.concat(args), { input: fullPrompt, cwd: sb.dir, encoding: 'utf8', timeout: CHILD_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024, env, windowsHide: true, shell: bin.shell });
    const ms = Date.now() - t0;
    if (r.error) return { ok: false, ms, error: (r.error.code === 'ETIMEDOUT' ? '逾時' : '啟動失敗') + '：' + r.error.message };
    if (r.status !== 0) return { ok: false, ms, error: 'exit ' + r.status + ' ' + String(r.stderr || r.stdout || '').slice(0, 300) };
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { ok: false, ms, error: '子程序輸出不是 JSON' }; }
    if (j.is_error || typeof j.result !== 'string') return { ok: false, ms, costUsd: j.total_cost_usd, error: 'is_error 或沒有 result' + (j.subtype ? '（' + j.subtype + '）' : '') };
    return { ok: true, ms, costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null, result: j.result };
  } finally {
    try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch {}
  }
}

function writeRun(P, rec) {
  lib.writeJson(path.join(P.runs, rec.run + '.json'), rec);
  if (rec.child && rec.child.called) lib.updateJson(P.learn, 'last-run.json', {}, (o) => { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, rec, { reported: false }); });
}

function setWatermark(P, key, mut) {
  lib.updateJson(P.learn, 'watermarks.json', {}, (w) => { w[key] = Object.assign({ byte: 0, line: 0, failed: false }, w[key] || {}); mut(w[key]); w[key].updatedAt = lib.nowIso(); });
}

function failure(P, cls) {
  lib.updateJson(P.learn, 'pause.json', { failures: 0, until: null, lastError: null, reported: false }, (st) => {
    st.failures = (st.failures || 0) + 1; st.lastError = cls;
    if (st.failures >= PAUSE_AFTER_FAILURES) { st.until = lib.addDays(lib.today(), 1); st.reported = false; }
  });
}

function runOne(P, t) {
  const rec = { run: lib.newRunId(), startedAt: lib.nowIso(), endedAt: null, trigger: t.trigger, skipped: null, session: t.session || null,
    transcript: path.basename(t.transcript), range: null, inputChars: 0, droppedLines: 0,
    child: { called: false, ok: null, ms: 0, costUsd: null, error: null }, parse: { ok: null, error: null, proposals: 0 },
    results: { written: 0, pendingReview: 0, pendingApproval: 0, rejected: 0, promotions: 0 }, rejectReasons: {}, greenWrites: [], notes: [], reported: false };
  const key = path.resolve(t.transcript);
  const done = () => { rec.endedAt = lib.nowIso(); writeRun(P, rec); return rec; };
  const wm = (lib.readJson(P.watermarks, {}) || {})[key] || { byte: 0, line: 0 };
  let seg;
  try { seg = readSegment(key, wm); } catch (e) { rec.skipped = 'prefilter'; rec.notes.push('讀不到 transcript：' + e.message); return done(); }
  rec.range = { fromByte: seg.fromByte, toByte: seg.toByte, fromLine: seg.fromLine, toLine: seg.toLine };
  if (seg.empty) { rec.skipped = 'prefilter'; return done(); }
  rec.droppedLines = seg.droppedLines;
  // 確定性預篩：沒有使用者文字也沒有工具錯誤 → 不叫模型，水位線前進
  if (!seg.hasUser && !seg.hasError) {
    rec.skipped = 'prefilter';
    setWatermark(P, key, (w) => { w.byte = seg.toByte; w.line = seg.toLine; w.failed = false; w.session = t.session || w.session || null; });
    return done();
  }
  // 暫停中？
  const paused = lib.updateJson(P.learn, 'pause.json', { failures: 0, until: null, lastError: null, reported: false }, (st) => {
    if (st.until && st.until > lib.today()) return true;
    if (st.until) { st.until = null; st.failures = 0; }
    return false;
  });
  if (paused) { rec.skipped = 'paused'; return done(); }
  // 每日上限
  const allowed = lib.updateJson(P.learn, 'daily.json', { date: null, count: 0 }, (d) => {
    if (d.date !== lib.today()) { d.date = lib.today(); d.count = 0; }
    if (d.count >= MAX_RUNS_PER_DAY) return false;
    d.count++; return true;
  });
  if (!allowed) { rec.skipped = 'daily-cap'; return done(); }

  const prompt = buildPrompt(P, seg, []);
  rec.inputChars = prompt.length;
  rec.child.called = true;
  const c = runChild(P, rec.run, prompt);
  Object.assign(rec.child, { ok: c.ok, ms: c.ms || 0, costUsd: c.costUsd === undefined ? null : c.costUsd, error: c.ok ? null : c.error });
  const markFailed = (cls) => {
    failure(P, cls);
    setWatermark(P, key, (w) => { w.failed = true; w.session = t.session || w.session || null; });
  };
  if (!c.ok) { markFailed('子程序失敗'); return done(); }
  const arr = extractArray(c.result);
  if (!arr) { rec.parse = { ok: false, error: '回覆裡找不到能解析成陣列的 JSON', proposals: 0 }; markFailed('解析失敗'); return done(); }
  rec.parse = { ok: true, error: null, proposals: arr.length };
  lib.updateJson(P.learn, 'pause.json', { failures: 0, until: null, lastError: null, reported: false }, (st) => { st.failures = 0; st.until = null; });
  let r;
  try {
    r = require('./learn-promote.js').promote({ root: P.root, run: rec.run, transcriptName: seg.name, fromLine: seg.fromLine, toLine: seg.toLine,
      proposals: arr, sourceText: seg.sourceText, entryLines: seg.entryLines });
  } catch (e) {
    // 落地失敗（例如 pending.json 寫不進去，已整批回復）：水位線不前進，下次重讀這一段
    rec.landing = { ok: false, error: String(e && e.message).slice(0, 200) };
    rec.notes.push('落地失敗：' + (e && e.message));
    markFailed('落地失敗');
    return done();
  }
  rec.results = { written: r.written, pendingReview: r.pendingReview, pendingApproval: r.pendingApproval, rejected: r.rejected, promotions: r.promotions };
  rec.rejectReasons = r.rejectReasons; rec.greenWrites = r.greenWrites; rec.notes = rec.notes.concat(r.notes);
  setWatermark(P, key, (w) => { w.byte = seg.toByte; w.line = seg.toLine; w.failed = false; w.session = t.session || w.session || null; });
  return done();
}

function main(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const tp = get('--transcript');
  if (!tp) { console.error('用法：node learn-reflect.js --transcript <路徑> [--session <id>] [--trigger stop-threshold|session-end|manual] ｜ --self-test'); return 2; }
  const P = lib.paths(lib.rootOf(__dirname));
  lib.ensureDir(P.learn);
  const trigger = get('--trigger') || 'manual';
  const session = get('--session') || null;
  const lockPath = path.join(P.learn, 'reflect.lock');
  if (!lib.acquire(lockPath, 0, REFLECT_LOCK_STALE_MS)) {
    const rec = { run: lib.newRunId(), startedAt: lib.nowIso(), endedAt: lib.nowIso(), trigger, skipped: 'locked', session,
      transcript: path.basename(tp), child: { called: false }, reported: false };
    writeRun(P, rec);
    return 0;
  }
  try {
    const key = path.resolve(tp);
    const wms = lib.readJson(P.watermarks, {}) || {};
    const failed = Object.entries(wms).filter(([k, w]) => w && w.failed && lib.normPath(k) !== lib.normPath(key) && fs.existsSync(k))
      .sort((a, b) => String(a[1].updatedAt || '').localeCompare(String(b[1].updatedAt || '')));
    if (failed.length) runOne(P, { transcript: failed[0][0], session: failed[0][1].session || null, trigger: 'catch-up' });
    if (fs.existsSync(key)) runOne(P, { transcript: key, session, trigger });
    return 0;
  } finally { lib.release(lockPath); }
}

// ── --self-test：在暫存目錄跑一次完整反思（假 claude），逐項驗 ──
function selfTest() {
  const lines = [];
  let fail = 0;
  const check = (name, ok, ev) => { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (ev ? ' ' + ev : '')); if (!ok) fail++; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-learn-selftest-'));
  try {
    const hooks = path.join(tmp, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const f of ['learn-lib.js', 'learn-reflect.js', 'learn-promote.js', 'learn-reflector-prompt.md']) {
      const src = path.join(__dirname, f);
      check('複製 ' + f, fs.existsSync(src), src);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(hooks, f));
    }
    const mem = path.join(tmp, 'mem');
    fs.mkdirSync(mem);
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# Memory Index\n', 'utf8');
    const tname = 'selftest.jsonl';
    const tp = path.join(tmp, tname);
    const T = [
      { type: 'user', message: { role: 'user', content: '跑整合測試之前先確認資料庫連到的是測試機' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ECONNREFUSED 127.0.0.1:5432' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '連線被拒，改查設定。' }] } },
    ];
    fs.writeFileSync(tp, T.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    const green = { kind: 'memory', action: 'create', target: 'selftest-db-target.md', topic: 'selftest-db-target', category: 'tool-pitfall',
      summary: '整合測試前核對資料庫主機', content: '---\nname: selftest-db-target\ndescription: 整合測試連庫被拒時先核對主機設定\nmetadata:\n  type: feedback\n---\n\n測試程式讀的主機設定可能指向沒啟動的本機服務。\n**Why:** 設定檔預設值是本機位址。\n**How to apply:** 跑之前先印出實際連線目標。\n',
      evidence: [{ source: tname + ':3', clue: '測試時本機資料庫拒絕連線' }] };
    const red = { kind: 'rule', action: 'create', target: '.claude/hooks/guard-test-preconditions.js', topic: 'selftest-db-rule', category: 'correction',
      summary: '建議加一條測試前核對資料庫主機的檢查', content: '在 CHECKS 加一條 env 檢查：DB_HOST 要符合測試機樣式。',
      evidence: [{ source: tname + ':1', clue: '使用者要求先確認連到測試機' }] };
    const bad = { kind: 'memory', action: 'create', target: 'selftest-secret.md', topic: 'selftest-secret', category: 'fact',
      summary: '記下連線設定', content: 'db_password = Hunter2Secret99',
      evidence: [{ source: tname + ':3', clue: '連線失敗' }] };
    const fake = path.join(tmp, 'fake-claude.js');
    const log = path.join(tmp, 'fake-log.json');
    fs.writeFileSync(fake, [
      "const fs = require('fs');",
      "let input = ''; try { input = fs.readFileSync(0, 'utf8'); } catch {}",
      'fs.writeFileSync(' + JSON.stringify(log) + ', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), child: process.env.HARNESS_LEARN_CHILD || null, claudecode: process.env.CLAUDECODE || null, inputHasSegment: input.includes(\'L3 [工具錯誤]\') }));',
      'const proposals = ' + JSON.stringify([green, red, bad]) + ';',
      "process.stdout.write(JSON.stringify({ result: '反思完成。\\n```json\\n' + JSON.stringify(proposals) + '\\n```', total_cost_usd: 0, is_error: false }));",
    ].join('\n') + '\n', 'utf8');
    const env = Object.assign({}, process.env, { HARNESS_CLAUDE_BIN: fake, HARNESS_MEMORY_DIR: mem });
    delete env.CLAUDECODE; delete env.HARNESS_TODAY;
    const r = spawnSync(process.execPath, [path.join(hooks, 'learn-reflect.js'), '--transcript', tp, '--session', 'selftest', '--trigger', 'manual'],
      { cwd: tmp, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    check('learn-reflect 結束碼 0', r.status === 0, 'exit ' + r.status + (r.stderr ? ' stderr=' + String(r.stderr).slice(0, 200) : ''));
    const learn = path.join(tmp, '.claude', 'harness', 'learning');
    const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    let flog = null; try { flog = JSON.parse(rd(log)); } catch {}
    check('假 claude 有被呼叫', !!flog, log);
    if (flog) {
      const a = flog.argv.join(' ');
      check('子程序只給 Read,Grep,Glob 且 --permission-mode default、--setting-sources local', /--tools Read,Grep,Glob/.test(a) && /--permission-mode default/.test(a) && /--setting-sources local/.test(a) && /--no-session-persistence/.test(a), a.slice(0, 160));
      check('子程序 cwd 在系統暫存目錄的沙箱', lib.isInside(flog.cwd, os.tmpdir()) && /harness-learn-r-/.test(flog.cwd), flog.cwd);
      check('子程序環境帶 HARNESS_LEARN_CHILD=1、沒有 CLAUDECODE', flog.child === '1' && !flog.claudecode, 'child=' + flog.child);
      check('輸入含 transcript 片段（L3 工具錯誤）', flog.inputHasSegment === true, '');
      check('跑完沙箱已刪', !fs.existsSync(flog.cwd), flog.cwd);
    }
    const mfile = path.join(mem, 'selftest-db-target.md');
    check('綠區 memory 寫進暫存 memory 目錄', fs.existsSync(mfile), mfile);
    const idx = rd(path.join(mem, 'MEMORY.md')) || '';
    check('MEMORY.md 多一行索引', idx.split('\n').filter(Boolean).length === 2 && idx.includes('](selftest-db-target.md)'), JSON.stringify(idx.split('\n').slice(-2)[0]));
    let pd = null; try { pd = JSON.parse(rd(path.join(learn, 'pending.json'))); } catch {}
    const redItem = pd && pd.items.find((x) => x.type === 'proposal');
    check('紅區沒寫、只進 pending.json', !!redItem && redItem.level === 'red' && redItem.status === 'pending' && !fs.existsSync(path.join(hooks, 'guard-test-preconditions.js')),
      redItem ? redItem.id + ' ' + redItem.target : '找不到紅區項目');
    const ledger = (rd(path.join(learn, 'ledger.jsonl')) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rej = ledger.find((x) => x.action === 'reject');
    check('拒收的那筆有理由', !!rej && rej.reasonClass === 'secret' && !!rej.reason, rej ? rej.reasonClass + '：' + rej.reason : '沒有 reject 紀錄');
    check('ledger 有三筆', ledger.length === 3, ledger.map((x) => x.action).join(','));
    check('拒收的帳密內容沒有寫進任何檔', !fs.existsSync(path.join(mem, 'selftest-secret.md')) && !(rd(path.join(learn, 'pending.json')) || '').includes('Hunter2Secret99')
      && !(rd(path.join(learn, 'ledger.jsonl')) || '').includes('Hunter2Secret99'), '');
    let lr = null; try { lr = JSON.parse(rd(path.join(learn, 'last-run.json'))); } catch {}
    check('last-run.json 存在且子程序與解析都成功', !!lr && lr.child.ok === true && lr.parse.ok === true && lr.results.written === 1 && lr.results.pendingApproval === 1 && lr.results.rejected === 1,
      lr ? JSON.stringify(lr.results) : '沒有 last-run.json');
  } catch (e) {
    check('自我檢查執行', false, e && e.message);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  lines.push('合計 PASS ' + (lines.length - fail) + ' / FAIL ' + fail);
  return { fail, lines };
}

module.exports = { extractArray, readSegment, findClaude, selfTest };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const r = selfTest();
    console.log(r.lines.join('\n'));
    process.exit(r.fail ? 1 : 0);
  }
  try { process.exit(main(argv)); } catch (e) {
    console.error('[learn-reflect] ERROR: ' + (e && e.stack || e));
    process.exit(1);
  }
}
