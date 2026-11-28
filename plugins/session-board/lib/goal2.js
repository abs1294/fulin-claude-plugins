'use strict';
// The goal2 plugin's runs, on the board: what each was asked to reach, how it went, what it cost - and a way to stop
// one that is still going.
//
// goal2 (another plugin of this marketplace) runs Claude Code's /goal engine headless until a stated condition holds,
// and keeps every run in ~/.claude/goal2/runs/<id>/. The board never reads or touches that folder itself: it is shared
// by every session on the machine, and goal2 guards it (its own hook stops bulk changes to it). Everything goes through
// goal2's own tool, the way its skill does:
//     node <goal2>/skills/goal/goal.js --list            every run, with whether its process is alive
//     node <goal2>/skills/goal/goal.js --status <dir>    one run in detail: the verdict, the ledger, the last words
//     node <goal2>/skills/goal/goal.js --stop <dir>      ask a running one to stop
//     node <goal2>/skills/goal/goal.js --pending         (goal2 0.8.0) runs that ended with nobody waiting for them:
//                                                         each says which conversation started it and what to tell it
//     node <goal2>/skills/goal/goal.js --claim|--release <dir> --by board   who tells it - only one of the conversation's
//                                                         own wait, the board, and goal2's hook in that conversation does
// Measured 2026-11-16 with a plain node process as the parent: --list 0.24 s for 63 runs; a run started that way ran
// to "done" (the engine does not need Claude Code to stay open).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TOOL = path.join('skills', 'goal', 'goal.js');
const vnum = (v) => String(v || '0').split('.').map((x) => Number(x) || 0).reduce((a, x) => a * 1000 + x, 0);

// Where goal2 is: beside this plugin (the plugins' own folder, as in the marketplace's source) or wherever Claude Code
// installed it. -> the plugin's root, or null when goal2 is not on this computer.
function findGoal2(o = {}) {
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  const cands = [path.join(o.here || path.join(__dirname, '..'), '..', 'goal2')];
  try {
    const j = JSON.parse(fs.readFileSync(o.installed || path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const list = ((j && j.plugins) || {})['goal2@fulin-plugins'] || [];
    for (const e of list.slice().sort((a, b) => vnum(b.version) - vnum(a.version))) if (e && e.installPath) cands.push(e.installPath);
  } catch (e) {}
  for (const c of cands) if (exists(path.join(c, TOOL))) return path.normalize(c);
  return null;
}

// env: the board's own, without the variables that say "inside session X" (K.cleanEnv) - goal2 0.8.0 notes the
// session a run is prepared in as the one to tell when it ends, and the board is not a session (a board started
// from a terminal session's command would otherwise pass that session's id on: a schedule's run "told" to it).
function tool(root, args, run, timeout = 20000, env) {
  return new Promise((resolve) => {
    (run || execFile)(process.execPath, [path.join(root, TOOL)].concat(args), Object.assign({ windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, env ? { env } : {}),
      (err, stdout, stderr) => { let j = null; try { j = JSON.parse(String(stdout || '')); } catch (e) {} resolve(j || { ok: false, error: String(stderr || (err && err.message) || 'goal2 沒有回應').trim().slice(-300) }); });
  });
}

// The words for a run's state, as they are shown.
const STATUS = { prepared: '準備好未執行', scheduled: '已排程', running: '執行中', done: '達成', unverified: '做完但沒驗證到', impossible: '判定做不到', timeout: '超過時限', budget: '超過預算', stopped: '已停止', failed: '失敗', spawn_failed: '沒啟動成功', unknown: '不明' };

class Goal2 {
  constructor(o = {}) { this.o = o; this.cache = null; }
  root() { if (this.o.root !== undefined) return this.o.root; if (this._root === undefined || !this._root) this._root = findGoal2(this.o); return this._root; }
  // -> {installed, runs: [...newest first]}   (read at most every 4 seconds: the page asks often)
  async list() {
    const root = this.root();
    if (!root) return { installed: false, runs: [] };
    if (this.cache && Date.now() - this.cache.at < 4000) return this.cache.data;
    const j = await tool(root, ['--list'], this.o.run, 20000, this.o.env);
    if (!j.ok) return { installed: true, error: j.error || 'goal2 讀不到執行紀錄', runs: [] };
    const runs = (j.runs || []).map((x) => ({ runId: x.runId, skill: x.skill, aliveState: x.alive_state || '', status: x.alive && (x.status === 'running' || x.status === 'prepared') ? 'running' : x.status, alive: !!x.alive, cwd: x.cwd || '', condition: x.condition || '', createdAt: x.createdAt || null, startedAt: x.startedAt || null, endedAt: x.endedAt || null, scheduledFor: x.scheduledFor || null }))
      .sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
    const data = { installed: true, version: j.plugin_version || '', runs, dirOf: Object.fromEntries((j.runs || []).map((x) => [x.runId, x.runDir])) };
    this.cache = { at: Date.now(), data };
    return data;
  }
  // The folder of a run, only as goal2 itself listed it - never one made from what the page sent.
  async dir(runId) { const l = await this.list(); return (l.dirOf && l.dirOf[String(runId)]) || null; }
  async status(runId) {
    const d = await this.dir(runId); if (!d) return { ok: false, error: '找不到這一筆 goal' };
    const j = await tool(this.root(), ['--status', d], this.o.run, 20000, this.o.env);
    if (!j.ok) return { ok: false, error: j.error || '讀不到' };
    const pick = ['run_id', 'skill', 'status', 'alive', 'scheduled_for', 'waiter_state', 'started_at', 'ended_at', 'goal_set', 'goal_verdict', 'goal_error', 'continuations', 'compactions', 'num_turns', 'total_cost_usd', 'last_event_at', 'last_tool', 'last_text', 'progress_md', 'summary_zh'];
    const out = { ok: true }; for (const k of pick) if (j[k] !== undefined) out[k] = j[k];
    try { const m = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')); out.condition = m.condition || ''; out.cwd = m.cwd || ''; } catch (e) {}
    return out;
  }
  // A new run, the way goal2's skill makes one: goal.js prepares it (it checks the task and the condition, and may
  // refuse them), then `goal.js --run` runs it to the end. That second process is started on its own (detached), so a
  // restart of the board does not end it. -> {ok, runId} or {ok: false, error}
  async start(task, condition, cwd) {
    const root = this.root(); if (!root) return { ok: false, error: '這台電腦沒有裝 goal2' };
    const pf = path.join(os.tmpdir(), 'sb-goal-' + process.pid + '-' + Date.now() + '.txt');
    fs.writeFileSync(pf, String(task) + '\n');
    const p = await tool(root, ['--prompt-file', pf, '--goal', String(condition), '--cwd', cwd], this.o.run, 60000, this.o.env);
    try { fs.unlinkSync(pf); } catch (e) {}
    if (!p.ok || !p.run_dir) return { ok: false, error: 'goal2 沒有接下這件事：' + String(p.error || '沒有回應').slice(0, 300) };
    try {
      const child = (this.o.spawn || require('child_process').spawn)(process.execPath, [path.join(root, TOOL), '--run', p.run_dir], { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: this.o.env || process.env });
      child.on('error', () => {}); if (child.unref) child.unref();
    } catch (e) { return { ok: false, error: '啟動不了 goal2：' + String(e.message || e).slice(0, 200) }; }
    this.cache = null;
    return { ok: true, runId: p.run_id };
  }
  // How a run stands now: {status, alive} - or null when goal2 does not list it (yet).
  async state(runId) { this.cache = null; const r = ((await this.list()).runs || []).find((x) => x.runId === String(runId)); return r ? { status: r.status, alive: r.alive } : null; }
  async stop(runId) {
    const l = await this.list(); const r = (l.runs || []).find((x) => x.runId === String(runId));
    if (!r) return { ok: false, error: '找不到這一筆 goal' };
    if (!r.alive) return { ok: false, error: '它已經沒有在跑了' };
    const j = await tool(this.root(), ['--stop', l.dirOf[r.runId]], this.o.run, 30000, this.o.env);
    this.cache = null;
    return j.ok ? { ok: true } : { ok: false, error: j.error || '沒有停下來' };
  }
}

// Runs that ended while the conversation that started them was no longer waiting (closed, or its wait ended):
// [{runDir, runId, status, parentSessionId, parentCwd, message}]. An older goal2 has no --pending: none.
Goal2.prototype.pending = async function () {
  const root = this.root(); if (!root) return [];
  const j = await tool(root, ['--pending'], this.o.run, 20000, this.o.env);
  return j && j.ok && Array.isArray(j.runs) ? j.runs.filter((r) => r && r.runDir && r.parentSessionId && r.message) : [];
};
// Taking (and, when it could not be delivered, giving back) the telling of one run. -> {ok}
Goal2.prototype.claim = async function (dir) { const j = await tool(this.root(), ['--claim', dir, '--by', 'board'], this.o.run, 20000, this.o.env); return { ok: !!(j && j.ok), already: j && j.already, error: j && j.error }; };
Goal2.prototype.release = async function (dir) { const j = await tool(this.root(), ['--release', dir, '--by', 'board'], this.o.run, 20000, this.o.env); return { ok: !!(j && j.ok), error: j && j.error }; };

module.exports = { Goal2, findGoal2, STATUS, TOOL };
