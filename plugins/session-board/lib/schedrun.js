'use strict';
// The part that runs schedules.
//
// Once every tick (the server calls tick() every 20 seconds) each schedule that is switched on is asked for the
// latest time it was due. A time that has not been handled yet is either
//   - fired, when it is no more than LATE_MS ago, or
//   - written down as missed, when it is older: the board was not running (or the computer was off) at that
//     time. A missed run is never made up silently - it becomes a notice, and you choose to run it or skip it.
// Either way that time is then marked handled, in the database, BEFORE anything is started: a board that is
// restarted in the same minute does not run it twice (and there is a unique index on schedule + time as well).
//
// Where a run goes depends on what its target is doing at that moment:
//   a folder                         a new conversation on the board
//   a session that is not open       the board carries it on (it becomes a conversation on the board)
//   a session open on the board      the message is sent to it (read at once, also while the session is working)
//   a session open in a terminal     the message is handed over session-to-session (see peer in server.js);
//                                    if that cannot be done, the schedule's fallback decides:
//                                    notify (tell you) | fork (a copy on the board) | takeover (move it here)
//
// Everything the runner needs from the rest of the board comes in as `ops`, so that it can be tested alone:
//   ops.sessions()                -> the sessions as the board lists them
//   ops.channels                  -> the conversations on the board (create, send, get, status)
//   ops.isDir(path)
//   ops.peer(session, text, mark) -> Promise<{state: 'sent' | 'failed', note}>   handed to Claude Code's messaging
//   ops.peerCheck(session, mark)  -> 'delivered' | 'held' | ''   what the receiver's transcript shows of it so far
//                                    (a session may take half a minute to pick a message up: measured 2026-11-15,
//                                    so a run stays "sent" and is looked at again on every round)
//   ops.takeOver(session)         -> Promise<{ok, error}>   ends the terminal one, so the board may carry it on
//   ops.newId()                   -> a fresh session id (for a copy)
//   ops.goal                      -> lib/goal2.js: start(task, condition, cwd), state(runId)   (schedules of target 'goal')
//   ops.tell(title, text)         -> shows a notification outside the page (optional)

const LATE_MS = 3 * 60 * 1000;       // how late a run may start and still count as "on time"
const SETTLE_AFTER_MS = 8000;        // a run is not called finished in its first seconds: the conversation is only just starting
const CONFIRM_MS = 3 * 60 * 1000;    // how long a message handed to a terminal session may go unseen before it is called undelivered

const GOAL_WORD = { done: '達成', unverified: '做完但沒驗證到', impossible: '判定做不到', timeout: '超過時限', budget: '超過預算', stopped: '被停止', failed: '失敗', spawn_failed: '沒啟動成功', unknown: '狀態不明' };
const WHERE = { new: '新對話', resume: '看板接續', board: '送進看板裡的對話', peer: '送進終端機裡的 session', fork: '分身', takeover: '搬到看板' };

class Runner {
  constructor(store, ops) { this.store = store; this.ops = ops; this.busy = false; }

  // One round: fire what is due, note what was missed, bring the runs in progress up to date.
  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const s of this.store.list(now)) {
        if (!s.enabled) continue;
        const due = this.store.lastDue(s, now);
        if (!due || due <= Math.max(s.lastDue || 0, s.updatedAt || 0)) continue;
        this.store.setLastDue(s.id, due);                                   // handled, whatever happens next
        if (now - due <= LATE_MS) await this.fire(s, due, now);
        else this.missed(s, due, now);
      }
      await this.settle(now);
    } catch (e) { /* one bad round must not stop the next */ } finally { this.busy = false; }
  }

  missed(s, due, now) {
    const run = this.store.addRun({ scheduleId: s.id, name: s.name, dueAt: due, startedAt: now, endedAt: now, status: 'missed', note: '到點時看板沒有在執行' });
    if (!run) return;
    this.notice('missed', s, run, '「' + s.name + '」錯過了：原定 ' + stamp(due) + ' 執行，當時看板沒有在跑。');
  }

  notice(kind, s, runId, text) {
    this.store.addNotice({ kind, scheduleId: s.id, runId, text });
    if (this.ops.tell) { try { this.ops.tell('排程：' + s.name, text); } catch (e) {} }
  }

  // Starts one run. due: the time it stands for (now, for a run asked for by hand). force: a fallback to use
  // instead of handing the message to the terminal session ('fork' | 'takeover'), from a notice's button.
  async fire(s, due, now = Date.now(), force = '') {
    const run = this.store.addRun({ scheduleId: s.id, name: s.name, dueAt: due, startedAt: now, status: 'running' });
    if (!run) return { ok: false, error: '這個時間點已經執行過了' };
    const done = (status, how, sessionId, note) => { this.store.updateRun(run, { status, how: how || '', sessionId: sessionId || '', note: note || '', endedAt: /^(running|waiting)$/.test(status) ? 0 : Date.now() }); return { ok: status !== 'failed', run, status, sessionId: sessionId || '' }; };
    const fail = (why) => { const r = done('failed', '', '', why); this.notice('failed', s, run, '「' + s.name + '」沒有執行：' + why); return Object.assign(r, { error: why }); };
    const ch = this.ops.channels;
    // A conversation on the board, with the schedule's sentence as its next message.
    const onBoard = (how, cwd, sid, title, forkOf) => {
      const c = ch.get(sid) || ch.create(cwd, sid);
      if (!c.title && title) c.title = title;
      if (s.skipPermissions) c.skipPermissions = true;
      if (how === 'new' && s.agent) c.agent = s.agent;   // the role the schedule names, for the conversation it starts
      if (forkOf) c.forkOf = forkOf;
      const r = ch.send(c.sessionId, s.prompt);
      if (r && r.ok === false) return fail('送不進對話：' + (r.error || ''));
      return done('running', how, c.sessionId);
    };
    try {
      if (!this.ops.isDir(s.cwd)) return fail('資料夾已經不存在：' + s.cwd);
      if (s.target === 'folder') return onBoard('new', s.cwd, undefined, '⏰ ' + s.name);
      // Handed to goal2, which runs it on its own until the condition holds. The run is followed by its goal2 id.
      if (s.target === 'goal') {
        if (!this.ops.goal) return fail('這台電腦沒有裝 goal2');
        const g = await this.ops.goal.start(s.prompt, s.goal, s.cwd);
        if (!g.ok) return fail(g.error);
        return done('running', 'goal', 'goal:' + g.runId, 'goal ' + g.runId);
      }
      const live = this.ops.sessions().find((x) => x.sessionId === s.sessionId);
      if (!live) return onBoard('resume', s.cwd, s.sessionId, s.sessionTitle);
      if (live.owner === 'board') return onBoard('board', s.cwd, s.sessionId, s.sessionTitle);
      // Open in a terminal.
      const copy = () => onBoard('fork', s.cwd, this.ops.newId(), '⏰ ' + s.name + '（' + (s.sessionTitle || '分身').slice(0, 30) + ' 的分身）', s.sessionId);
      const move = async () => { const t = await this.ops.takeOver(live); return t.ok ? onBoard('takeover', s.cwd, s.sessionId, s.sessionTitle) : fail('沒有搬成：' + (t.error || '')); };
      if (force === 'fork') return copy();
      if (force === 'takeover') return await move();
      const mark = '#' + run;
      const p = await this.ops.peer(live, '【看板排程「' + s.name + '」' + mark + '】\n' + s.prompt, mark);
      // Sent: whether the session took it is seen in its transcript, a little later (settle).
      if (p.state === 'sent') { this.store.updateRun(run, { status: 'sent', how: 'peer', sessionId: s.sessionId, note: '已送出，等那個 session 收下' }); return { ok: true, run, status: 'sent', sessionId: s.sessionId }; }
      return this.undelivered(s, run, 'failed', '送不過去：' + (p.note || ''));
    } catch (e) { return fail(String((e && e.message) || e).slice(0, 200)); }
  }

  // A message that did not reach the terminal session: the schedule's fallback is used, or you are told.
  async undelivered(s, run, status, why, now = Date.now()) {
    this.store.updateRun(run, { status, how: 'peer', sessionId: s.sessionId || '', note: why, endedAt: now });
    if (s.fallback === 'fork' || s.fallback === 'takeover') {
      const r = await this.fire(s, now, now, s.fallback);
      if (r.ok) { this.store.updateRun(run, { note: why + (s.fallback === 'fork' ? '；改用分身執行' : '；已搬到看板執行') }); return r; }
    }
    this.notice('undelivered', s, run, '「' + s.name + '」沒有送進終端機裡的 session：' + why + '。');
    return { ok: false, run, status, error: why };
  }

  // Runs in progress: on the board - still working, waiting for you, or finished? Sent to a terminal session - taken yet?
  async settle(now = Date.now()) {
    for (const r of this.store.openRuns()) {
      if (r.status === 'sent') {
        const s = this.store.get(r.scheduleId) || { id: r.scheduleId, name: r.name, sessionId: r.sessionId, cwd: '', fallback: 'notify' };
        const seen = this.ops.peerCheck ? this.ops.peerCheck(this.ops.sessions().find((x) => x.sessionId === r.sessionId) || { sessionId: r.sessionId, cwd: s.cwd }, '#' + r.id) : '';
        if (seen === 'delivered') this.store.updateRun(r.id, { status: 'delivered', endedAt: now, note: '已送進終端機裡的 session，它會照做；做完與否看板不追蹤' });
        else if (seen === 'held') await this.undelivered(s, r.id, 'held', '那個 session 把訊息扣住了，等你在它的終端機視窗按核可（雙方權限模式不同）', now);
        else if (now - r.startedAt > CONFIRM_MS) await this.undelivered(s, r.id, 'unconfirmed', '已送出，但三分鐘內沒看到那個 session 收下', now);
        continue;
      }
      if (now - r.startedAt < SETTLE_AFTER_MS) continue;
      if (r.how === 'goal') {
        const st = this.ops.goal ? await this.ops.goal.state(String(r.sessionId).replace(/^goal:/, '')) : null;
        if (!st || st.alive || st.status === 'running' || st.status === 'prepared') continue;
        const good = st.status === 'done';
        this.store.updateRun(r.id, { status: good ? 'done' : 'failed', endedAt: now, note: (r.note ? r.note + '；' : '') + 'goal2：' + (GOAL_WORD[st.status] || st.status) });
        if (!good) { const s = this.store.get(r.scheduleId) || { id: r.scheduleId, name: r.name }; this.notice('failed', s, r.id, '「' + s.name + '」交給 goal2 的工作沒有達成：' + (GOAL_WORD[st.status] || st.status)); }
        continue;
      }
      const c = this.ops.channels.get(r.sessionId);
      if (!c) { this.store.updateRun(r.id, { status: 'done', endedAt: now, note: (r.note ? r.note + '；' : '') + '對話已經不在看板上' }); continue; }
      const st = this.ops.channels.status(c);
      if (st === 'waiting') {
        if (r.status !== 'waiting') { this.store.updateRun(r.id, { status: 'waiting' }); const s = this.store.get(r.scheduleId) || { id: r.scheduleId, name: r.name }; this.notice('approval', s, r.id, '「' + r.name + '」停下來等你：有一個動作要你核可，或它在問你問題。'); }
      } else if (st === 'idle') this.store.updateRun(r.id, { status: 'done', endedAt: now });
      else if (r.status !== 'running') this.store.updateRun(r.id, { status: 'running' });
    }
  }

  // What a notice's button asks for. -> {ok, error?}
  async act(noticeId, action, now = Date.now()) {
    const n = this.store.getNotice(noticeId);
    if (!n || n.state !== 'open') return { ok: false, error: '這則通知已經處理過了' };
    const s = this.store.get(n.scheduleId);
    if (action === 'skip' || action === 'close') { this.store.closeNotice(noticeId, action); return { ok: true }; }
    if (!s) { this.store.closeNotice(noticeId, 'gone'); return { ok: false, error: '這筆排程已經刪掉了' }; }
    if (!['run', 'fork', 'takeover'].includes(action)) return { ok: false, error: '不認得的動作' };
    const r = await this.fire(s, now, now, action === 'run' ? '' : action);
    this.store.closeNotice(noticeId, action);
    return r.ok ? { ok: true, sessionId: r.sessionId, status: r.status } : { ok: false, error: r.error || '沒有執行成功' };
  }
}

// '11/15 09:00' in this computer's time, put together by hand: toLocaleString's shape differs between computers' locale data
const stamp = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

module.exports = { Runner, LATE_MS, WHERE };
