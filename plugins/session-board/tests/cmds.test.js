'use strict';
// The slash command the caret is in (public/index.html): at the start of a message, and within it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const cmdAt = vm.runInNewContext('(' + /\nfunction cmdAt\([\s\S]*?\n}\n/.exec(page)[0].trim() + ')');
const at = (text, caret) => { const r = cmdAt(text, caret == null ? text.length : caret); return r ? [r.at, r.q] : null; };

test('a command at the start: any of it, also with words after the caret', () => {
  assert.deepStrictEqual(at('/'), [0, '']); assert.deepStrictEqual(at('/pl'), [0, 'pl']); assert.deepStrictEqual(at('/go 我要', 3), [0, 'go']);
  assert.strictEqual(at('/go 我要'), null);
});

test('a command named within a sentence: after a space, a line, a mark', () => {
  assert.deepStrictEqual(at('你做好之後用 /deli'), [7, 'deli']); assert.deepStrictEqual(at('做好，/deli'), [3, 'deli']);
  assert.deepStrictEqual(at('第一行\n/deliver-report:ch'), [4, 'deliver-report:ch']); assert.deepStrictEqual(at('請用（/goal'), [3, 'goal']);
});

test('not a command: a path, an address, a or b, a slash alone', () => {
  for (const t of ['看 C:/Users', '看 src/app', 'https://example', '用 /usr/bin', 'yes/no', '1 / ', '和 /', '~/work', '../lib', '匯出成簡報/pdf', '前端/UI', '放到 專案/docs', '%APPDATA%/claude', '${x}/claude']) assert.strictEqual(at(t), null, t);
});
