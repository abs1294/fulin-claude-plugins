'use strict';
// node --test plugins/session-board/tests/touched.test.js - files a command made or changed (lib/changes.js touched):
// the folder's files written while the session was at work, beside what its transcript says it edited
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/changes');

const T = (s) => Date.parse(s);
const setTime = (f, t) => fs.utimesSync(f, t / 1000, t / 1000);

test('files written while the session was at work are found; ones from between its stretches of work, edited ones and helpers\' clutter are not', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'touched-'));
  const cwd = path.join(d, 'work'); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, 'sub')); fs.mkdirSync(path.join(cwd, 'node_modules')); fs.mkdirSync(path.join(cwd, '.git'));
  // the session worked 10:00-10:20 on the 19th and 15:00-15:05 on the 20th
  const tr = path.join(d, 'sess.jsonl');
  const at = ['2026-11-19T10:00:00Z', '2026-11-19T10:08:00Z', '2026-11-19T10:20:00Z', '2026-11-20T15:00:00Z', '2026-11-20T15:05:00Z'];
  const edited = path.join(cwd, 'edited.md');
  fs.writeFileSync(tr, at.map((t, i) => JSON.stringify(i === 1 ? { type: 'user', timestamp: t, toolUseResult: { type: 'create', filePath: edited, content: 'x' }, structuredPatch: [] } : { type: 'user', timestamp: t })).join('\n') + '\n');
  const put = (rel, t) => { const f = path.join(cwd, rel); fs.writeFileSync(f, 'x'); setTime(f, T(t)); return f; };
  put('合約_修訂版.docx', '2026-11-19T10:15:00Z');        // during the first stretch
  put('sub/報表.xlsx', '2026-11-20T15:06:30Z');            // within 2 minutes after the second
  put('yours.docx', '2026-11-19T18:00:00Z');               // between the stretches: not the session's
  put('old.docx', '2026-11-18T09:00:00Z');                 // before
  put('~$合約_修訂版.docx', '2026-11-19T10:15:00Z');        // Word's lock file
  put('node_modules/x.js', '2026-11-19T10:15:00Z');
  put('.git/index', '2026-11-19T10:15:00Z');
  fs.writeFileSync(edited, 'x'); setTime(edited, T('2026-11-19T10:08:00Z'));   // edited by the session: listed with its edits, not here
  const r = await C.touched(tr, cwd);
  assert.deepStrictEqual(r.files.map((x) => x.rel.replace(/\\/g, '/')).sort(), ['sub/報表.xlsx', '合約_修訂版.docx']);
  assert.strictEqual(r.partial, false);
  // a subagent's work counts too (its transcript beside the session's)
  fs.mkdirSync(path.join(d, 'sess', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(d, 'sess', 'subagents', 'a.jsonl'), JSON.stringify({ timestamp: '2026-11-19T18:00:00Z' }) + '\n');
  const r2 = await C.touched(tr, cwd);
  assert.ok(r2.files.some((x) => x.rel === 'yours.docx'), 'written while a subagent of it was at work');
  // no transcript time, no folder: nothing
  assert.deepStrictEqual((await C.touched(tr, '')).files, []);
});

test('what a reply names: paths in `code`, in the running text and alone on a line of a code block, and web links', () => {
  const n = C.namedIn('交付 `out\\報告.docx` 與 C:\\Work\\合約.docx。\n```powershell\n$w.Documents.Open(x)\nC:\\Work\\附件.pdf\n```\n連結 https://example.com/a?b=1）以及 `-v` `README`');
  assert.deepStrictEqual(n.paths, ['out\\報告.docx', 'C:\\Work\\合約.docx', 'C:\\Work\\附件.pdf']);
  assert.deepStrictEqual(n.links, ['https://example.com/a?b=1']);
  // macOS and Linux paths too (review 2026-11-20) - and not "and/or", a web address's path, a relative bit of text
  const mac = C.namedIn('報告在 /Users/fu/Documents/合約_v2.pdf，另存一份。\n```\n/home/me/out/report.xlsx\n```\n看 https://x.com/a/b.pdf 或 and/or 或 src/a.js 與 ./x/y.md');
  assert.deepStrictEqual(mac.paths, ['/Users/fu/Documents/合約_v2.pdf', '/home/me/out/report.xlsx']);
});
