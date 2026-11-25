'use strict';
// How hard this computer works (lib/machine.js): when it is told, when it is over, who uses most of it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../lib/machine');

const GBYTE = 1073741824, T0 = 1700000000000;
// a computer to be told what it uses: 10 cores, 10 GB
const make = (o = {}) => {
  const c = { ram: 50, cpu: 10, opened: [], closed: [], told: [], kept: null, asks: 0, n: 0, open: new Set(o.open || []) };
  let all = 0, idle = 0;
  const fake = { totalmem: () => 10 * GBYTE, freemem: () => 10 * GBYTE * (1 - c.ram / 100), cpus: () => { all += 1000; idle += 1000 * (1 - c.cpu / 100); return Array.from({ length: 10 }, () => ({ times: { user: all - idle, nice: 0, sys: 0, idle, irq: 0 } })); } };
  c.m = new M.Machine(Object.assign({ os: fake, settings: () => c.set || {}, own: 1, sessions: () => [{ sessionId: 's1', title: '整理規格', pid: 50 }],
    procs: async () => { c.asks++; return [{ pid: 50, ppid: 9, name: 'claude.exe', mem: 2 * GBYTE, cpu: 1, at: 5 }, { pid: 51, ppid: 50, name: 'node.exe', mem: GBYTE, cpu: 1, at: 6 }, { pid: 60, ppid: 1, name: 'x.exe', mem: GBYTE, cpu: 0, at: 6 }, { pid: 70, ppid: 9, name: 'chrome.exe', mem: GBYTE, cpu: 40, at: 1 }, { pid: 71, ppid: 9, name: 'chrome.exe', mem: GBYTE * 0.5, cpu: 20, at: 1 }]; },
    notices: { open: (n) => { c.opened.push(n); c.open.add(n.key); }, close: (k, by) => { if (c.open.delete(k)) c.closed.push(k + ' ' + by); }, isOpen: (k) => c.open.has(k) },
    tell: (a, b) => c.told.push(a + '｜' + b), recall: () => o.recall || null, remember: (st) => { c.kept = st; } }, o.ops));
  c.at = T0; c.run = async (seconds) => { for (let i = 0; i < seconds; i += 5) { c.at += 5000; await c.m.tick(c.at); } };
  return c;
};

test('memory: told after a minute over the point, with who uses most; closed when it has eased; not again within half an hour', async () => {
  const c = make(); c.ram = 85; await c.run(60); assert.strictEqual(c.opened.length, 0, 'not yet a minute'); assert.strictEqual(c.asks, 0, 'who it is: not asked before');
  await c.run(10); assert.strictEqual(c.opened.length, 1); assert.strictEqual(c.asks, 1);
  assert.deepStrictEqual([c.opened[0].key, c.opened[0].kind, c.opened[0].title], ['machine:ram', 'machine', '記憶體用了 85%']);
  assert.strictEqual(c.opened[0].text, '超過你設的 85% 已經 1 分鐘，剩 1.5 GB。用最多的：對話「整理規格」 3 GB、Chrome 1.5 GB、x 1 GB');
  assert.strictEqual(c.told.length, 1); assert.deepStrictEqual(c.m.now().over, ['ram']);
  await c.run(600); assert.strictEqual(c.opened.length, 1, 'the same one is told once');
  c.ram = 82; await c.run(300); assert.deepStrictEqual(c.closed, [], 'under the point, not by five: it stays');
  c.ram = 70; await c.run(50); c.ram = 81; await c.run(10); c.ram = 70; await c.run(60); assert.deepStrictEqual(c.closed, [], 'a minute in one go');
  await c.run(10); assert.deepStrictEqual(c.closed, ['machine:ram eased']);
  c.ram = 93; await c.run(120); assert.strictEqual(c.opened.length, 1, 'within half an hour of the last: not again');
  await c.run(1800); assert.strictEqual(c.opened.length, 2); assert.strictEqual(c.kept.ram > T0, true);
});

test('nearly full: told again, as urgent, also when told before; once; not more often than every ten minutes', async () => {
  const c = make(); c.ram = 86; await c.run(70); assert.strictEqual(c.opened.length, 1);
  c.ram = 96; await c.run(15); assert.strictEqual(c.opened.length, 1, 'a quarter of a minute'); await c.run(10); assert.strictEqual(c.opened.length, 2);
  assert.deepStrictEqual([c.closed[0], c.opened[1].title], ['machine:ram worse', '記憶體快滿了：96%']); assert.ok(/^只剩 0.4 GB，/.test(c.opened[1].text) && c.told.length === 2, c.opened[1].text);
  await c.run(1200); assert.strictEqual(c.opened.length, 2, 'the same one: once');
  c.ram = 90; await c.run(20); c.ram = 97; await c.run(60); assert.strictEqual(c.opened.length, 2, 'a short dip is the same one');
  c.ram = 88; await c.run(70); assert.deepStrictEqual(c.closed.slice(-1), ['machine:ram eased'], 'no longer nearly full: that notice is over, though over the point'); assert.strictEqual(c.m.now().over.length, 0);
  await c.run(300); assert.strictEqual(c.opened.length, 2, 'within half an hour of the last'); await c.run(600); assert.deepStrictEqual([c.opened.length, c.opened[2].title], [3, '記憶體用了 88%']);
  c.ram = 97; await c.run(25); assert.strictEqual(c.opened.length, 4); c.ram = 60; await c.run(80); c.ram = 97; await c.run(120); assert.strictEqual(c.opened.length, 4, 'within ten minutes: not again');
  const d = make(); d.ram = 97; await d.run(25); assert.strictEqual(d.opened[0].title, '記憶體快滿了：97%', 'also when nothing was told before'); await d.run(300); assert.strictEqual(d.opened.length, 1);
  const e = make(); e.set = { on: true, ram: 96, cpu: 85 }; e.ram = 95; await e.run(60); assert.strictEqual(e.opened.length, 0, 'the point you set, not 95'); e.ram = 96; await e.run(25); assert.deepStrictEqual(e.opened.map((x) => x.title), ['記憶體快滿了：96%']); await e.run(300); assert.strictEqual(e.opened.length, 1);
  const h = make(); h.set = { on: true, ram: 99, cpu: 85 }; h.ram = 99.5; await h.run(25); assert.strictEqual(h.opened.length, 1);
  h.at += 8 * 3600000; await h.run(40); assert.strictEqual(h.opened.length, 2, 'asleep for hours and still full: said again'); h.at += 6 * 60000; h.ram = 88; await h.run(120); assert.deepStrictEqual(h.closed.slice(-1), ['machine:ram eased'], 'held up, then no longer full: that notice is over'); h.ram = 99.5; h.set = { on: false }; await h.run(5); h.set = { on: true }; await h.run(25); assert.strictEqual(h.opened.length, 3, 'off and on again: told anew');
  const g = make({ open: ['machine:ram'], recall: { ram: T0 - 60000, cpu: 0, full: T0 - 60000 }, ops: { notices: { open: () => { throw new Error('told again'); }, close() {}, isOpen: () => true, list: () => [{ id: 1, key: 'machine:ram', kind: 'machine', title: '記憶體快滿了：97%', text: '' }] } } });
  g.ram = 98; await g.run(300); assert.deepStrictEqual(g.told, [], 'the board restarted while full: not told again'); assert.strictEqual(g.m.now().told[0].full, true);
  const q = make(); q.ram = 98; await q.run(25); for (let i = 0; i < 40; i++) { q.at += 60000; await q.run(25); } assert.strictEqual(q.opened.length, 1, 'held up now and then is not asleep: said once');
  const f = make(); f.set = { on: false }; f.ram = 99; await f.run(300); assert.strictEqual(f.opened.length, 0);
});

test('a short peak is not told; the processor takes two minutes; the points are yours to set', async () => {
  const c = make(); c.cpu = 99; await c.run(100); c.cpu = 10; await c.run(10); c.cpu = 99; await c.run(100); assert.strictEqual(c.opened.length, 0);
  await c.run(40); assert.strictEqual(c.opened[0].key, 'machine:cpu'); assert.ok(/^CPU 用了 99%$/.test(c.opened[0].title) && /用最多的：Chrome 60%、/.test(c.opened[0].text), c.opened[0].text);
  const d = make(); d.set = { on: true, ram: 95, cpu: 99 }; d.ram = 94; await d.run(600); assert.strictEqual(d.opened.length, 0); d.ram = 95; await d.run(70); assert.strictEqual(d.opened.length, 1);
  const e = make(); e.set = { on: true, ram: 5, cpu: 'x' }; assert.deepStrictEqual(e.m.settings(), { on: true, ram: 85, cpu: 85 }, 'what it may not be: the usual');
});

test('turned off: nothing is told, what is open is closed; looked at all the same', async () => {
  const c = make(); c.ram = 90; await c.run(70); assert.strictEqual(c.opened.length, 1);
  c.set = { on: false }; await c.run(5); assert.deepStrictEqual(c.closed, ['machine:ram machine off']); await c.run(4000); assert.strictEqual(c.opened.length, 1); assert.strictEqual(c.m.now().ram, 90);
});

test('the board restarted: the notice from before is closed when it eases, and half an hour is counted from then', async () => {
  const c = make({ open: ['machine:ram'], recall: { ram: T0 - 60000, cpu: 0 } }); c.ram = 90; await c.run(300); assert.strictEqual(c.opened.length, 0);
  c.ram = 40; await c.run(70); assert.deepStrictEqual(c.closed, ['machine:ram eased']); c.ram = 90; await c.run(600); assert.strictEqual(c.opened.length, 0);
});

test('not again this time: nothing more is said of it until it has eased - nearly full neither, nor after a restart; taken back', async () => {
  const c = make(); c.ram = 86; await c.run(70); assert.strictEqual(c.opened.length, 1); assert.strictEqual(c.m.mute('ram', true), true); assert.strictEqual(c.m.mute('x', true), false);
  assert.deepStrictEqual([c.closed, c.m.now().muted, c.kept.mute], [['machine:ram muted'], ['ram'], { ram: true, cpu: false }]);
  c.ram = 98; await c.run(4000); assert.strictEqual(c.opened.length, 1); c.cpu = 99; await c.run(130); assert.deepStrictEqual(c.opened.map((x) => x.key), ['machine:ram', 'machine:cpu'], 'the other one is told');
  c.ram = 82; await c.run(300); assert.deepStrictEqual(c.m.now().muted, ['ram'], 'not eased by five'); c.ram = 70; await c.run(70); assert.deepStrictEqual([c.m.now().muted, c.kept.mute.ram], [[], false]);
  c.ram = 96; await c.run(25); assert.deepStrictEqual(c.opened.slice(-1)[0].title, '記憶體快滿了：96%', 'the next time it is told');
  const r = make({ recall: { ram: 0, cpu: 0, mute: { ram: true } } }); r.ram = 98; await r.run(600); assert.strictEqual(r.opened.length, 0); r.m.mute('ram', false); await r.run(25); assert.strictEqual(r.opened.length, 1);
  const o = make({ recall: { mute: { ram: true } } }); o.ram = 98; o.set = { on: false }; await o.run(5); o.set = { on: true }; await o.run(25); assert.strictEqual(o.opened.length, 1, 'off and on takes it back');
  const n = make(); n.ram = 90; await n.run(70); n.m.mute('ram', false); n.ram = 60; await n.run(70); assert.deepStrictEqual(n.closed, ['machine:ram eased'], 'taken back when it was not quiet: nothing changes');
  let go; const w = make({ ops: { procs: () => new Promise((z) => { go = () => z([]); }) } }); w.ram = 98; for (let i = 0; i < 5; i++) w.m.tick(w.at += 5000); await new Promise((z) => setImmediate(z)); w.m.mute('ram', true); go(); await new Promise((z) => setImmediate(z)); assert.strictEqual(w.opened.length, 0, 'said while it was being asked');
});

test('asleep does not count; off and on again while asking', async () => {
  const c = make(); c.ram = 90; await c.run(5); c.at += 8 * 3600000; await c.run(50); assert.strictEqual(c.opened.length, 0, 'eight hours asleep are not a minute seen'); await c.run(20); assert.strictEqual(c.opened.length, 1);
  let go; const e = make({ ops: { procs: () => new Promise((r) => { go = () => r([]); }) } }); e.ram = 90; for (let i = 0; i < 14; i++) { e.at += 5000; e.m.tick(e.at); }
  await new Promise((r) => setImmediate(r)); e.set = { on: false }; e.m.tick(e.at += 5000); e.set = { on: true }; go(); await new Promise((r) => setImmediate(r)); assert.strictEqual(e.opened.length, 0);
  for (let i = 0; i < 14; i++) { e.at += 5000; e.m.tick(e.at); } await new Promise((r) => setImmediate(r)); go(); await new Promise((r) => setImmediate(r)); assert.strictEqual(e.opened.length, 1, 'not counted as told');
  assert.strictEqual(M.group([{ pid: 5, ppid: 1, name: 'constructor.exe', mem: 1, cpu: 0, at: 1 }], [], 1)[0].name, 'constructor');
});

test('who it is cannot be asked: told all the same', async () => {
  const c = make({ ops: { procs: async () => { throw new Error('no'); } } }); c.ram = 90; await c.run(70); assert.ok(/查不到是誰用最多/.test(c.opened[0].text));
});

test('put together: a conversation and what it started, the board, the rest by program; a number given again is not a parent', () => {
  const p = (pid, ppid, name, mem, at = 1) => ({ pid, ppid, name, mem, cpu: 0, at });
  const g = Object.fromEntries(M.group([p(1, 0, 'node.exe', 1), p(2, 1, 'claude.exe', 10, 2), p(3, 2, 'node.exe', 5, 3), p(4, 1, 'powershell.exe', 2, 2), p(5, 0, 'Chrome.exe', 7), p(6, 5, 'chrome.exe', 8, 2), p(7, 2, 'old.exe', 9, 1)], [{ sessionId: 'a', title: 'T', pid: 2 }, { sessionId: 'b', title: 'none', pid: 0 }], 1).map((x) => [x.key, x.mem]));
  assert.deepStrictEqual(g, { board: 3, 's:a': 15, 'p:chrome.exe': 15, 'p:old.exe': 9 });
});

test('a Mac: what vm_stat and ps say', async () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10000.\nPages active:                            200000.\nPages wired down:                         50000.\nPages purgeable:                           5000.\nAnonymous pages:                         155000.\nPages occupied by compressor:             20000.\n';
  assert.strictEqual(M.vmUsed(vm), (155000 - 5000 + 50000 + 20000) * 16384); assert.strictEqual(M.vmUsed('nonsense'), 0);
  assert.deepStrictEqual(M.fromPs('    1     0  12345   0.5 02-03:04:05 /sbin/launchd\n  501   1 2048 150,0    01:30 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n', 10, T0).map((x) => [x.pid, x.ppid, x.mem, x.cpu, x.name, T0 - x.at]), [[1, 0, 12345 * 1024, 0.05, 'launchd', 183845000], [501, 1, 2048 * 1024, 15, 'Google Chrome', 90000]]);
  const c = make({ ops: { vm: async () => vm } }); c.ram = 99; await c.run(20); await new Promise((r) => setImmediate(r));
  assert.strictEqual(c.m.now().ram, Math.round((220000 * 16384) / (10 * GBYTE) * 100), 'not what os.freemem says');
});

test('on this computer: every process is listed, this one among them', { skip: process.platform !== 'win32' && process.platform !== 'darwin' }, () => {
  let list;
  if (process.platform === 'win32') list = M.fromWindows(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'scripts', 'top-procs.ps1'), '-WaitMs', '200'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).pop(), 4);
  else { list = M.fromPs(execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,etime=,comm='], { encoding: 'utf8' }), 4); const u = M.vmUsed(execFileSync('vm_stat', { encoding: 'utf8' })); assert.ok(u > 0 && u < require('os').totalmem(), 'vm_stat: ' + u); }
  const me = list.find((p) => p.pid === process.pid); assert.ok(me && me.mem > 1e6 && me.ppid > 0, JSON.stringify(me)); assert.ok(list.length > 20);
  assert.ok(list.every((p) => p.cpu >= 0 && Number.isFinite(p.mem)));
});