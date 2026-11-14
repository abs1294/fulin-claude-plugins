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
const { spawn } = require('child_process');

const IDLE_MS = 15 * 60 * 1000;
const COMMANDS_TTL_MS = 10 * 60 * 1000;   // plugins get installed and removed; ask again after this
const UNSTARTED_MS = 2 * 60 * 1000;   // how long a conversation nothing was sent in is kept once no page has it open
const CLAUDE_BIN = process.env.SESSION_BOARD_CLAUDE || 'claude';

const DONE_KEEP_MS = 10 * 60 * 1000;   // how long a background command stays listed after it ends
const QUEUE_MAX = 20;   // messages that may wait for their turn in one conversation

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
    if (c.title || c.proc || c.lastResultAt || (c.queue && c.queue.length) || c.pending.size || c.tasks.size) return false;
    return !this.transcriptOf(c.sessionId, c.cwd);
  }

  remove(sid) {
    const c = this.map.get(sid);
    if (!c) return false;
    this.stop(sid);
    for (const res of c.listeners) { try { res.end(); } catch (e) {} }
    this.map.delete(sid);
    this._save();
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
  }

  _setState(c, state) {
    if (c.state !== state) { c.state = state; c.changedAt = Date.now(); }
    this._emit(c, { type: 'state', status: this.status(c) });
  }

  subscribe(sid, res) {
    const c = this.map.get(sid);
    if (!c) return false;
    c.listeners.add(res);
    res.write('data: ' + JSON.stringify({ type: 'state', status: this.status(c) }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'tasks', tasks: this._taskList(c) }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'queue', queue: c.queue || [] }) + '\n\n');
    for (const p of c.pending.values()) res.write('data: ' + JSON.stringify(this._permissionEvent(p)) + '\n\n');
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
    args.push(this.transcriptOf(c.sessionId, c.cwd) ? '--resume' : '--session-id', c.sessionId);
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
    p.on('error', (e) => { c.stderr = String(e.message || e); });
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
      const { toolSummary } = require('./history');
      for (const b of e.message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) this._emit(c, { type: 'assistant', text: b.text });
        // A question form shows up as its own card when the request to answer it arrives, not as a tool line.
        else if (b && b.type === 'tool_use' && b.name !== 'AskUserQuestion') this._emit(c, { type: 'tool', tool: String(b.name || ''), text: toolSummary(b.input) });
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
      // The turn is over. Something waiting in the queue goes next; only with nothing waiting is it your move.
      if (c.queue && c.queue.length) {
        c.state = 'idle';   // for _pump only: the turn that was in the way is over
        if (!this._pump(c)) { c.changedAt = Date.now(); this._emit(c, { type: 'state', status: this.status(c) }); }
      } else this._setState(c, 'idle');
      this._save();
    }
  }

  send(sid, text) {
    const c = this.map.get(sid);
    if (!c) return { ok: false, error: 'no such channel' };
    // A message can be sent at any time. While Claude is working, or an approval or a question is open,
    // it waits in the board's own queue and goes out when its turn comes: one message, one turn, in the
    // order sent. Kept here rather than handed to Claude Code at once (which would also queue it, but
    // merges everything sent during a turn into one next turn, and nothing sent can be taken back):
    // what waits here can be seen and withdrawn.
    if (!Array.isArray(c.queue)) c.queue = [];
    if ((c.state === 'busy' && c.proc) || c.pending.size || c.queue.length) {
      if (c.queue.length >= QUEUE_MAX) return { ok: false, error: '排隊的訊息已經有 ' + QUEUE_MAX + ' 則，先等它消化一些' };
      c.queueSeq = (c.queueSeq || 0) + 1;
      c.queue.push({ id: c.queueSeq, text });
      this._emit(c, { type: 'queue', queue: c.queue });
      this._pump(c);   // nothing in the way after all (a queue left from a process that ended): it goes now
      return { ok: true, queued: true, position: c.queue.length };
    }
    return this._deliver(c, text);
  }

  // Takes a queued message back. -> its text, or null.
  unqueue(sid, id) {
    const c = this.map.get(sid);
    const i = c && Array.isArray(c.queue) ? c.queue.findIndex((m) => m.id === id) : -1;
    if (i < 0) return null;
    const [m] = c.queue.splice(i, 1);
    this._emit(c, { type: 'queue', queue: c.queue });
    return m.text;
  }

  // Sends the first queued message if nothing is in the way. -> whether one was sent.
  _pump(c) {
    if (!c.queue || !c.queue.length || (c.state === 'busy' && c.proc) || c.pending.size) return false;
    const m = c.queue.shift();
    const r = this._deliver(c, m.text);
    if (!r.ok) { c.queue.unshift(m); this._emit(c, { type: 'error', text: '排隊的訊息送不出去：' + r.error }); return false; }
    this._emit(c, { type: 'sent', text: m.text });
    this._emit(c, { type: 'queue', queue: c.queue });
    return true;
  }

  _deliver(c, text) {
    if (!c.proc) {
      try { this._start(c); } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }
    if (!c.title) c.title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    c.lastActivity = Date.now();
    c.lastSeenAt = Date.now();
    c.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
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
    return { ok: true };   // the turn goes on; what is queued waits for it to end
  }

  // End the process. The session stays; the next message resumes it.
  stop(sid) {
    const c = this.map.get(sid);
    if (!c || !c.proc) return false;
    const p = c.proc;
    c.proc = null;
    c.pending.clear();
    // Stopping means stop: what was queued is not sent after it. It is handed back (dropped()) for the page to return to the input box.
    c.droppedTexts = (c.queue || []).map((m) => m.text);
    if (c.queue && c.queue.length) { c.queue = []; this._emit(c, { type: 'queue', queue: [] }); }
    if (c.tasks.size) { c.tasks.clear(); this._emit(c, { type: 'tasks', tasks: [] }); }
    try { p.kill(); } catch (e) {}
    this._setState(c, 'off');
    return true;
  }

  // What stop() took out of the queue, once.
  dropped(sid) { const c = this.map.get(sid); const d = (c && c.droppedTexts) || []; if (c) c.droppedTexts = []; return d; }

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

module.exports = { Channels, IDLE_MS };
