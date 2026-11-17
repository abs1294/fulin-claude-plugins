'use strict';
// Facts about one project folder from three more plugins, for the office's rooms. Read from what each leaves on disk,
// or asked of its own tool; nothing of theirs is changed except by rebuildIndex, which runs only when you press for it.
//   git            the repository the folder is in: commits not pushed, files not committed (plain git)
//   qa-webwright   the last test runs: <folder>/tests/e2e/.runs/results.sqlite (new layout), else the newest JUnit
//                  reports in <folder>/tests/e2e/reports/*.xml (both written by qa-webwright's qa-flow.sh)
//   cbm-guard      whether the code index of each repository is older than its last commit: cbm-guard's own
//                  scripts/cbm_index_freshness.py (about 20 s, so it is asked in the background and kept 30 min)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const runGit = (cwd, args, run) => new Promise((resolve) => (run || execFile)('git', ['-C', cwd].concat(args), { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (e, out) => resolve(e ? null : String(out || '').trim())));

// -> {root, name, branch, unpushed (null: no upstream), uncommitted} or null when the folder is not in a repository
async function gitOf(folder, o = {}) {
  const top = await runGit(folder, ['rev-parse', '--show-toplevel'], o.run); if (!top) return null;
  const [ahead, dirty, branch] = await Promise.all([runGit(top, ['rev-list', '--count', '@{u}..HEAD'], o.run), runGit(top, ['status', '--porcelain'], o.run), runGit(top, ['rev-parse', '--abbrev-ref', 'HEAD'], o.run)]);
  return { root: path.normalize(top), name: path.basename(top), branch: branch || '', unpushed: ahead == null ? null : Number(ahead) || 0, uncommitted: dirty == null ? 0 : dirty.split('\n').filter(Boolean).length };
}

// The last test runs in a folder. -> {source, at, tests, failed, skipped, runs: [{name, at, tests, failed, skipped}]} or null
function qaOf(folder, o = {}) {
  const e2e = path.join(folder, 'tests', 'e2e');
  if (!fs.existsSync(e2e)) return null;
  const db = path.join(e2e, '.runs', 'results.sqlite');
  if (fs.existsSync(db) && o.sqlite) {
    try {
      const d = new o.sqlite(db, { readOnly: true });
      try {
        const last = d.prepare('SELECT run_id, MAX(started_at) AS at FROM runs GROUP BY run_id ORDER BY at DESC LIMIT 5').all();
        const runs = last.map((r) => {
          const rows = d.prepare('SELECT outcome, COUNT(*) AS n, MAX(batch) AS batch FROM runs WHERE run_id = ? GROUP BY outcome').all(r.run_id);
          const n = (k) => rows.filter((x) => k.test(String(x.outcome))).reduce((a, x) => a + x.n, 0);
          return { name: (rows[0] && rows[0].batch) || String(r.run_id), at: Date.parse(r.at) || Number(r.at) || 0, tests: rows.reduce((a, x) => a + x.n, 0), failed: n(/fail|error/i), skipped: n(/skip/i) };
        });
        if (runs.length) return Object.assign({ source: 'sqlite' }, runs[0], { runs });
      } finally { try { d.close(); } catch (e) {} }
    } catch (e) {}
  }
  const dir = path.join(e2e, 'reports');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => /\.xml$/i.test(n)).map((n) => ({ n, f: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 5); } catch (e) {}
  const runs = [];
  for (const x of files) {
    let head = '';
    try { const fd = fs.openSync(x.f, 'r'); const b = Buffer.alloc(2048); const k = fs.readSync(fd, b, 0, 2048, 0); fs.closeSync(fd); head = b.toString('utf8', 0, k); } catch (e) { continue; }
    const suite = /<testsuite\b([^>]*)>/.exec(head); if (!suite) continue;
    const at = (k) => { const m = new RegExp('\\b' + k + '="([^"]*)"').exec(suite[1]); return m ? m[1] : ''; };
    const num = (k) => Number(at(k)) || 0;
    runs.push({ name: x.n.replace(/\.xml$/i, '').replace(/-\d{4}-\d{2}-\d{2}$/, ''), at: Date.parse(at('timestamp')) || x.t, tests: num('tests'), failed: num('failures') + num('errors'), skipped: num('skipped') });
  }
  if (!runs.length) return null;
  return Object.assign({ source: 'junit' }, runs[0], { runs });
}

// cbm-guard's check, as it prints it. -> {ok, code, repos: [{repo, state: fresh|stale|missing, hours?, why?}], fixes: [command]}
function parseFreshness(text, code) {
  const repos = [];
  for (const line of String(text || '').split('\n')) {
    let m = /^\s*\[新鮮\]\s+(\S+)/.exec(line); if (m) { repos.push({ repo: m[1], state: 'fresh' }); continue; }
    m = /^\s*\[過期\]\s+(\S+).*?落後 HEAD ([\d.]+) 小時/.exec(line); if (m) { repos.push({ repo: m[1], state: 'stale', hours: Number(m[2]) }); continue; }
    m = /^\s*\[缺\]\s+(\S+)\s+(.*)$/.exec(line); if (m) repos.push({ repo: m[1], state: 'missing', why: m[2].trim() });
  }
  const fixes = String(text || '').split('\n').filter((l) => /index_repository/.test(l)).map((l) => l.trim());
  return { ok: code === 0 || code === 1 || code === 2, code, repos, fixes };
}
function cbmCheck(folder, script, o = {}) {
  return new Promise((resolve) => (o.run || execFile)(o.python || (process.platform === 'win32' ? 'python' : 'python3'), [script, '--root', folder, '--fix'], { windowsHide: true, timeout: 120000, encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) },
    (err, out) => resolve(parseFreshness(out, err ? (typeof err.code === 'number' ? err.code : -1) : 0))));
}
// One repository's index made again, with the command cbm-guard printed for it (only that form is accepted).
function rebuildIndex(fix, o = {}) {
  const m = /^"([^"]+codebase-memory-mcp(?:\.exe)?)" cli --quiet index_repository '(\{"repo_path":"[^"']+"\})'$/.exec(String(fix || '').trim());
  if (!m) return Promise.resolve({ ok: false, error: '不是 cbm-guard 給的重建指令' });
  return new Promise((resolve) => (o.run || execFile)(m[1], ['cli', '--quiet', 'index_repository', m[2]], { windowsHide: true, timeout: 600000, encoding: 'utf8' },
    (err, out, errOut) => resolve(err ? { ok: false, error: String(errOut || err.message).slice(0, 300) } : { ok: true })));
}

module.exports = { gitOf, qaOf, parseFreshness, cbmCheck, rebuildIndex };
