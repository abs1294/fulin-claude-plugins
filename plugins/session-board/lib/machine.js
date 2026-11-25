'use strict';
// How hard this computer is working - its processor and its memory as a whole - and a notice when either stays over the
// point you set (asked 2026-11-25; the Task Manager, left open for this, costs more than it tells).
//
//   looking      every five seconds, with what Node itself has (os.cpus, os.freemem): about 0.2 ms each time. On a Mac free
//                memory is not what is left over (the system keeps files in it), so there it is what vm_stat counts, every 15 s.
//   telling      over the point for a while (memory a minute, processor two): a notice in the bell and a notification, with
//                who uses most of it. Who it is is only asked then (about two seconds, once), or when you press for it.
//   over         back under the point by five for a minute: the notice is closed. Not told again within half an hour of the
//                last time, and not while the same one has not eased.
//
// Nothing is written but the notices (lib/notices.js) and when each was last told (the setting machineState).
const os = require('os');

const EVERY = 5000, HOLD = { ram: 60000, cpu: 120000 }, EASE = 60000, EASE_BY = 5, AGAIN = 30 * 60000, RAM_EVERY_MAC = 15000;
const DEFAULTS = { on: true, ram: 85, cpu: 85 };
const okPct = (v) => Number.isInteger(v) && v >= 50 && v <= 99;

// Processor time of all cores together since the last look. -> percent, or null the first time
function cpuPct(was, now) {
  if (!was) return null;
  let idle = 0, all = 0;
  for (const k of ['user', 'nice', 'sys', 'idle', 'irq']) { const d = now[k] - was[k]; all += d; if (k === 'idle') idle = d; }
  return all > 0 ? Math.max(0, Math.min(100, (1 - idle / all) * 100)) : null;
}
const sumCpu = (cpus) => cpus.reduce((a, c) => { for (const k in c.times) a[k] = (a[k] || 0) + c.times[k]; return a; }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });

const NAMES = new Map(Object.entries({ chrome: 'Chrome', msedge: 'Edge', msedgewebview2: 'Edge WebView', firefox: 'Firefox', code: 'VS Code', 'ms-teams': 'Teams', explorer: '檔案總管', 'memory compression': '記憶體壓縮（系統）',
  vmmem: 'WSL／虛擬機', vmmemwsl: 'WSL', dwm: '桌面視窗（系統）', msmpeng: 'Windows 防毒', devenv: 'Visual Studio', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook', taskmgr: '工作管理員', system: 'System' }));
const nice = (n) => { const b = String(n || '').replace(/\.exe$/i, ''); return NAMES.get(b.toLowerCase()) || b; };

// The processes put together: those of one conversation (the claude process and all it started), the board's own, and the
// rest by program. procs: [{pid, ppid, name, mem, cpu (percent of the whole computer), at}]; sessions: [{sessionId, title, pid}]
// -> [{key, name, sessionId, mem, cpu, n}]
function group(procs, sessions, own, slack = 0) {
  const by = new Map(procs.map((p) => [p.pid, p])), root = new Map((sessions || []).filter((s) => s.pid > 0).map((s) => [s.pid, s]));
  const out = new Map();
  for (const p of procs) {
    let g = null, x = p;
    for (let i = 0; x && i < 40; i++) {
      const s = root.get(x.pid);
      if (s) { g = { key: 's:' + s.sessionId, name: '對話「' + String(s.title || s.sessionId.slice(0, 8)).slice(0, 30) + '」', sessionId: s.sessionId }; break; }
      if (x.pid === own) { g = { key: 'board', name: '看板', sessionId: '' }; break; }
      const up = by.get(x.ppid);
      // (a parent that started after its child is another process, given the number of the one that ended)
      x = up && up !== x && !(up.at && x.at && up.at > x.at + slack) ? up : null;
    }
    if (!g) g = { key: 'p:' + String(p.name).toLowerCase(), name: nice(p.name), sessionId: '' };
    const o = out.get(g.key) || Object.assign({ mem: 0, cpu: 0, n: 0 }, g);
    o.mem += p.mem || 0; o.cpu += p.cpu || 0; o.n++; out.set(g.key, o);
  }
  return [...out.values()];
}

// scripts/top-procs.ps1 -> procs
function fromWindows(line, cores) {
  const j = JSON.parse(Buffer.from(String(line), 'base64').toString('utf8'));
  const whole = j.ms * 10000 * cores;   // 100 ns of processor there was meanwhile
  return j.a.filter((r) => r[0] !== 0).map((r) => { const end = j.b[String(r[0])]; return { pid: r[0], ppid: r[1], name: r[2], mem: r[3], cpu: end >= r[4] && whole > 0 ? ((end - r[4]) / whole) * 100 : 0, at: r[5] || 0 }; });
}
// ps -axo pid=,ppid=,rss=,%cpu=,etime=,comm= (a Mac): memory in KB, %cpu of one core, how long it has run ([[days-]hours:]min:sec)
function fromPs(text, cores, now = Date.now()) {
  const ran = (e) => { const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(e); return m ? now - (((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + +m[3] * 60 + +m[4]) * 1000 : 0; };
  return String(text).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+([\d:-]+)\s+(.+?)\s*$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], name: m[6].replace(/^.*\//, ''), mem: +m[3] * 1024, cpu: parseFloat(m[4].replace(',', '.')) / cores, at: ran(m[5]) }));
}
// vm_stat (a Mac): what Activity Monitor calls memory used - the apps' own, wired, compressed. -> bytes, or 0
function vmUsed(text) {
  const page = Number((/page size of (\d+) bytes/.exec(text) || [])[1]) || 0, n = (k) => Number((new RegExp(k + ':\\s+(\\d+)').exec(text) || [])[1]) || 0;
  const apps = n('Anonymous pages') - n('Pages purgeable');
  return page && apps > 0 ? (apps + n('Pages wired down') + n('Pages occupied by compressor')) * page : 0;
}

const gb = (b) => (b / 1073741824 >= 10 ? Math.round(b / 1073741824) : Math.round(b / 107374182.4) / 10) + ' GB';
const WORD = { ram: '記憶體', cpu: 'CPU ' };

// ops: settings() -> {on, ram, cpu}; os (a stand-in), vm() -> vm_stat's text (a Mac; a promise), procs() -> procs (a promise),
// sessions(), own (the board's pid), notices {open, close, isOpen}, tell(title, text), recall(), remember(state)
class Machine {
  constructor(ops) {
    this.ops = ops; this.os = ops.os || os; this.was = null; this.ram = null; this.cpu = null; this.ramAt = 0; this.vmBusy = false; this.top = null; this.asking = null;
    const st = (ops.recall && ops.recall()) || {};
    // a notice still open from before the board was restarted: it is closed when it eases, as if it had been told now
    this.st = Object.fromEntries(['ram', 'cpu'].map((k) => [k, { since: 0, under: 0, told: Number(st[k]) || 0, on: !!(ops.notices && ops.notices.isOpen && ops.notices.isOpen('machine:' + k)), busy: false }]));
  }
  settings() { const v = (this.ops.settings && this.ops.settings()) || {}; return { on: v.on !== false, ram: okPct(v.ram) ? v.ram : DEFAULTS.ram, cpu: okPct(v.cpu) ? v.cpu : DEFAULTS.cpu }; }
  // what the page shows: the last look
  now() { const t = this.os.totalmem(), s = this.settings(); return { ram: this.ram == null ? null : Math.round(this.ram), cpu: this.cpu == null ? null : Math.round(this.cpu), total: t, left: this.ram == null ? null : Math.round(t * (1 - this.ram / 100)), cores: this.cores(), alert: s, over: ['ram', 'cpu'].filter((k) => this.st[k].on) }; }
  cores() { return this.n || (this.n = Math.max(1, this.os.cpus().length)); }

  look(now = Date.now()) {
    const c = sumCpu(this.os.cpus()), p = cpuPct(this.was, c); this.was = c; if (p != null) this.cpu = p;
    if (!this.ops.vm) { const t = this.os.totalmem(); if (t > 0) this.ram = (1 - this.os.freemem() / t) * 100; return; }
    if (this.vmBusy || now - this.ramAt < RAM_EVERY_MAC) return;
    this.vmBusy = true; this.ramAt = now;
    Promise.resolve().then(() => this.ops.vm()).then((x) => { const u = vmUsed(x); if (u) this.ram = Math.min(100, (u / this.os.totalmem()) * 100); }).catch(() => {}).then(() => { this.vmBusy = false; });
  }

  tick(now = Date.now()) {
    // the computer slept (or the board was held up): what was counted before is not what was seen
    if (this.last && (now - this.last > 6 * EVERY || now < this.last)) for (const k of ['ram', 'cpu']) this.st[k].since = this.st[k].under = 0;
    this.last = now;
    this.look(now);
    const s = this.settings(), jobs = [];
    for (const k of ['ram', 'cpu']) {
      const x = this.st[k], v = this[k];
      if (!s.on) { if (x.on) { this.ops.notices.close('machine:' + k, 'machine off'); x.on = false; } x.since = x.under = 0; continue; }
      if (v == null) continue;
      if (v >= s[k]) { x.under = 0; if (!x.since) x.since = now; } else x.since = 0;
      if (x.on) {
        if (v >= s[k] - EASE_BY) x.under = 0;
        else if (!x.under) x.under = now;
        else if (now - x.under >= EASE) { this.ops.notices.close('machine:' + k, 'eased'); x.on = false; x.under = 0; }
      } else if (x.since && now - x.since >= HOLD[k] && !x.busy && now - x.told >= AGAIN) {
        x.busy = true;
        jobs.push(this.alert(k, v, s[k], now).catch(() => {}).then(() => { x.busy = false; }));
      }
    }
    return Promise.all(jobs);
  }
  async alert(k, v, at, now) {
    let who = []; try { who = (await this.ask()).slice().sort((a, b) => (k === 'ram' ? b.mem - a.mem : b.cpu - a.cpu)).slice(0, 3); } catch (e) {}
    const x = this.st[k]; if (!this.settings().on || !x.since) return;   // turned off meanwhile, or no longer over
    const size = (g) => (k === 'ram' ? gb(g.mem) : Math.round(g.cpu) + '%');
    const title = WORD[k] + '用了 ' + Math.round(v) + '%';
    const text = '超過你設的 ' + at + '% 已經 ' + HOLD[k] / 60000 + ' 分鐘' + (k === 'ram' ? '，剩 ' + gb(this.os.totalmem() * (1 - v / 100)) : '') + '。' + (who.length ? '用最多的：' + who.map((g) => g.name + ' ' + size(g)).join('、') : '查不到是誰用最多');
    // the conversation that uses most of it: pressing the notice opens it
    this.ops.notices.open({ key: 'machine:' + k, kind: 'machine', sessionId: who.length && who[0].sessionId ? who[0].sessionId : '', title, text });
    x.on = true; x.told = now; x.under = 0;
    if (this.ops.remember) this.ops.remember({ ram: this.st.ram.told, cpu: this.st.cpu.told });
    if (this.ops.tell) this.ops.tell(title, text);
  }
  // Who uses what, put together. Asked once at a time, and kept ten seconds (pressed again, it is the same answer).
  // (a Mac tells when a process started to the second: slack)
  ask(now = Date.now()) {
    if (this.top && now - this.top.at < 10000) return Promise.resolve(this.top.list);
    if (!this.asking) this.asking = Promise.resolve().then(() => this.ops.procs()).then((p) => { const list = group(p, this.ops.sessions ? this.ops.sessions() : [], this.ops.own, this.ops.vm ? 2000 : 0); this.top = { at: Date.now(), list }; return list; }).finally(() => { this.asking = null; });
    return this.asking;
  }
}

module.exports = { Machine, DEFAULTS, EVERY, okPct, cpuPct, sumCpu, group, fromWindows, fromPs, vmUsed, gb };