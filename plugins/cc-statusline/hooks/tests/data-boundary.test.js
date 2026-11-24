#!/usr/bin/env node
// Only cc-statusline collects usage data (docs/data-boundary.md). Every file of another plugin that touches a token
// field, a cost field or a source of the limits has to be registered there, and what is registered has to still touch it.
// Run in the repository: node hooks/tests/data-boundary.test.js -> one line a problem, exit 1 when there is one.
'use strict';
const fs = require('fs'), path = require('path');
const PLUGINS = path.resolve(__dirname, '..', '..', '..'), DOC = path.join(__dirname, '..', '..', 'docs', 'data-boundary.md');
if (!fs.existsSync(path.join(PLUGINS, '..', '.claude-plugin', 'marketplace.json'))) { console.log('skipped: not in the repository (the other plugins are not beside this one)'); process.exit(0); }
const RAW = /\b(?:input_tokens|cache_(?:read|creation)_input_tokens|total_cost_usd|get_usage)\b|rate-limit-snapshots/;
const SKIP = /^(?:node_modules|tests?|__tests__|fixtures|\.git|integration-tests)$/i, CODE = /\.(?:js|mjs|cjs|html|py|sh|ps1)$/i;
const isComment = (l) => /^\s*(?:\/\/|\*|\/\*|#|<!--)/.test(l);
// a trailing // comment is not code; // inside a quoted text or an address stays
const code = (l) => l.replace(/(^|\s)\/\/\s.*$/, '$1');
const touched = new Map();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), rel = path.relative(PLUGINS, p).split(path.sep).join('/');
    if (e.isDirectory()) { if (!SKIP.test(e.name) && rel !== 'cc-statusline') walk(p); continue; }
    if (!CODE.test(e.name)) continue;
    const at = fs.readFileSync(p, 'utf8').split(/\r?\n/).findIndex((l) => RAW.test(l) && !isComment(l) && RAW.test(code(l)));
    if (at >= 0) touched.set(rel, at + 1);
  }
})(PLUGINS);
const block = /```boundary\r?\n([\s\S]*?)```/.exec(fs.readFileSync(DOC, 'utf8'));
let bad = 0; const fail = (m) => { bad++; console.log('FAIL | ' + m); };
const listed = new Map();
for (const l of block ? block[1].split(/\r?\n/).filter((x) => x.trim()) : []) {
  const [f, kind, why] = l.split(' | ');
  if (!f || !/^(?:own-run|gap)$/.test(kind || '') || !why) { fail('not readable: ' + l); continue; }
  if (listed.has(f)) fail('registered twice: ' + f);
  listed.set(f, kind);
}
if (!listed.size) fail('docs/data-boundary.md has no list');
for (const [f, at] of touched) if (!listed.has(f)) fail(f + ':' + at + ' collects usage data itself: read cc-statusline\'s files instead (docs/data-boundary.md)');
for (const f of listed.keys()) if (!touched.has(f)) fail(f + ' is registered but does not touch it any more: take it off the list');
const n = (k) => [...listed.values()].filter((x) => x === k).length;
console.log(bad + ' failed; ' + touched.size + ' files touch usage data: ' + n('own-run') + ' own-run, ' + n('gap') + ' still to be moved');
process.exit(bad ? 1 : 0);
