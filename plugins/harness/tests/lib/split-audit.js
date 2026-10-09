#!/usr/bin/env node
// 拆分對帳：原 SKILL.md 的每一個規則句（以「。」結尾的句子、表格列、程式碼區塊各算一句），
// 拆分後要在新檔群（新 SKILL.md、references/phases/**、rationale.md）找得到。
//
// 用法：node split-audit.js <原 SKILL.md> <新檔或目錄> [<新檔或目錄> ...] [--waivers <改寫對照表.json>] [--json]
// 判定：
//   exact ＝ 正規化後的整句是新檔群全文的子字串
//   loose ＝ 句子切成片段（≥8 字），80% 以上的片段找得到（措辭因精簡、事故經過搬走而變動的句子）
//   rewritten ＝ 刻意改寫的句子：改寫對照表（--waivers）有登記，而且登記的「改寫後文字」真的在新檔群裡
//               （只登記不落檔不算數——對照表每一條都會被驗）
//   miss  ＝ 以上都不成立 → 列為遺失
// 結束碼：0＝0 條遺失；1＝有遺失；2＝參數錯。
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const wi = args.indexOf('--waivers');
const waivers = wi >= 0 ? JSON.parse(fs.readFileSync(args[wi + 1], 'utf8')) : [];
const files = args.filter((a, i) => a !== '--json' && (wi < 0 || (i !== wi && i !== wi + 1)));
if (files.length < 2) { console.error('用法：node split-audit.js <原 SKILL.md> <新檔或目錄> [...] [--json]'); process.exit(2); }

const norm = (s) => String(s)
  .replace(/\r/g, '')
  .replace(/[*`>|\\]/g, '')
  .replace(/\s+/g, '')
  .replace(/^-+/, '');

function collect(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...collect(full));
    else if (e.isFile() && /\.md$/.test(e.name)) out.push(full);
  }
  return out;
}

// 把原檔切成規則單位，回傳 [{ line, kind, text }]
function units(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  // 跳過 frontmatter（description 由 B9 另行檢查）
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i++; i++; }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const start = i; const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      // 程式碼區塊裡的每一行都算一句（範本文字逐行比對，避免一行改動讓整塊判遺失）
      buf.forEach((b, k) => { if (norm(b).length >= 4) out.push({ line: start + 2 + k, kind: 'code', text: b }); });
      continue;
    }
    if (/^\s*\|/.test(l)) {
      if (/^\s*\|[\s|:-]+\|?\s*$/.test(l)) continue; // 表格分隔列
      out.push({ line: i + 1, kind: 'table', text: l });
      continue;
    }
    if (!l.trim() || /^---\s*$/.test(l)) continue;
    // 一般行：以「。」切句；沒有句號的整行算一句（標題、列點）
    const parts = l.split(/(?<=。)/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) if (norm(p).length >= 4) out.push({ line: i + 1, kind: /^#/.test(l) ? 'heading' : 'sentence', text: p });
  }
  return out;
}

const [orig, ...targets] = files;
const corpusFiles = targets.flatMap((t) => collect(t));
const corpus = corpusFiles.map((f) => norm(fs.readFileSync(f, 'utf8'))).join('\n');
const all = units(fs.readFileSync(orig, 'utf8'));

const STRICT = /不|禁止|必須|只|一律|除非|勿/;
const result = { exact: 0, loose: 0, rewritten: 0, miss: [], badWaivers: [] };
// 改寫對照表：{ orig: 原句開頭（正規化後比對）, now: 改寫後一定會出現在新檔群的文字, reason }
const usedWaivers = new Set();
function waived(u) {
  const n = norm(u.text);
  const w = waivers.find((x) => n.startsWith(norm(x.orig)));
  if (!w) return false;
  usedWaivers.add(w);
  if (!corpus.includes(norm(w.now))) { result.badWaivers.push({ orig: w.orig, now: w.now, why: '改寫後文字不在新檔群' }); return false; }
  return true;
}
for (const u of all) {
  const n = norm(u.text);
  if (corpus.includes(n)) { result.exact++; continue; }
  const frags = u.text.split(/[，。；：、（）「」()！？,;:]/).map(norm).filter((f) => f.length >= 8);
  // 含否定或義務字眼的句子只接受完全命中：片段八成找得到，抓不到「不得自動裝」被改成「自動裝」這種語意翻轉
  if (STRICT.test(u.text)) {
    if (waived(u)) { result.rewritten++; continue; }
    result.miss.push({ line: u.line, kind: u.kind + '（含否定或義務字眼，只收完全命中）', ratio: 0, text: u.text.slice(0, 160) });
    continue;
  }
  if (frags.length) {
    const hit = frags.filter((f) => corpus.includes(f)).length;
    if (hit / frags.length >= 0.8) { result.loose++; continue; }
    if (waived(u)) { result.rewritten++; continue; }
    result.miss.push({ line: u.line, kind: u.kind, ratio: +(hit / frags.length).toFixed(2), text: u.text.slice(0, 160) });
  } else {
    if (waived(u)) { result.rewritten++; continue; }
    result.miss.push({ line: u.line, kind: u.kind, ratio: 0, text: u.text.slice(0, 160) });
  }
}

for (const w of waivers) if (!usedWaivers.has(w)) result.badWaivers.push({ orig: w.orig, now: w.now, why: '對照表這條沒有對應到任何遺失句（過期的登記要刪）' });
if (asJson) console.log(JSON.stringify({ units: all.length, files: corpusFiles.length, ...result }, null, 2));
else {
  console.log(`原檔規則單位 ${all.length}（新檔群 ${corpusFiles.length} 份）：完全相同 ${result.exact}、措辭變動仍對得到 ${result.loose}、刻意改寫（對照表）${result.rewritten}、遺失 ${result.miss.length}`);
  for (const b of result.badWaivers) console.log(`BADWAIVER | ${b.why} | ${b.orig}`);
  for (const m of result.miss) console.log(`MISS | 原檔第 ${m.line} 行 | ${m.kind} | 片段命中 ${m.ratio} | ${m.text}`);
}
process.exit(result.miss.length || result.badWaivers.length ? 1 : 0);
