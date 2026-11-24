'use strict';
// The page's own rules that no request shows: when a reply counts as read (public/index.html sawIt, sawOpen, atScreen).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const from = page.indexOf('let atScreenAt = 0'), end = page.indexOf('\n/* ── files mentioned', from);
const make = () => {
  const g = { now: 1000000, calls: [], polls: 0, document: { hidden: false }, active: 'A', row: { owner: 'board', group: 'yours', status: 'idle' }, ok: true, Promise };
  g.Date = { now: () => g.now }; g.cur = () => g.row; g.poll = async () => { g.polls++; };
  g.api = (p, b) => { g.calls.push(b.sessionId); return g.ok ? Promise.resolve({}) : Promise.reject(new Error('x')); };
  vm.createContext(g); vm.runInContext(page.slice(from, end) + '\n;this.sawIt = sawIt; this.sawOpen = sawOpen; this.atScreen = atScreen;', g);
  return g;
};
const settle = () => new Promise((r) => setTimeout(r, 5));

test('a reply that came while nobody was at the page stays new, until somebody is', async () => {
  const g = make();
  g.sawIt('A'); assert.deepStrictEqual(g.calls, [], 'the page merely stands open on it');
  g.now += 3600000; g.atScreen(); await settle(); assert.deepStrictEqual([g.calls, g.polls], [['A'], 1], 'back: read');
  g.row = { owner: 'board', group: 'quiet', status: 'idle' }; for (let i = 0; i < 100; i++) g.atScreen(); await settle();
  assert.strictEqual(g.calls.length, 1, 'nothing new: nothing asked, however much the mouse moves');
});
test('at the page as it comes: read at once; another conversation, one at work, a terminal, a hidden page: not', async () => {
  const g = make(); g.row = null; g.atScreen(); g.now += 2000; g.sawIt('A'); await settle(); assert.deepStrictEqual(g.calls, ['A']);
  for (const row of [null, { owner: 'terminal', group: 'yours', status: 'idle' }, { owner: 'board', group: 'yours', status: 'waiting' }]) { const x = make(); x.row = row; x.atScreen(); await settle(); assert.deepStrictEqual(x.calls, [], JSON.stringify(row)); }
  const h = make(); h.document.hidden = true; h.atScreen(); await settle(); assert.deepStrictEqual(h.calls, []);
  h.document.hidden = false; h.atScreen(); await settle(); assert.deepStrictEqual(h.calls, ['A'], 'shown again');
});
test('one that came while the page was cut off, and an answer that failed: the list says it is new, so it is asked again', async () => {
  const g = make(); g.ok = false; g.atScreen(); await settle(); g.ok = true; g.atScreen(); await settle();
  assert.deepStrictEqual(g.calls, ['A', 'A']);
  const busy = make(); busy.api = (p, b) => { busy.calls.push(b.sessionId); return new Promise(() => {}); }; for (let i = 0; i < 50; i++) busy.atScreen();
  assert.strictEqual(busy.calls.length, 1, 'one at a time');
});

test('what takes a moment goes along with its conversation; one begun later, in the old one opened again, does not', async () => {
  const a = page.indexOf('const underWay = new Set();'), b = page.indexOf('function leaveIfEmpty(', a);
  const g = { active: null, sessions: [], unstarted: [], draftNow: new Map(), draftTimers: new Map(), draftShown: new Set(), toldHeld: new Map(), saved: [], clearTimeout, $: () => null };
  for (const k of ['pendingImgs', 'pendingFiles', 'carry', 'stashMem', 'stashSaid', 'uploading']) g[k] = new Map();
  g.saveDraft = async (sid, t) => { g.saved.push([sid, t]); };
  vm.createContext(g); vm.runInContext(page.slice(a, b) + ';this.holdOn = holdOn; this.moveHeld = moveHeld;', g);
  let go; const up = g.holdOn('OLD', async (at) => { await new Promise((r) => { go = r; }); g.pendingFiles.set(at.sid, ['f']); });
  g.draftNow.set('OLD', '打到一半'); g.uploading.set('OLD', 1); await g.moveHeld('OLD', 'NEW'); go(); await up;
  assert.deepStrictEqual([[...g.pendingFiles.keys()], [...g.uploading.keys()], g.saved], [['NEW'], ['NEW'], [['NEW', '打到一半']]]);
  await g.holdOn('OLD', async (at) => { g.pendingFiles.set(at.sid, ['g']); });
  assert.deepStrictEqual([...g.pendingFiles.keys()], ['NEW', 'OLD'], 'its own');
});
