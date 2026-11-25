'use strict';
// The design system (DESIGN.md) kept by a test: sizes, corners and shadows come from its variables, and nothing makes
// "every button inside X" a card (the card inside a card of 2026-11-25).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const lineOf = (i) => page.slice(0, i).split('\n').length;
const hits = (re, keep) => [...page.matchAll(re)].filter((m) => !keep || !keep(m)).map((m) => lineOf(m.index) + ': ' + m[0]);

test('font sizes are the six of the scale', () => {
  assert.deepStrictEqual(hits(/font-size: ?[0-9.]+px/g), []);
  assert.deepStrictEqual(hits(/fontSize = '[0-9.]+px'/g), []);
});

test('corners are --r-s, --r-m, --r-l (or round: 50%, 999px, 0)', () => {
  assert.deepStrictEqual(hits(/border-radius: ?[0-9.]+px/g, (m) => /999px/.test(m[0])), []);
});

test('shadows are --sh-card, --sh-pop, --sh-ring, or a line or ring that marks something', () => {
  const allowed = /^box-shadow: ?(none|var\(--sh-(card|pop|ring)\)|inset |0 0 0 |0 1px 0 var|-?[0-9]+px 0 0 |.*var\(--glow\))/;
  assert.deepStrictEqual(hits(/box-shadow: ?[^;}]+/g, (m) => allowed.test(m[0])), []);
});

test('a card style never goes to every element of a kind inside something', () => {
  // the rule that turns things into cards names each one; ".loads button" also caught the buttons inside its card
  const bad = [];
  for (const m of page.matchAll(/([^{}\n]+)\{[^}]*box-shadow: ?var\(--sh-card\)/g)) {
    const sel = m[1];
    for (const part of sel.replace(/^.*:is\(/, '').split(',')) if (/[\w\])] +(button|div|span|section|a)\b(?![-\w])/.test(part.trim())) bad.push(lineOf(m.index) + ': ' + part.trim());
  }
  assert.deepStrictEqual(bad, []);
});

test('spacing off the scale only goes down (607 left on 2026-11-25, to be brought onto 4 8 12 16 24 32 48)', () => {
  const scale = new Set([0, 1, 2, 4, 8, 12, 16, 24, 32, 48]);
  let off = 0;
  for (const m of page.matchAll(/(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?: ?([^;}]+)/g)) for (const v of m[1].matchAll(/(?<![\w.-])-?([0-9.]+)px/g)) if (!scale.has(+v[1])) off++;
  assert.ok(off <= 607, off + ' spacing values off the scale (was 607): use 4 8 12 16 24 32 48');
});
