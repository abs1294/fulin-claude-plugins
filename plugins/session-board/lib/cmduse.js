'use strict';
// How often each slash command was used on this computer: counted from Claude Code's own records (every conversation's
// .jsonl under ~/.claude/projects), where a command you ran is a user entry that starts with <command-name>/x</command-name>.
// Not live: counted in the background every few minutes, and of each file only what was added since the last count is
// read (a file that shrank or was replaced is counted again). Only the recent files are looked at.
const fs = require('fs');
const path = require('path');

// A command record starts with Claude Code's tags (<command-message>, <command-name>, <command-args>, in either order);
// the name is the one in <command-name>.
const LEAD = /^\s*<command-(name|message|args)>/;
const TAG = /<command-name>\/([^<\s]+)<\/command-name>/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) { const t = content.find((x) => x && x.type === 'text'); return t ? String(t.text || '') : ''; }
  return '';
}

// The command a record line is, or '' (only lines you typed a command in; a summary that mentions one is not one).
function commandOf(line) {
  if (line.indexOf('<command-name>/') < 0) return '';
  let e; try { e = JSON.parse(line); } catch (x) { return ''; }
  if (!e || e.type !== 'user' || e.isCompactSummary || !e.message) return '';
  const t = textOf(e.message.content);
  if (!LEAD.test(t)) return '';
  const m = TAG.exec(t);
  return m ? m[1] : '';
}

function create(opts) {
  const dir = opts.projectsDir;
  const maxFiles = opts.maxFiles || 300;
  const maxAgeDays = opts.maxAgeDays || 60;
  const files = new Map();   // path -> { size, ino, counts: Map name -> n } (a command called constructor is just a name)
  let total = Object.create(null), at = 0, busy = null, started = false;

  // Reads p from start to end and calls back with each line that names a command. The bytes are searched as they are
  // (no text decoding, no splitting into lines): only the few lines with the tag are turned into text and read. A last
  // line without its newline may still be being written: left for the next count (the position returned stops before it).
  const NEEDLE = Buffer.from('<command-name>/');
  async function readFrom(p, start, end, onLine) {
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(1 << 20); let pos = start, carry = Buffer.alloc(0), done = start;
      while (pos < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const last = data.lastIndexOf(10);
        if (last < 0) { carry = Buffer.from(data); continue; }
        for (let i = data.indexOf(NEEDLE); i >= 0 && i < last; i = data.indexOf(NEEDLE, i + 1)) {
          const ls = data.lastIndexOf(10, i) + 1, le = data.indexOf(10, i);
          onLine(data.toString('utf8', ls, le)); i = le;
        }
        done = pos - (data.length - last - 1);
        carry = Buffer.from(data.subarray(last + 1));
      }
      return done;
    } finally { await fh.close(); }
  }

  async function count() {
    let found = [];
    let dirs = []; try { dirs = await fs.promises.readdir(dir); } catch (e) { dirs = []; }
    const since = Date.now() - maxAgeDays * 86400000;
    for (const d of dirs) {
      let names = []; try { names = await fs.promises.readdir(path.join(dir, d)); } catch (e) { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const p = path.join(dir, d, n);
        try { const st = await fs.promises.stat(p); if (st.mtimeMs >= since) found.push({ p, st }); } catch (e) {}
      }
    }
    found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    found = found.slice(0, maxFiles);
    const keep = new Set(found.map((f) => f.p));
    for (const p of [...files.keys()]) if (!keep.has(p)) files.delete(p);
    for (const { p, st } of found) {
      let f = files.get(p);
      if (!f || st.size < f.size || (f.ino && st.ino && st.ino !== f.ino)) { f = { size: 0, ino: st.ino, counts: new Map() }; files.set(p, f); }
      if (st.size === f.size) continue;
      try {
        f.size = await readFrom(p, f.size, st.size, (line) => { const c = commandOf(line); if (c) f.counts.set(c, (f.counts.get(c) || 0) + 1); });
        await new Promise((r) => setImmediate(r));   // the board answers pages between files
      } catch (e) { /* unreadable now: tried again next time */ }
    }
    const t = Object.create(null);
    for (const f of files.values()) for (const [k, v] of f.counts) t[k] = (t[k] || 0) + v;
    total = t; at = Date.now();
    return total;
  }

  // Started in the background; whoever asks meanwhile gets the last count.
  function refresh() { if (!busy) busy = count().catch(() => total).finally(() => { busy = null; }); return busy; }
  return {
    usage: () => total,
    countedAt: () => at,
    started: () => started,   // counting on a schedule (the board running), not merely made (a test)
    refresh,
    start(every = 15 * 60000, delay = 60000) {
      started = true;
      const a = setTimeout(refresh, delay); if (a.unref) a.unref();
      const b = setInterval(refresh, every); if (b.unref) b.unref();
      return () => { clearTimeout(a); clearInterval(b); };
    },
  };
}

module.exports = { create, commandOf };
