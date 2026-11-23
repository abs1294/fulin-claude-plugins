'use strict';
// Everything said in every conversation on this computer - by you, by Claude, and what Claude did (the commands, the files
// and searches it named; not what they printed) - kept so a search looks at all of it (2026-11-23: the box said 「你說過的話」
// and only the first and the latest were looked at; then: 全對話都查). The transcripts are gigabytes; these words are some
// hundred megabytes: read once, in a process of its own (scripts/said-scan.js), and after that only what was added.
// Looked through in a thread of its own (the bottom of this file): a second of reading must not hold the board up.
// ~/.claude/session-board/said.db; it can be deleted at any time, it is made again.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Db = require('./db');

const CHUNK = 4 * 1024 * 1024, MSG_MAX = 100000, FRESH_MS = 60000, VERSION = 2, ANSWER_MS = 25000, DAY_MS = 90000;
const YOU = 0, CLAUDE = 1, DID = 2;
const FIELDS = ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'args', 'subject'], FIELD_MAX = 4000;

function openDb(file) {
  const db = Db.open(file);
  db.exec('PRAGMA journal_mode = WAL');   // the search reads while the scan writes
  db.exec('CREATE TABLE IF NOT EXISTS said_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  const v = db.prepare("SELECT value FROM said_meta WHERE key = 'version'").get();
  if (!v || Number(v.value) !== VERSION) {   // made by another version: made again
    db.exec('BEGIN IMMEDIATE');
    db.exec("DROP TABLE IF EXISTS said; DROP TABLE IF EXISTS said_file; DELETE FROM said_meta");
    db.prepare("INSERT INTO said_meta (key, value) VALUES ('version', ?)").run(VERSION);
    db.exec('COMMIT');
  }
  db.exec('CREATE TABLE IF NOT EXISTS said_file (file TEXT PRIMARY KEY, sid TEXT NOT NULL, size INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS said (file TEXT NOT NULL, who INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS said_by_file ON said (file)');
  return db;
}

// What a line of a transcript has for the search -> [{who, at, text}]
const ASSISTANT = Buffer.from('"type":"assistant"');
function wordsOf(line) {
  const Past = require('./past');
  if (line.indexOf(ASSISTANT) >= 0) {
    let j; try { j = JSON.parse(line.toString('utf8')); } catch (e) { return []; }
    if (j.type === 'assistant' && !j.isSidechain && j.message && Array.isArray(j.message.content)) {
      const at = Date.parse(j.timestamp) || 0, out = [];
      for (const b of j.message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ who: CLAUDE, at, text: b.text.replace(/\s+/g, ' ').trim().slice(0, MSG_MAX) });
        else if (b && b.type === 'tool_use' && b.input && typeof b.input === 'object') {
          const t = FIELDS.map((k) => (typeof b.input[k] === 'string' ? b.input[k].slice(0, FIELD_MAX) : '')).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          if (t) out.push({ who: DID, at, text: (b.name ? String(b.name) + ' ' : '') + t });
        }
      }
      return out;
    }
  }
  const t = Past.saidLine(line, MSG_MAX);
  return t && t.text && t.text !== '（圖片）' && !t.board ? [{ who: YOU, at: t.at, text: t.text }] : [];
}

// One transcript: what was added since the last look. The size looked at is read and written in one transaction, so two
// boards doing this at once do not put the same words in twice.
function scanFile(db, f) {
  db.exec('BEGIN IMMEDIATE');
  let fd;
  try {
    const had = db.prepare('SELECT size FROM said_file WHERE file = ?').get(f.file);
    let from = had ? Number(had.size) : 0;
    if (from > f.size) { db.prepare('DELETE FROM said WHERE file = ?').run(f.file); from = 0; }   // written anew, shorter
    if (from < f.size) {
      const put = db.prepare('INSERT INTO said (file, who, at, text) VALUES (?, ?, ?, ?)');
      fd = fs.openSync(f.file, 'r');
      const buf = Buffer.allocUnsafe(CHUNK); let rest = [], pos = from;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CHUNK, pos); if (n <= 0) break;
        let start = 0;
        for (;;) {
          const end = buf.indexOf(10, start); if (end < 0 || end >= n) break;
          let line = buf.subarray(start, end);
          if (rest.length) { rest.push(Buffer.from(line)); line = Buffer.concat(rest); rest = []; }
          for (const w of wordsOf(line)) put.run(f.file, w.who, w.at, w.text);
          start = end + 1; from = pos + start;
        }
        if (start < n) rest.push(Buffer.from(buf.subarray(start, n)));
        pos += n;
      }
    }
    db.prepare('INSERT OR REPLACE INTO said_file (file, sid, size) VALUES (?, ?, ?)').run(f.file, f.sessionId, from);   // whole lines only
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (x) {} } }
}

// All of them. -> {files, read, failed}
function scan(dbFile, projectsDir) {
  const db = openDb(dbFile), list = require('./past').files(projectsDir, 0);
  db.exec('CREATE INDEX IF NOT EXISTS said_by_at ON said (at)');   // (here, in a process of its own: it takes a while the first time)
  const known = new Map(db.prepare('SELECT file, size FROM said_file').all().map((r) => [r.file, Number(r.size)]));
  let failed = 0, read = 0;
  for (const f of list) { const k = known.get(f.file); known.delete(f.file); if (k === f.size) continue; try { scanFile(db, f); read++; } catch (e) { failed++; } }
  for (const file of known.keys()) { if (fs.existsSync(file)) continue; db.prepare('DELETE FROM said WHERE file = ?').run(file); db.prepare('DELETE FROM said_file WHERE file = ?').run(file); }
  if (!failed) db.prepare("INSERT OR REPLACE INTO said_meta (key, value) VALUES ('done', ?)").run(Date.now());
  return { files: list.length, read, failed };
}

// -> [[session id, {who, text}]]: for each conversation the latest place, yours before Claude's before what Claude did
function look(dbFile, want) {
  const like = '%' + want.replace(/[\\%_]/g, (c) => '\\' + c) + '%', low = want.toLowerCase(), out = new Map();
  for (const r of openDb(dbFile).prepare("SELECT file, who, text, MIN(who * 100000000000000 - at) AS best FROM said WHERE text LIKE ? ESCAPE '\\' GROUP BY file").all(like)) {
    const f = openDb(dbFile).prepare('SELECT sid FROM said_file WHERE file = ?').get(r.file); if (!f) continue;
    const i = r.text.toLowerCase().indexOf(low), a = Math.max(0, i - 24), had = out.get(f.sid);
    if (!had || r.best < had.best) out.set(f.sid, { best: r.best, who: ['you', 'claude', 'did'][r.who], text: (a ? '…' : '') + r.text.slice(a, a + 90) + (a + 90 < r.text.length ? '…' : '') });
  }
  return [...out].map(([sid, x]) => [sid, { who: x.who, text: x.text }]);
}

// everything said between two times, in order -> [{file, sid, who: 0 you | 1 Claude | 2 what it did, at, text}] (lib/daily.js)
const dayRows = (dbFile, from, to) => openDb(dbFile).prepare('SELECT s.file AS file, f.sid AS sid, s.who AS who, s.at AS at, s.text AS text FROM said s JOIN said_file f ON f.file = s.file WHERE s.at >= ? AND s.at < ? ORDER BY s.at').all(from, to).map((r) => ({ file: r.file, sid: r.sid, who: Number(r.who), at: Number(r.at), text: r.text }));

class SaidIndex {
  constructor(o) { this.dbFile = o.dbFile; this.projectsDir = o.projectsDir; this.spawn = o.spawn || spawn; this.at = 0; this.busy = null; this.worker = null; this.n = 0; this.asked = new Map(); }
  // in a process of its own, at most once a minute. -> Promise
  refresh(now = Date.now()) {
    if (this.busy) return this.busy;
    if (now - this.at < FRESH_MS) return Promise.resolve();
    this.at = now;
    this.busy = new Promise((done) => {
      let p; try { p = this.spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'said-scan.js'), this.dbFile, this.projectsDir], { windowsHide: true, stdio: 'ignore' }); } catch (e) { return done(); }
      p.on('error', () => done()); p.on('exit', () => done());
    }).finally(() => { this.busy = null; });
    return this.busy;
  }
  // has every conversation been looked at, once?
  ready() { try { return !!openDb(this.dbFile).prepare("SELECT value FROM said_meta WHERE key = 'done'").get(); } catch (e) { return false; } }
  // -> Promise of Map session id -> {who: 'you'|'claude'|'did', text: the words around it}
  search(q) {
    const want = String(q || '').replace(/\s+/g, ' ').trim();
    if (!want) return Promise.resolve(new Map());
    return this._worker({ want }).then((rows) => new Map(rows || []));
  }
  // -> the rows, or null: they could not be read (not the same as nothing said that day)
  day(from, to) { return this._worker({ day: [from, to] }, DAY_MS); }
  // the thread that reads; nothing back in time, or no thread: null
  _worker(what, ms = ANSWER_MS) {
    return new Promise((done) => {
      if (!this.worker) {
        try { this.worker = new Worker(__filename, { workerData: { saidDb: this.dbFile } }); } catch (e) { return done(null); }
        this.worker.unref();
        this.worker.on('message', (m) => { const f = this.asked.get(m.id); if (f) f(m.rows); });
        const gone = () => { this.worker = null; for (const f of [...this.asked.values()]) f(null); };
        this.worker.on('error', gone); this.worker.on('exit', gone);
      }
      const id = ++this.n, t = setTimeout(() => finish(null), ms); if (t.unref) t.unref();
      const finish = (rows) => { if (!this.asked.delete(id)) return; clearTimeout(t); done(rows || null); };
      this.asked.set(id, finish);
      // (one not started on yet is for words since typed over: answered empty, not looked for)
      this.worker.postMessage(Object.assign({ id }, what));
    });
  }
  async close() { const w = this.worker; this.worker = null; if (w) await w.terminate(); }
}

if (!isMainThread && workerData && workerData.saidDb) {
  let next = null;
  parentPort.on('message', (m) => {
    if (m.day) { let rows = null; try { rows = dayRows(workerData.saidDb, m.day[0], m.day[1]); } catch (e) {} return parentPort.postMessage({ id: m.id, rows }); }
    if (next) parentPort.postMessage({ id: next.id, rows: [] });
    const start = !next; next = m;
    if (start) setImmediate(() => { const x = next; next = null; let rows = []; try { rows = look(workerData.saidDb, x.want); } catch (e) { /* not there yet: the titles are searched all the same */ } parentPort.postMessage({ id: x.id, rows }); });
  });
}

module.exports = { SaidIndex, scan };
