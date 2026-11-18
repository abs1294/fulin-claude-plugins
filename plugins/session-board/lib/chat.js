'use strict';
// Conversations the board itself runs ("channels").
//
// Each channel is one Claude Code session driven through one long-lived
//   claude -p --input-format stream-json --output-format stream-json
// process: messages go in on stdin as they are typed, events come out on
// stdout, and the process stays up between turns (measured 2026-11-12: a second
// message is answered in the same process, same session id). When Claude needs
// an approval it writes a control_request on stdout and waits for a
// control_response on stdin, which is how the page gets to answer.
//
// The process is started on the first message and ended after IDLE_MS without
// one; the next message resumes the session (--resume). A channel is just
// {sessionId, cwd, title}; it is saved to disk, so channels survive a restart
// of the board or the machine and pick up where they were.
//
// One rule this file exists to keep: a session is never run in two places.
// Resuming a session that is still open in a terminal corrupts its transcript.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const IDLE_MS = 15 * 60 * 1000;
const COMMANDS_TTL_MS = 10 * 60 * 1000;   // plugins get installed and removed; ask again after this
const UNSTARTED_MS = 2 * 60 * 1000;   // how long a conversation nothing was sent in is kept once no page has it open
const CLAUDE_BIN = process.env.SESSION_BOARD_CLAUDE || 'claude';

const DONE_KEEP_MS = 10 * 60 * 1000;   // how long a background command stays listed after it ends
// A message as the list of blocks Claude is given. A picture with a tag N stands where the text says "［圖N］": the
// text up to and including that mark, then the picture, then the rest - so Claude sees each picture at the place it
// was pasted. Pictures the text does not name (attached with the button, or their mark deleted) come first, in order.
const PIC_MARK = /(［圖\d{1,2}］)/;
function contentOf(text, images) {
  const img = (x) => ({ type: 'image', source: { type: 'base64', media_type: x.mime, data: x.data } });
  const list = Array.isArray(images) ? images : [];
  const byTag = new Map();
  for (const x of list) if (x.tag && !byTag.has(x.tag) && String(text).includes('［圖' + x.tag + '］')) byTag.set(x.tag, x);
  const content = list.filter((x) => byTag.get(x.tag) !== x).map(img);
  let buf = '';
  for (const part of String(text).split(PIC_MARK)) {
    buf += part;
    const m = /^［圖(\d{1,2})］$/.exec(part), x = m && byTag.get(Number(m[1]));
    if (!x) continue;
    byTag.delete(Number(m[1]));                      // a mark written twice: the picture goes at the first
    content.push({ type: 'text', text: buf }, img(x)); buf = '';
  }
  if (buf.trim() || !content.length) content.push({ type: 'text', text: buf });
  return content;
}



// A role's name as Claude Code writes it: letters, digits, '-', '_', '.', and ':' between a plugin and its role.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];   // claude --effort
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const BUILT_IN_ROLES = new Set(['claude', 'Plan', 'Explore', 'general-purpose', 'statusline-setup', 'claude-code-guide']);

class Channels {
  constructor(file, opts = {}) {
    this.file = file;
    this.transcriptOf = opts.transcriptOf || (() => null);   // (sessionId, cwd) -> path or null
    this.spawn = opts.spawn || spawn;
    this.map = new Map();
    this.deadPids = new Set();   // pids of conversation processes this manager started and saw end
    // Context size per model, learned from the conversations run here (each
    // result says how large its model's window is). Kept on disk so the figure
    // is also known for terminal sessions using the same model.
    this.windowsFile = path.join(path.dirname(file), 'models.json');
    this.modelWindows = {};
    try { const j = JSON.parse(fs.readFileSync(this.windowsFile, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) this.modelWindows = j; } catch (e) {}
    // The agent roles Claude Code said a folder has, the last time a conversation was started there (see roles()).
    this.rolesFile = path.join(path.dirname(file), 'roles.json');
    this.rolesSeen = {};
    try { const j = JSON.parse(fs.readFileSync(this.rolesFile, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) this.rolesSeen = j; } catch (e) {}
    this.homeDir = opts.homeDir || os.homedir();
    this.quotaSnap = null;   // the account limits as last reported to a conversation run here
    this.wakeGraceMs = opts.wakeGraceMs === undefined ? 6000 : opts.wakeGraceMs;   // see status()
    // Slash commands per folder, asked from Claude Code itself (see commandsFor).
    this.commandCache = new Map();   // folder (lower-cased) -> {at, commands}
    this.commandJobs = new Map();    // folder -> the request in flight, so two askers share one process
    for (const c of this._load()) this.map.set(c.sessionId, this._wrap(c));
    this.timer = setInterval(() => this._reap(), 60000);
    if (this.timer.unref) this.timer.unref();
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(j) ? j.filter((c) => c && typeof c.sessionId === 'string' && typeof c.cwd === 'string') : [];
    } catch (e) { return []; }
  }

  _save() {
    const data = [...this.map.values()].map((c) => ({
      sessionId: c.sessionId, cwd: c.cwd, title: c.title, createdAt: c.createdAt,
      lastResultAt: c.lastResultAt, lastSeenAt: c.lastSeenAt, changedAt: c.changedAt,
      cost: c.cost, tok: c.tok,
      // set by a schedule: start without asking for approvals; start as a copy of another session (see _start)
      skipPermissions: c.skipPermissions || undefined, forkOf: c.forkOf || undefined, resumeAt: c.resumeAt || undefined,
      // what you ran with "!" and have not sent yet (noteShell)
      shellNotes: c.shellNotes && c.shellNotes.length ? c.shellNotes : undefined, shellSeq: c.shellSeq || undefined,
      // the agent role this conversation runs as (see roles()); none = an ordinary conversation
      agent: c.agent || undefined,
      model: c.model || undefined, effort: c.effort || undefined, modelSeen: c.modelSeen || undefined,   // the model it was switched to (setModel); none = Claude Code's default
      mode: c.mode || undefined,   // the permission mode its process last said it runs in
    }));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {}
  }

  _wrap(c) {
    const fin = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    return Object.assign({ title: '', createdAt: Date.now(), lastResultAt: 0, lastSeenAt: 0, changedAt: Date.now() }, c,
      { cost: fin(c.cost), tok: fin(c.tok), procCost: 0, procTok: 0, proc: null, state: 'off', pending: new Map(), tasks: new Map(), listeners: new Set(), lastActivity: Date.now(), stderr: '', buf: '' });
  }

  _saveWindows() { try { fs.mkdirSync(path.dirname(this.windowsFile), { recursive: true }); fs.writeFileSync(this.windowsFile, JSON.stringify(this.modelWindows, null, 2)); } catch (e) {} }

  has(sid) { return this.map.has(sid); }
  get(sid) { return this.map.get(sid) || null; }
  list() { return [...this.map.values()]; }

  create(cwd, sessionId) {
    const c = this._wrap({ sessionId: sessionId || crypto.randomUUID(), cwd });
    this.map.set(c.sessionId, c);
    this._save();
    return c;
  }

  // The agent roles a conversation in this folder can be started as: [{name, from}], from = 'project' (the folder's
  // .claude/agents), 'user' (~/.claude/agents), 'plugin' (brought by a plugin). Two sources, joined: the role files,
  // read now; and the list Claude Code itself reported the last time a conversation was started in the folder, which
  // is the only place a plugin's roles show (so those appear after the first conversation there). The built-in
  // helpers (search, planning ...) are left out: they are not something to hand a piece of work to.
  roles(cwd) {
    const names = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).filter((n) => ROLE_NAME.test(n)); } catch (e) { return []; } };
    const project = names(path.join(cwd, '.claude', 'agents')), user = names(path.join(this.homeDir, '.claude', 'agents'));
    const seen = Array.isArray(this.rolesSeen[String(cwd).toLowerCase()]) ? this.rolesSeen[String(cwd).toLowerCase()].filter((n) => typeof n === 'string' && ROLE_NAME.test(n)) : [];
    const out = new Map();
    for (const n of project) out.set(n, 'project');
    for (const n of user) if (!out.has(n)) out.set(n, 'user');
    for (const n of seen) if (!out.has(n) && n.includes(':')) out.set(n, 'plugin');
    // What each is for: the description line at the top of its role file. A plugin's role file is in that plugin's installed folder.
    const desc = (file) => { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, 8192, 0); fs.closeSync(fd); const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(b.toString('utf8', 0, n)); const m = head && /^description:\s*(.+)$/m.exec(head[1]); return m ? m[1].trim().replace(/^["'>|]+\s*|["']+$/g, '').replace(/\s+/g, ' ').slice(0, 200) : ''; } catch (e) { return ''; } };
    let installed = null;
    const pluginFile = (name) => {
      const [plugin, role] = name.split(':');
      if (installed === null) { try { installed = JSON.parse(fs.readFileSync(path.join(this.homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch (e) { installed = {}; } }
      for (const [id, list] of Object.entries(installed)) { if (id.split('@')[0] !== plugin) continue; for (const x of Array.isArray(list) ? list : []) { const f = x && x.installPath ? path.join(x.installPath, 'agents', role + '.md') : ''; if (f && fs.existsSync(f)) return f; } }
      return '';
    };
    const fileOf = (name, from) => (from === 'project' ? path.join(cwd, '.claude', 'agents', name + '.md') : from === 'user' ? path.join(this.homeDir, '.claude', 'agents', name + '.md') : pluginFile(name));
    return [...out.entries()].filter(([n]) => !BUILT_IN_ROLES.has(n)).map(([name, from]) => { const f = fileOf(name, from); return { name, from, desc: f ? desc(f) : '' }; });
  }

  // Sets (or with '' clears) the role of a conversation. Only before anything was said in it: a conversation does not change role halfway.
  setAgent(sid, name) {
    const c = this.map.get(sid);
    if (!c) return { ok: false, error: '這不是看板裡的對話' };
    if (!this.isEmpty(c)) return { ok: false, error: '對話已經開始了，角色只能在送出第一句話之前選' };
    if (name && !this.roles(c.cwd).some((r) => r.name === name)) return { ok: false, error: '這個資料夾沒有這個角色：' + String(name).slice(0, 80) };
    c.agent = name || undefined;
    this._save();
    return { ok: true, agent: c.agent || '' };
  }

  // Forget a channel. The session itself (its transcript) is untouched.
  // Takes a conversation off the board only if nothing was ever said in it: no message sent or waiting,
  // no process started, no reply, no transcript. For the "+" pressed and then left alone. -> whether it was removed.
  removeIfEmpty(sid) {
    const c = this.map.get(sid);
    return !!c && this.isEmpty(c) && this.remove(sid);
  }

  // A conversation that has not started: nothing was ever sent in it. It is a place to type the first message,
  // not a session yet - the list does not show it, and one nobody is looking at is forgotten (see _reap).
  isEmpty(c) {
    if (c.title || c.proc || c.lastResultAt || c.pending.size || c.tasks.size || (c.shellNotes && c.shellNotes.length)) return false;
    return !this.transcriptOf(c.sessionId, c.cwd);
  }

  remove(sid) {
    const c = this.map.get(sid);
    if (!c) return false;
    this.stop(sid);
    for (const res of c.listeners) { try { res.end(); } catch (e) {} }
    this.map.delete(sid);
    this._save();
    if (this.onGone) { try { this.onGone(sid); } catch (e) {} }
    return true;
  }

  // busy = Claude is working; waiting = an approval is pending;
  // idle / off = the turn is over (off: no process, the next message resumes).
  // background = the turn is over, but subagents or background commands it
  //   started are still running. Claude Code wakes the conversation by itself
  //   when they finish and it reports then (measured 2026-11-12), so this is
  //   NOT idle: the process must be kept, and the page must not say "standing by".
  status(c) {
    if (c.pending.size) return 'waiting';
    if (c.state === 'busy') return 'busy';
    // The last background task ending is followed, a moment later, by the turn
    // in which Claude reports it. For that moment the conversation is neither
    // "has tasks" nor "busy" yet; wakeUntil bridges it so it is not shown (or
    // stopped) as idle in between.
    return c.tasks.size || Date.now() < (c.wakeUntil || 0) ? 'background' : 'idle';
  }

  // Conversations that would lose work if their process were ended now.
  active() {
    return [...this.map.values()].filter((c) => c.proc && this.status(c) !== 'idle')
      .map((c) => ({ sessionId: c.sessionId, title: c.title, status: this.status(c), tasks: c.tasks.size }));
  }

  _taskList(c) {
    // Running ones, then the ones that ended in the last DONE_KEEP_MS (so their output can still be looked at).
    const now = Date.now();
    c.doneTasks = (c.doneTasks || []).filter((t) => now - t.endedAt < DONE_KEEP_MS);
    const view = (t) => ({ id: t.id, kind: t.kind, name: t.name, description: t.description, lastTool: t.lastTool, toolUses: t.toolUses, startedAt: t.startedAt, background: t.background,
      done: !!t.endedAt, endedAt: t.endedAt || 0, status: t.status || '', canOpen: t.kind === 'command' && !!this._taskFile(c, t) });
    return [...c.tasks.values()].map(view).concat(c.doneTasks.map(view));
  }

  // Where a background command's output is being written. Claude Code names the file twice: in the result
  // of the tool call that started the command ("Output is being written to: …", while it runs), and in
  // the notice that it ended (output_file). Seen 2026-11-13.
  _taskFile(c, t) { return t.output || (t.toolUseId && c.bgOut && c.bgOut.get(t.toolUseId)) || ''; }

  // A background command, for looking at: {description, command, path, running, status, summary} or null.
  // The path is one this process learned from Claude Code for this conversation - never one a caller supplies.
  taskInfo(sid, id) {
    const c = this.map.get(sid);
    if (!c) return null;
    this._taskList(c);
    const t = c.tasks.get(id) || (c.doneTasks || []).find((x) => x.id === id);
    if (!t) return null;
    return { description: t.description, kind: t.kind, command: (t.toolUseId && c.bgCmd && c.bgCmd.get(t.toolUseId)) || '', path: this._taskFile(c, t), running: !t.endedAt, status: t.status || '', summary: t.summary || '', startedAt: t.startedAt, endedAt: t.endedAt || 0 };
  }

  // What the conversation has running besides the reply itself: subagents and
  // background commands, as Claude Code reports them (system/task_* events).
  // Work a subagent starts for itself is left out: its parent is what is shown.
  _onTask(c, e) {
    const before = JSON.stringify(this._taskList(c));
    const id = typeof e.task_id === 'string' ? e.task_id : '';
    const kindOf = (t) => (t === 'local_agent' ? 'agent' : 'command');
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    if (e.subtype === 'task_started' && id && !e.owned_by_subagent && !e.parent_task_id) {
      c.tasks.set(id, { id, kind: kindOf(e.task_type), name: str(e.subagent_type, 80), description: str(e.description, 200), lastTool: '', toolUses: 0, startedAt: Date.now(), background: !!e.is_backgrounded, toolUseId: str(e.tool_use_id, 80) });
    } else if (e.subtype === 'task_progress' && c.tasks.has(id)) {
      const t = c.tasks.get(id);
      t.lastTool = str(e.last_tool_name, 80);
      if (e.usage && Number.isFinite(e.usage.tool_uses)) t.toolUses = e.usage.tool_uses;
      if (typeof e.description === 'string' && e.description) t.doing = str(e.description, 200);
    } else if ((e.subtype === 'task_notification' && e.status) || (e.subtype === 'task_updated' && e.patch && e.patch.status && e.patch.status !== 'running')) {
      // Kept for a while after it ends, with where its output is: "what did that command print" is asked afterwards.
      const t = c.tasks.get(id);
      const done = (c.doneTasks = c.doneTasks || []);
      const rec = t || done.find((x) => x.id === id);
      if (rec) {
        rec.endedAt = rec.endedAt || Date.now();
        rec.status = str(e.status || (e.patch && e.patch.status), 40) || rec.status || 'completed';
        if (e.output_file) rec.output = str(e.output_file, 1000);
        if (e.summary) rec.summary = str(e.summary, 300);
        if (t) { done.unshift(t); if (done.length > 5) done.length = 5; }
      }
      c.tasks.delete(id);
    } else if (e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks)) {
      // The authoritative list of what is still running in the background.
      const still = new Set(e.tasks.map((t) => t && t.task_id));
      for (const t of c.tasks.values()) if (t.background && !still.has(t.id)) c.tasks.delete(t.id);
      for (const t of e.tasks) {
        if (t && typeof t.task_id === 'string' && !c.tasks.has(t.task_id)) c.tasks.set(t.task_id, { id: t.task_id, kind: kindOf(t.task_type), name: str(t.subagent_type, 80), description: str(t.description, 200), lastTool: '', toolUses: 0, startedAt: Date.now(), background: true });
      }
    }
    if (JSON.stringify(this._taskList(c)) !== before) {
      if (!c.tasks.size && this.wakeGraceMs > 0) {
        c.wakeUntil = Date.now() + this.wakeGraceMs;
        const t = setTimeout(() => { if (this.map.get(c.sessionId) === c) this._emit(c, { type: 'state', status: this.status(c) }); }, this.wakeGraceMs + 50);
        if (t.unref) t.unref();
      }
      c.changedAt = Date.now();
      this._emit(c, { type: 'tasks', tasks: this._taskList(c) });
      this._emit(c, { type: 'state', status: this.status(c) });
    }
  }

  unread(c) { return c.lastResultAt > c.lastSeenAt; }

  seen(sid) {
    const c = this.map.get(sid);
    if (c && c.lastSeenAt < c.lastResultAt) { c.lastSeenAt = Date.now(); this._save(); }
  }

  _emit(c, ev) {
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of c.listeners) { try { res.write(line); } catch (e) {} }
    this._noteStatus(c);
  }

  // Whoever wants to know when a conversation goes from one state to another (the notification centre) sets
  // onStatus(c, from, to); onGone(sessionId) is called when one is taken off the board. Told at the moment it
  // happens - everything that changes a conversation's state passes through _emit.
  _noteStatus(c) {
    if (!this.onStatus) return;
    const to = this.status(c), from = c.lastStatus || 'idle';
    if (to === from) return;
    c.lastStatus = to;
    try { this.onStatus(c, from, to); } catch (e) {}
  }

  _setState(c, state) {
    // a change of permission mode asked for while it was busy (setBypass): the process is ended once the turn is over
    if (state === 'idle' && c.restartWhenIdle && c.proc && !c.pending.size) {
      c.restartWhenIdle = false; const p = c.proc; c.proc = null; try { p.stdin.end(); } catch (e) {} try { p.kill(); } catch (e) {} state = 'off';
    }
    if (c.state !== state) { c.state = state; c.changedAt = Date.now(); }
    this._emit(c, { type: 'state', status: this.status(c) });
  }

  subscribe(sid, res) {
    const c = this.map.get(sid);
    if (!c) return false;
    c.listeners.add(res);
    res.write('data: ' + JSON.stringify({ type: 'state', status: this.status(c) }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'tasks', tasks: this._taskList(c) }) + '\n\n');
    for (const p of c.pending.values()) res.write('data: ' + JSON.stringify(this._permissionEvent(p)) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'shell', notes: c.shellNotes || [] }) + '\n\n');
    res.on('close', () => c.listeners.delete(res));
    return true;
  }

  _permissionEvent(p) {
    const r = p.request || {};
    const { toolSummary, questionsOf } = require('./history');
    // Claude asking you to choose (AskUserQuestion) arrives through the same
    // door as an approval. It is passed on as a form to fill in, not a yes/no.
    if (r.tool_name === 'AskUserQuestion' && questionsOf(r.input).length) return { type: 'permission', requestId: p.request_id, tool: 'AskUserQuestion', questions: questionsOf(r.input) };
    return { type: 'permission', requestId: p.request_id, tool: String(r.display_name || r.tool_name || ''), text: toolSummary(r.input) || String(r.description || '') };
  }

  _start(c) {
    // --include-partial-messages: the reply arrives a few characters at a time
    // (stream_event), so the page can show it being written instead of waiting
    // for each whole block.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
    // A session with a transcript is resumed; a new one is created under the id
    // the channel already has, so the page knows the id before the first reply.
    // A copy of another session (forkOf) starts from that session's conversation under its own id, the first
    // time; once it has a transcript of its own it is carried on like any other.
    const has = this.transcriptOf(c.sessionId, c.cwd);
    // ... and from a given entry of it (resumeAt: a message edited and sent again, see lib/rewind.js), not its end
    if (!has && c.forkOf) args.push('--resume', c.forkOf, ...(c.resumeAt && /^[0-9a-f-]{36}$/i.test(c.resumeAt) ? ['--resume-session-at', c.resumeAt] : []), '--fork-session', '--session-id', c.sessionId);
    else args.push(has ? '--resume' : '--session-id', c.sessionId);
    if (c.skipPermissions) args.push('--dangerously-skip-permissions');
    // Given every time, also when carrying a conversation on (measured 2026-11-15: both a new and a resumed one answer as the role).
    if (c.agent && ROLE_NAME.test(c.agent)) args.push('--agent', c.agent);
    // The model it runs on, when one was chosen for it (setModel); otherwise Claude Code's own default.
    if (c.model && /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,60}$/.test(c.model)) args.push('--model', c.model);
    if (c.effort && EFFORTS.includes(c.effort)) args.push('--effort', c.effort);
    const p = this.spawn(CLAUDE_BIN, args, { cwd: c.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    c.proc = p;
    c.buf = '';
    c.stderr = '';
    c.procCost = 0;   // what this process has reported so far; see the result handler
    c.procTok = 0;
    p.stdout.on('data', (d) => {
      c.buf += d;
      let k;
      while ((k = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, k);
        c.buf = c.buf.slice(k + 1);
        if (line.trim()) this._onLine(c, line);
      }
    });
    p.stderr.on('data', (d) => { c.stderr = (c.stderr + d).slice(-2000); });
    // The process could not be started at all (claude is not installed, or not found from here), or broke off in a way
    // that gives no exit: without this the conversation kept its "working" look for ever and took no further message.
    p.on('error', (e) => {
      c.stderr = String((e && e.message) || e);
      if (c.proc !== p) return;
      c.proc = null; c.pending.clear();
      if (c.tasks.size) { c.tasks.clear(); this._emit(c, { type: 'tasks', tasks: [] }); }
      this._emit(c, { type: 'error', text: (e && e.code === 'ENOENT' ? '啟動不了 Claude Code：找不到 claude 這個程式。請開一個終端機確認打 claude 能執行（還沒安裝，或看板啟動時的 PATH 裡沒有它），再把訊息送一次。' : '啟動不了 Claude Code：' + c.stderr.slice(0, 300)) });
      this._setState(c, 'off');
      this._save();
    });
    p.on('exit', (code) => {
      if (Number.isInteger(p.pid)) this.deadPids.add(p.pid);
      if (c.proc !== p) return;
      const wasBusy = c.state === 'busy' || c.pending.size > 0 || c.tasks.size > 0;
      c.proc = null;
      c.pending.clear();
      if (c.tasks.size) { c.tasks.clear(); this._emit(c, { type: 'tasks', tasks: [] }); }
      if (wasBusy) this._emit(c, { type: 'error', text: `對話程序中途結束了（結束碼 ${code}）。${c.stderr ? '最後的錯誤輸出：' + c.stderr.trim().slice(-400) : ''}` });
      this._setState(c, 'off');
      this._save();
    });
    p.stdin.on('error', () => {});
  }

  _onLine(c, line) {
    let e;
    try { e = JSON.parse(line); } catch (x) { return; }
    c.lastActivity = Date.now();
    // Events that belong to a subagent carry the id of the tool call that
    // started it. Its chatter is not this conversation's reply: only the main
    // thread is shown (the subagent's result comes back as a tool result).
    // What a background command is and where its output goes, learned from the tool call that starts it and from that call's result.
    if (!e.parent_tool_use_id && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (e.type === 'assistant' && b && b.type === 'tool_use' && b.input && b.input.run_in_background && typeof b.input.command === 'string') {
          (c.bgCmd = c.bgCmd || new Map()).set(b.id, b.input.command.slice(0, 4000));
          if (c.bgCmd.size > 50) c.bgCmd.delete(c.bgCmd.keys().next().value);
        } else if (e.type === 'user' && b && b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : '';
          const m = /Output is being written to:\s*(\S.*?\.output)(?=[\s.,;]|$)/.exec(text) || /Output is being written to:\s*(\S+?)[.,;]?(?=\s|$)/.exec(text);
          if (m) {
            (c.bgOut = c.bgOut || new Map()).set(b.tool_use_id, m[1]); if (c.bgOut.size > 50) c.bgOut.delete(c.bgOut.keys().next().value);
            // This comes after "task started": the page is told again, so the row can be opened while the command is still running.
            this._emit(c, { type: 'tasks', tasks: this._taskList(c) });
          }
        }
      }
    }
    if ((e.type === 'stream_event' || e.type === 'assistant') && e.parent_tool_use_id) return;
    if (e.type === 'system' && /^(task_started|task_progress|task_updated|task_notification|background_tasks_changed)$/.test(e.subtype || '')) return this._onTask(c, e);
    // A turn can begin without a message from you: when background work
    // finishes, Claude Code starts one itself. Anything from the main thread
    // while the channel thinks it is idle means exactly that.
    // The permission mode this process runs in (default, acceptEdits, auto, bypassPermissions, plan …): shown on the page,
    // so that whether it will ask before changing a file is not a surprise.
    if (e.type === 'system' && e.subtype === 'init' && typeof e.permissionMode === 'string' && e.permissionMode !== c.mode) { c.mode = e.permissionMode.slice(0, 40); this._save(); }
    if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string' && e.model !== c.modelSeen) { c.modelSeen = e.model.slice(0, 60); this._save(); }   // the model its process says it runs on
    if (e.type === 'system' && e.subtype === 'init' && Array.isArray(e.agents)) {
      const list = e.agents.filter((n) => typeof n === 'string').slice(0, 300), key = String(c.cwd).toLowerCase();
      if (JSON.stringify(this.rolesSeen[key] || []) !== JSON.stringify(list)) { this.rolesSeen[key] = list; try { fs.writeFileSync(this.rolesFile, JSON.stringify(this.rolesSeen, null, 2)); } catch (x) {} }
    }
    if (c.state !== 'busy' && ((e.type === 'system' && e.subtype === 'init') || e.type === 'stream_event' || e.type === 'assistant')) this._setState(c, 'busy');
    if (e.type === 'stream_event') {
      const ev = e.event || {};
      // The reply as it is being written. The whole block follows later as an
      // `assistant` event, which is what the page keeps; these are only for showing progress.
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
        this._emit(c, { type: 'delta', text: ev.delta.text });
      } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') {
        this._emit(c, { type: 'thinking' });
      }
      return;
    }
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      const { toolSummary, toolDetail } = require('./history');
      for (const b of e.message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) this._emit(c, { type: 'assistant', text: b.text });
        // A question form shows up as its own card when the request to answer it arrives, not as a tool line.
        else if (b && b.type === 'tool_use' && b.name !== 'AskUserQuestion') this._emit(c, { type: 'tool', tool: String(b.name || ''), text: toolSummary(b.input), detail: toolDetail(b.name, b.input) });
      }
    } else if (e.type === 'control_request' && e.request && e.request.subtype === 'can_use_tool') {
      c.pending.set(e.request_id, e);
      c.changedAt = Date.now();
      this._emit(c, this._permissionEvent(e));
      this._emit(c, { type: 'state', status: this.status(c) });
    } else if (e.type === 'rate_limit_event') {
      // The account's usage limits as this conversation was just told them (see lib/quota.js).
      const snap = require('./quota').fromEvent(e.rate_limit_info);
      if (snap) this.quotaSnap = snap;
    } else if (e.type === 'result') {
      // Cost and tokens. Each result carries totals for THIS process since it
      // started, so the channel adds up the increase and keeps its own running
      // figure across restarts of the process. cc-statusline does not cover
      // these conversations (it only runs in a terminal), so this is the only source.
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      const cost = n(e.total_cost_usd);
      let tok = 0;
      const mu = e.modelUsage && typeof e.modelUsage === 'object' ? e.modelUsage : {};
      for (const [model, m] of Object.entries(mu)) {
        if (!m || typeof m !== 'object') continue;
        tok += n(m.inputTokens) + n(m.outputTokens) + n(m.cacheReadInputTokens) + n(m.cacheCreationInputTokens);
        // How large this model's context is: what "context N%" is a percentage of.
        if (n(m.contextWindow) && this.modelWindows[model] !== m.contextWindow) { this.modelWindows[model] = m.contextWindow; this._saveWindows(); }
      }
      if (cost >= c.procCost) { c.cost += cost - c.procCost; c.procCost = cost; }
      if (tok >= c.procTok) { c.tok += tok - c.procTok; c.procTok = tok; }
      c.lastResultAt = Date.now();
      this._emit(c, { type: 'result', isError: !!e.is_error, text: e.is_error ? String(e.result || '') : '' });
      this._setState(c, 'idle');   // the turn is over: your move
      this._save();
    }
  }

  // images: pictures that go with the message, [{mime, data}] (data: base64), already checked by the caller. They
  // are handed to Claude Code as image blocks, each at its mark in the text (contentOf), the rest before the text.
  // What you ran yourself with "!" since your last message (server.js /api/shell): kept here, in memory only, and put in
  // front of the next message so that Claude knows what was run and what it printed. -> the note's id
  noteShell(sid, note) {
    const c = this.map.get(sid);
    if (!c) return null;
    if (!Array.isArray(c.shellNotes)) c.shellNotes = [];
    c.shellSeq = (c.shellSeq || 0) + 1;
    // (kept as it will be handed over: the end of each output - also what is written to the board's own file)
    const end = (s) => { s = String(s == null ? '' : s); const n = require('./shell').NOTE_LIMIT; return s.length > n ? s.slice(s.length - n) : s; };
    c.shellNotes.push({ id: c.shellSeq, command: String(note.command || ''), stdout: end(note.stdout), stderr: end(note.stderr), code: note.code === undefined ? null : note.code, at: Date.now() });
    if (c.shellNotes.length > 10) c.shellNotes.shift();
    this._shellChanged(c);
    return c.shellSeq;
  }
  // id null: all of them. -> whether anything was thrown away
  dropShell(sid, id) {
    const c = this.map.get(sid);
    if (!c || !Array.isArray(c.shellNotes)) return false;
    const n = c.shellNotes.length;
    c.shellNotes = id == null ? [] : c.shellNotes.filter((x) => x.id !== id);
    if (c.shellNotes.length < n) this._shellChanged(c);
    return c.shellNotes.length < n;
  }
  // The page is told (it shows them at the end of the conversation, also after a reload), and they are written down
  // with the conversation, so that a restart of the board does not lose what you ran and have not sent yet.
  _shellChanged(c) { this._emit(c, { type: 'shell', notes: c.shellNotes || [] }); this._save(); }

  send(sid, text, images) {
    const c = this.map.get(sid);
    if (!c) return { ok: false, error: 'no such channel' };
    if (Array.isArray(c.shellNotes) && c.shellNotes.length) { text = require('./shell').noteText(c.shellNotes) + '\n' + String(text || ''); c.shellNotes = []; this._shellChanged(c); }
    const imgs = Array.isArray(images) && images.length ? images : null;
    // A message can be sent at any time, and it is handed to Claude Code at once - also while Claude is working, and
    // while an approval or a question is open. Claude Code takes it in as soon as the action in hand is done, in the
    // SAME turn: it does not wait for the turn to end. Measured 2026-11-16 on 2.1.325: a message written while the
    // first of three commands ran was read when that command finished, and Claude stopped the other two as told;
    // two messages and a picture written together were all read in that turn; so was one written while an approval
    // request was open. (The board used to hold such messages in a queue of its own until the turn ended, on the
    // belief that Claude Code would only merge them into the next turn. It does not.)
    // -> {ok, queued: false, mid}   mid: it went in while a turn was running
    const mid = !!c.proc && (c.state === 'busy' || c.pending.size > 0);
    const r = this._deliver(c, text, imgs);
    return r.ok ? Object.assign(r, { mid }) : r;
  }

  _deliver(c, text, images) {
    if (!c.proc) {
      try { this._start(c); } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }
    // (what you ran yourself with "!" stands in front of the message - see send() - and is not what the conversation is about)
    if (!c.title) c.title = text.replace(/^(?:\s*<bash-(?:input|stdout|stderr)>[\s\S]*?<\/bash-(?:input|stdout|stderr)>)+/, '').replace(/\s+/g, ' ').trim().slice(0, 60) || '（圖片）';
    c.lastActivity = Date.now();
    c.lastSeenAt = Date.now();
    c.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: contentOf(text, images) } }) + '\n');
    this._setState(c, 'busy');
    this._save();
    return { ok: true, queued: false };
  }

  // answers: for a question form, {question text: chosen label(s) or typed text}.
  // That is how Claude Code takes the reply to AskUserQuestion: the request is
  // allowed with the answers added to its input (measured 2026-11-12).
  answer(sid, requestId, allow, answers) {
    const c = this.map.get(sid);
    const req = c && c.pending.get(requestId);
    if (!req || !c.proc) return { ok: false, error: 'no such request' };
    let input = req.request.input;
    if (allow && req.request.tool_name === 'AskUserQuestion') {
      const clean = {};
      if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
        for (const q of (Array.isArray(input.questions) ? input.questions : [])) {
          const v = q && answers[q.question];
          if (typeof v === 'string' && v.trim()) clean[q.question] = v.trim().slice(0, 2000);
        }
      }
      if (!Object.keys(clean).length) return { ok: false, error: '沒有收到任何回答' };
      input = Object.assign({}, input, { answers: clean });
    }
    const response = allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: req.request.tool_name === 'AskUserQuestion' ? '使用者在看板上選擇不回答這些問題。' : '使用者在看板上拒絕了這個動作。' };
    c.proc.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
    c.pending.delete(requestId);
    c.changedAt = Date.now();
    this._emit(c, { type: 'permission-done', requestId, allow: !!allow });
    this._emit(c, { type: 'state', status: this.status(c) });
    return { ok: true };   // the turn goes on
  }

  // End the process. The session stays; the next message resumes it.
  // Run this conversation on another model from its next message on: the process it has now (started with the old
  // model) is ended, when it is not in the middle of a turn. -> {ok, error?}
  // effort: also given (undefined = left as it is).
  setModel(sid, model, effort) {
    const c = this.map.get(sid);
    if (!c) return { ok: false, error: 'no such channel' };
    if (c.proc && (c.state === 'busy' || c.pending.size)) return { ok: false, error: '它還在執行' };
    if (model !== undefined) c.model = String(model || '');
    if (effort !== undefined) c.effort = EFFORTS.includes(effort) ? effort : '';
    if (c.proc) { const p = c.proc; c.proc = null; try { p.stdin.end(); } catch (e) {} try { p.kill(); } catch (e) {} this._setState(c, 'off'); }
    this._save();
    return { ok: true };
  }

  // Run this conversation without asking for approvals (bypassPermissions), or back to the default, from its next
  // process on. A collaboration needs it: a session holds a SendMessage from a session of another permission mode
  // until its user approves it, and a board conversation has no one to approve (measured 2026-11-18: a claude -p
  // conversation in bypass received one at once; in auto the same message was held and never delivered). An idle
  // process is ended now; a busy one as soon as its turn is over. -> {ok, now: true | false (after this turn)}
  setBypass(sid, on) {
    const c = this.map.get(sid);
    if (!c) return { ok: false, error: 'no such channel' };
    c.skipPermissions = !!on;
    let now = true;
    if (c.proc) {
      if (c.state === 'busy' || c.pending.size) { c.restartWhenIdle = true; now = false; }
      else { const p = c.proc; c.proc = null; try { p.stdin.end(); } catch (e) {} try { p.kill(); } catch (e) {} this._setState(c, 'off'); }
    }
    this._save();
    return { ok: true, now };
  }

  stop(sid) {
    const c = this.map.get(sid);
    if (!c || !c.proc) return false;
    const p = c.proc;
    c.proc = null;
    c.pending.clear();
    if (c.tasks.size) { c.tasks.clear(); this._emit(c, { type: 'tasks', tasks: [] }); }
    try { p.kill(); } catch (e) {}
    this._setState(c, 'off');
    return true;
  }

  // The slash commands available in one folder: [{name, description, argumentHint}].
  //
  // Which commands exist depends on the folder (its own .claude/, and the
  // plugins enabled for that project), so the list is asked from Claude Code
  // for that folder rather than guessed or borrowed from another one
  // (measured 2026-11-12: 94, 113 and 91 commands in three folders).
  // How: start a claude process there and send it the `initialize` control
  // request. It answers in a second or two without any message being sent, so
  // no turn runs, nothing is billed and no transcript is written; then the
  // process is ended. The answer is kept for COMMANDS_TTL_MS.
  commandsFor(cwd) {
    const key = String(cwd || '').toLowerCase();
    const hit = this.commandCache.get(key);
    if (hit && Date.now() - hit.at < COMMANDS_TTL_MS) return Promise.resolve({ commands: hit.commands });
    if (this.commandJobs.has(key)) return this.commandJobs.get(key);
    const job = new Promise((resolve) => {
      let p, buf = '', done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (p) p.kill(); } catch (e) {}
        if (p && Number.isInteger(p.pid)) this.deadPids.add(p.pid);
        if (r.commands) this.commandCache.set(key, { at: Date.now(), commands: r.commands });
        // A failed ask falls back to the last answer for this folder, however old.
        resolve(r.commands ? r : { commands: hit ? hit.commands : [], error: r.error });
      };
      const timer = setTimeout(() => finish({ error: 'Claude Code 沒有在時限內回答' }), 30000);
      try {
        p = this.spawn(CLAUDE_BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) { return finish({ error: String(e.message || e) }); }
      // This helper registers itself with Claude Code like any session. It is
      // not one: keep it off the board from its first moment, not only once it has ended.
      if (Number.isInteger(p.pid)) this.deadPids.add(p.pid);
      p.stdout.on('data', (d) => {
        buf += d;
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k);
          buf = buf.slice(k + 1);
          let e;
          try { e = JSON.parse(line); } catch (x) { continue; }
          if (e.type !== 'control_response') continue;
          const list = e.response && e.response.response && e.response.response.commands;
          if (!Array.isArray(list)) return finish({ error: 'Claude Code 的回答裡沒有指令清單' });
          const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
          return finish({ commands: list.filter((x) => x && typeof x.name === 'string' && x.name).slice(0, 800)
            .map((x) => ({ name: x.name.slice(0, 120), description: str(x.description, 300), argumentHint: str(x.argumentHint, 80) })) });
        }
      });
      p.on('error', (e) => finish({ error: String(e.message || e) }));
      p.on('exit', () => finish({ error: 'Claude Code 還沒回答就結束了' }));
      p.stdin.on('error', () => {});
      p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'commands', request: { subtype: 'initialize' } }) + '\n');
    }).finally(() => this.commandJobs.delete(key));
    this.commandJobs.set(key, job);
    return job;
  }

  running(sid) {
    const c = this.map.get(sid);
    return !!(c && c.proc);
  }

  _reap() {
    const now = Date.now();
    // Not started and no page has it open: forgotten. (Two minutes' grace, for a page that is reloading.)
    for (const c of [...this.map.values()]) if (!c.listeners.size && now - (c.createdAt || 0) > UNSTARTED_MS && this.isEmpty(c)) this.remove(c.sessionId);
    for (const c of this.map.values()) {
      // Never while background work is running: ending the process would end that work with it.
      if (c.proc && c.state !== 'busy' && !c.pending.size && !c.tasks.size && now - c.lastActivity > IDLE_MS) {
        try { c.proc.stdin.end(); } catch (e) {}
      }
    }
  }

  shutdown() {
    clearInterval(this.timer);
    for (const c of this.map.values()) if (c.proc) { try { c.proc.kill(); } catch (e) {} }
  }
}

module.exports = { Channels, IDLE_MS, contentOf };
