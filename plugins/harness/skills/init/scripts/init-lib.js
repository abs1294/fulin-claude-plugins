'use strict';
// init-flow.js 與 init-verify.js 共用：狀態檔／答案檔路徑、答案檔的 schema 驗證（零相依的小驗證器）、
// 必答題規則、形狀目錄列數。不是 CLI。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SKILL_DIR = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.resolve(SKILL_DIR, '..', '..');
const SCHEMA_PATH = path.join(SKILL_DIR, 'references', 'init-answers.schema.json');
const CATALOG_PATH = path.join(SKILL_DIR, 'references', 'hook-catalog.md');

// 進 Phase 4 前一定要有答案或跳過理由的題目
const REQUIRED = ['U1', 'U2', 'U3', 'Q1', 'Q2', 'Q4', 'Q5', 'Q7', 'Q10', 'Q11', 'Q12'];
// 有答案（沒跳過）時，data 一定要有的欄位與型別（給 init-verify 機械驗收用）
const DATA_REQUIRED = {
  U3: { confirmedTerms: 'array', removedTerms: 'array', originalCount: 'integer' },
  Q1: { agents: 'array' },
  Q4: { team: 'boolean' },
  Q10: { import: 'boolean' },
  Q11: { choice: ['build', 'reuse', 'none'] },
};

function today() {
  const o = process.env.HARNESS_TODAY;
  if (o && /^\d{4}-\d{2}-\d{2}$/.test(o)) return o;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const statePath = (target) => path.join(target, '.claude', 'harness', '.init-state.json');
const answersPath = (landing) => path.join(landing, '.claude', 'harness', 'init-answers.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

// ── 小驗證器：只支援本 plugin 的 schema 用到的關鍵字 ──
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeOk(want, v) {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
}
function validate(schema, value, root, where = '$') {
  root = root || schema;
  const errs = [];
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/\$defs\/(.+)$/);
    if (!m || !root.$defs || !root.$defs[m[1]]) return [`${where}: 不認得的 $ref ${schema.$ref}`];
    return validate(root.$defs[m[1]], value, root, where);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) return [`${where}: 型別應為 ${types.join('|')}，實際 ${typeOf(value)}`];
  }
  if (value === null) return errs;
  if (schema.enum && !schema.enum.some((e) => e === value)) errs.push(`${where}: 值 ${JSON.stringify(value)} 不在 ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${where}: 長度至少 ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${where}: 不符樣式 ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${where}: 至少 ${schema.minimum}`);
  if (typeOf(value) === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${where}: 缺必填欄位 ${k}`);
    const props = schema.properties || {};
    const pats = Object.entries(schema.patternProperties || {}).map(([p, s]) => [new RegExp(p), s]);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) { errs.push(...validate(props[k], v, root, `${where}.${k}`)); continue; }
      const pm = pats.find(([re]) => re.test(k));
      if (pm) { errs.push(...validate(pm[1], v, root, `${where}.${k}`)); continue; }
      if (schema.additionalProperties === false) errs.push(`${where}: 不認得的欄位 ${k}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${where}[${i}]`)));
  return errs;
}

function loadSchema() { return readJson(SCHEMA_PATH); }

// 形狀目錄的目錄表：`## 目錄` 之後、下一個 `## ` 之前，以「| 數字 |」開頭的列
function catalogRows(file = CATALOG_PATH) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^## 目錄\s*$/.test(l));
  if (start < 0) return [];
  const rows = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = lines[i].match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/);
    if (m) rows.push({ row: Number(m[1]), name: m[2] });
  }
  return rows;
}

// 答案檔的完整檢查：schema＋必答題＋data 必填欄位。回傳問題清單（空＝合格）
function checkAnswers(ans, { requireAll = true } = {}) {
  const problems = validate(loadSchema(), ans).map((e) => 'schema ' + e);
  const a = (ans && ans.answers) || {};
  if (requireAll) {
    for (const id of REQUIRED) {
      if (!a[id]) { problems.push(`必答題 ${id} 沒有紀錄（要有答案，或 skipped 寫跳過理由）`); continue; }
      if (a[id].skipped == null && !('answer' in a[id])) problems.push(`必答題 ${id} 沒有 answer 也沒有 skipped`);
    }
  }
  for (const [id, spec] of Object.entries(DATA_REQUIRED)) {
    const x = a[id];
    if (!x || x.skipped) continue;
    const d = x.data || {};
    for (const [k, t] of Object.entries(spec)) {
      if (Array.isArray(t)) { if (!t.includes(d[k])) problems.push(`${id}.data.${k} 要是 ${t.join('／')} 其一`); }
      else if (!typeOk(t, d[k])) problems.push(`${id}.data.${k} 要是 ${t}`);
    }
  }
  return problems;
}

// 與 check-flow-diagram.js 同一個算法：快照放在系統暫存目錄，以落點路徑的雜湊區分
function snapshotPath(root) {
  const r = path.resolve(root);
  const key = process.platform === 'win32' ? r.toLowerCase() : r;
  return path.join(os.tmpdir(), 'harness-init-snapshots', crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');
}

function pluginVersion() {
  try { return readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version; } catch { return '0.0.0'; }
}

module.exports = {
  SKILL_DIR, PLUGIN_ROOT, SCHEMA_PATH, CATALOG_PATH, REQUIRED, DATA_REQUIRED,
  today, statePath, answersPath, readJson, writeJsonAtomic, validate, loadSchema, catalogRows, checkAnswers, snapshotPath, pluginVersion,
};
