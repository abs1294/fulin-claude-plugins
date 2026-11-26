'use strict';
// Sessions that stopped moving, and what the board does about it without being asked.
//
// Three things are looked for, once every round (the server calls tick() every 30 seconds):
//
//   stuck    a session that says it is working, while nothing has been written to its transcript for
//            stuckMinutes. Only told to you (a notification, once per standstill): a long build looks the same,
//            and ending someone's work on a guess is worse than waiting.
//   limit    a session whose last line is Claude Code's "You've hit your session limit · resets 2:30pm (Asia/Taipei)"
//            (or "weekly limit"). You are told when it stopped and when the limit comes back; a minute after that
//            time the session is asked to carry on (setting limitResume).
//   error    a session whose last line is an error on the server's side (overloaded, rate limited by the server,
//            a 5xx, a tool call that could not be parsed, no connection). Two minutes later it is asked to carry
//            on (setting errorRetry) - at most MAX_ERROR_RETRIES times an hour per session, so a server that
//            stays down is not hammered.
//
// What these lines look like was read off real transcripts (2026-11-15): an assistant entry with
// isApiErrorMessage: true, error: "rate_limit" (or another word), model "<synthetic>", and the text shown to you.
// Other errors (out of credits, a spend limit set by an admin, "please run /login", prompt too long, a model
// that is not available) are not something waiting fixes: nothing is done about those.
//
// "Asked to carry on" goes the way a schedule's message goes: into the conversation when it is on the board,
// session-to-session when it is open in a terminal (ops.peer; whether it was taken is then read from the
// receiver's transcript, ops.peerCheck). A session that is not open is left alone.
//
// Each stop is handled once: what was done about it is remembered by the time of its error line, in the board's
// database (ops.recall / ops.remember), so a board that restarts does not ask a second time.
//
// ops: sessions(), transcript(session) -> file | '', channels {send}, peer, peerCheck, tell(title, text),
//      settings() -> {stuck, stuckMinutes, limitResume, errorRetry}, recall() -> state | null, remember(state),
//      quota() -> {fiveHour: {pct, resetsAt} | null, sevenDay: …} (optional)
const fs = require('fs');
const { queuedSaid } = require('./history');

const DEFAULTS = { stuck: true, stuckMinutes: 10, limitResume: false, errorRetry: false, modelSwitch: true, switchTo: 'opus' };
const TAIL = 256 * 1024;
const AFTER_RESET_MS = 60 * 1000;          // how long after the limit's reset time the session is asked
const AFTER_ERROR_MS = 2 * 60 * 1000;      // how long after a server error
const LIMIT_STALE_MS = 12 * 3600 * 1000;   // a limit that came back longer ago than this: you have moved on, nothing is sent
const ERROR_STALE_MS = 30 * 60 * 1000;
const CONFIRM_MS = 3 * 60 * 1000;          // how long a message handed to a terminal session may go unseen
const MAX_ERROR_RETRIES = 3, ERROR_WINDOW_MS = 3600 * 1000;
const LOG_MAX = 40;

const LIMIT_PROMPT = '（看板自動送出）這個 session 剛才因為用量額度用完而停下，現在額度已經重置。請先確認剛才做到哪裡，再接著把沒做完的工作做完；如果其實已經做完了，回一句「已完成」就好。';
const MODEL_PROMPT = (from, to) => '（看板自動送出）剛才 ' + from + ' 的用量額度用完而停下，這個對話已經改用 ' + to + '。請先確認剛才做到哪裡，再接著把沒做完的工作做完；如果剛才是在回覆我最後那一則，請直接重新回覆它。';
const ERROR_PROMPT = '（看板自動送出）這個 session 剛才被 API 那一端的暫時性錯誤中斷了。請先確認剛才做到哪裡，再接著把沒做完的工作做完；如果其實已經做完了，回一句「已完成」就好。';

// What kind of stop an error line is. -> 'limit' | 'error' | 'other'
function classify(text) {
  const t = String(text || '');
  if (/hit your (session|weekly) limit/i.test(t) && !/spend limit/i.test(t)) return 'limit';
  // one model's own limit ("You've hit your Fable limit · resets … Switch to another model …"): another model goes on at once
  if (/hit your [A-Za-z][\w .-]{0,30} limit/i.test(t) && /switch to another model/i.test(t)) return 'model';
  if (/Overloaded|temporarily limiting requests|Internal server error|could not be parsed|Unable to connect|API Error: 5\d\d|Bad gateway|Service unavailable|timed? ?out/i.test(t)) return 'error';
  return 'other';
}

// The moment a wall-clock time in a named time zone stands for, in milliseconds.
function wallToUtc(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    const off = Date.UTC(y, mo, d, h, mi) - shown;
    if (!off) break;
    guess += off;
  }
  return guess;
}
const wallDate = (ms, tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day) }; };

// When the limit named in the text comes back: "resets 2:30pm (Asia/Taipei)", "resets 3pm (…)", "resets Sep 5, 3pm (…)".
// at: when the line was written. -> milliseconds, or 0 when the text does not say (or says it in words not known here).
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function resetTime(text, at) {
  const m = /resets (?:([A-Za-z]{3})[a-z]* (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: \(([^)]+)\))?/i.exec(String(text || ''));
  if (!m || !at) return 0;
  let tz = m[6] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  let h = Number(m[3]) % 12; if (/pm/i.test(m[5])) h += 12;
  const mi = Number(m[4] || 0);
  if (h > 23 || mi > 59) return 0;
  const day = wallDate(at, tz);
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo < 0) return 0;
    let t = wallToUtc(day.y, mo, Number(m[2]), h, mi, tz);
    if (t < at - 86400000) t = wallToUtc(day.y + 1, mo, Number(m[2]), h, mi, tz);   // written in December about January
    return t;
  }
  let t = wallToUtc(day.y, day.mo, day.d, h, mi, tz);
  if (t <= at) t = wallToUtc(day.y, day.mo, day.d + 1, h, mi, tz);
  return t;
}

// How a transcript ends, when it ends in an error from the API: {kind, at, text, resetAt}. null for anything else
// (a reply, a question of yours, a tool call) - read from the last TAIL bytes only, never the whole file.
function ending(file) {
  let fd, last = null;
  try {
    const size = fs.statSync(file).size, len = Math.min(size, TAIL);
    if (!len) return null;
    fd = fs.openSync(file, 'r');
    const b = Buffer.allocUnsafe(len);
    let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, size - len + got); if (n <= 0) break; got += n; }
    const lines = b.subarray(0, got).toString('utf8').split('\n');
    if (size > len) lines.shift();
    for (const line of lines) {
      if (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0 && line.indexOf('"type":"queued_command"') < 0) continue;
      let e; try { e = JSON.parse(line); } catch (x) { continue; }
      if (queuedSaid(e)) { last = { type: 'user', message: { content: '' } }; continue; }   // you said something after it (while a turn ran)
      if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true || !e.message) continue;
      // a command typed in Claude Code itself (/model, /usage …) and what it printed: not something said to Claude, so not
      // "you spoke after the stop" (seen 2026-11-17: /model typed after a Fable limit hid the stop)
      if (e.type === 'user') { const c = e.message.content, t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : ''; if (/^s*<(command-name|command-message|command-args|local-command-)/.test(t)) continue; }
      last = e;
    }
  } catch (e) { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  if (!last || last.type !== 'assistant' || last.isApiErrorMessage !== true) return null;
  const c = last.message.content;
  const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const at = Date.parse(last.timestamp) || 0;
  if (!text || !at) return null;
  const kind = classify(text);
  return { kind, at, text, resetAt: kind === 'limit' || kind === 'model' ? resetTime(text, at) : 0, weekly: /weekly limit/i.test(text), model: kind === 'model' ? (/hit your ([A-Za-z][\w .-]{0,30}?) limit/i.exec(text) || [])[1] || '' : '' };
}

const clock = (t) => new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const nameOf = (s) => String(s.title || s.name || s.sessionId || '').slice(0, 40) || '（沒有名稱）';

class Watchdog {
  constructor(ops) { this.ops = ops; this.busy = false; this.ends = new Map(); /* session -> {key, value}: a transcript is read again only when it has changed */ }

  settings() { const s = Object.assign({}, DEFAULTS, this.ops.settings ? this.ops.settings() : {}); s.stuckMinutes = Math.min(240, Math.max(2, Number(s.stuckMinutes) || DEFAULTS.stuckMinutes)); return s; }
  state() { const st = (this.ops.recall && this.ops.recall()) || {}; return { stuck: st.stuck || {}, seen: st.seen || {}, acted: st.acted || {}, retries: st.retries || {}, log: Array.isArray(st.log) ? st.log : [] }; }
  log() { return this.state().log; }

  endingOf(s) {
    const file = this.ops.transcript(s); if (!file) return null;
    const key = file + '|' + (s.activeAt || 0);
    const had = this.ends.get(s.sessionId);
    if (had && had.key === key) return had.value;
    const value = ending(file);
    this.ends.set(s.sessionId, { key, value });
    return value;
  }

  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = this.settings(), st = this.state();
      // The very first round ever: what already stands stopped is taken as it is and not acted on. Only a stop that
      // happens from now on is handled - switching this on must not send messages into sessions left hours ago.
      const first = !!this.ops.recall && !this.ops.recall();
      const before = JSON.stringify(st);
      const note = (s, kind, what) => { st.log.unshift({ at: now, sessionId: s.sessionId, title: nameOf(s), kind, what }); st.log.length = Math.min(st.log.length, LOG_MAX); };
      let about = '';   // the session being looked at: passed along, so the notice can lead back to it
      const tell = (title, text) => { if (this.ops.tell) { try { this.ops.tell(title, text, about); } catch (e) {} } };
      const open = this.ops.sessions().filter((s) => !s.notStarted);
      const ids = new Set(open.map((s) => s.sessionId));
      for (const k of ['stuck', 'seen', 'acted', 'retries']) for (const id of Object.keys(st[k])) if (!ids.has(id)) delete st[k][id];   // closed: forgotten

      const openNotice = (n) => { if (this.ops.open) { try { this.ops.open(n); } catch (e) {} } };
      for (const s of open) {
        about = s.sessionId;
        // Since when nothing has happened: since it last wrote, or since it began to work if that is later - one that lay idle for
        // an hour and was just sent a message has not stood still for an hour (said so a second after, six times: 2026-11-26)
        const from = s.activeAt ? Math.max(s.activeAt, s.since || 0) : 0;
        // A standstill that is over (it wrote again, or it is no longer working): its notice is cleared.
        if (st.stuck[s.sessionId] && (s.status !== 'busy' || (from && from !== st.stuck[s.sessionId] && now - from < cfg.stuckMinutes * 60000))) {
          delete st.stuck[s.sessionId];
          if (this.ops.resolve) { try { this.ops.resolve('stuck', s.sessionId, 'moved'); } catch (e) {} }
        }
        // ── stuck ──
        if (s.status === 'busy' && from && now - from >= cfg.stuckMinutes * 60000) {
          if (cfg.stuck && st.stuck[s.sessionId] !== from) {
            st.stuck[s.sessionId] = from;
            const mins = Math.round((now - from) / 60000);
            note(s, 'stuck', '顯示執行中，但已經 ' + mins + ' 分鐘沒有任何動靜');
            openNotice({ kind: 'stuck', sessionId: s.sessionId, title: '可能卡住：' + nameOf(s), text: '顯示執行中，但從 ' + clock(from) + ' 起沒有任何動靜。可能卡住了，也可能只是在跑很久的指令。' });
            tell('可能卡住：' + nameOf(s), '顯示執行中，但已經 ' + mins + ' 分鐘沒有任何動靜。可能卡住了，也可能只是在跑很久的指令。');
          }
          continue;
        }
        if (s.status !== 'idle') continue;
        const e = this.endingOf(s);
        if (!e || e.kind === 'other') continue;
        const id = s.sessionId, a = st.acted[id];
        if (first) { st.seen[id] = e.at; st.acted[id] = { at: e.at, state: 'baseline' }; continue; }

        // ── a message already sent for this stop: was it taken? ──
        if (a && a.at === e.at) {
          if (a.state === 'sent') {
            const seen = this.ops.peerCheck ? this.ops.peerCheck(s, a.mark) : '';
            if (seen === 'delivered') { a.state = 'delivered'; note(s, e.kind, '它收下了，接著做'); }
            else if (seen === 'held') { a.state = 'held'; note(s, e.kind, '訊息被它扣住，等你在它的終端機視窗按核可'); tell('沒有接續成：' + nameOf(s), '看板請它接著做的訊息被扣住了，要你在它的終端機視窗按核可。'); }
            else if (now - a.sentAt > CONFIRM_MS) { a.state = 'unconfirmed'; note(s, e.kind, '送出後三分鐘內沒看到它收下'); tell('沒有接續成：' + nameOf(s), '看板請它接著做的訊息送出了，但三分鐘內沒看到它收下。'); }
          }
          continue;
        }

        // ── one model's limit: switched to another model, now (nothing to wait for) ──
        if (e.kind === 'model') {
          if (st.seen[id] === e.at) continue;
          st.seen[id] = e.at;
          if (now - e.at > LIMIT_STALE_MS) continue;
          const to = String(cfg.switchTo || 'opus'), from = e.model || '這個模型', back = e.resetAt ? clock(e.resetAt) : '';
          if (!cfg.modelSwitch) { const t = from + ' 額度用完' + (back ? '（' + back + ' 回來）' : '') + '。自動換模型是關著的。'; note(s, 'limit', t); openNotice({ kind: 'limit', sessionId: id, title: from + ' 額度用完：' + nameOf(s), text: t }); tell(from + ' 額度用完：' + nameOf(s), t); continue; }
          if (s.owner === 'board' && this.ops.channels.setModel) {
            const m = this.ops.channels.setModel(id, to);
            const r = m.ok ? this.ops.channels.send(id, MODEL_PROMPT(from, to)) : m;
            if (r && r.ok === false) { st.acted[id] = { at: e.at, state: 'failed' }; note(s, 'limit', '沒有換成 ' + to + '：' + (r.error || '')); tell('沒有換成 ' + to + '：' + nameOf(s), r.error || ''); }
            else { st.acted[id] = { at: e.at, state: 'delivered' }; const t = from + ' 額度用完' + (back ? '（' + back + ' 回來）' : '') + '，已改用 ' + to + ' 接著做。這個對話之後都用 ' + to + '。'; note(s, 'limit', t); tell('已換成 ' + to + '：' + nameOf(s), t); }
          } else {
            // a terminal session: its model is changed by a command typed in it, which the board cannot do for it
            const t = from + ' 額度用完' + (back ? '（' + back + ' 回來）' : '') + '。到它的終端機視窗輸入 /model ' + to + '，再請它繼續。';
            note(s, 'limit', t); openNotice({ kind: 'limit', sessionId: id, title: from + ' 額度用完：' + nameOf(s), text: t }); tell(from + ' 額度用完：' + nameOf(s), t);
          }
          continue;
        }
        const limit = e.kind === 'limit';
        const due = limit ? (e.resetAt ? e.resetAt + AFTER_RESET_MS : 0) : e.at + AFTER_ERROR_MS;
        const auto = limit ? cfg.limitResume : cfg.errorRetry;
        // ── first sight of this stop: you are told what happened and what the board will do ──
        if (st.seen[id] !== e.at) {
          st.seen[id] = e.at;
          const fresh = now - e.at < (limit ? LIMIT_STALE_MS : ERROR_STALE_MS);
          if (limit && fresh) {
            const when = e.resetAt ? clock(e.resetAt) : '';
            const plan = !when ? '看不出額度什麼時候回來，看板不會自動接續。' : !auto ? '額度 ' + when + ' 回來。自動接續是關著的，到時候要你自己請它繼續。' : now < due ? '額度 ' + when + ' 回來，到時候看板會請它接著做。' : '額度已經回來，看板現在請它接著做。';
            note(s, 'limit', (e.weekly ? '每週額度用完而停下。' : '額度用完而停下。') + plan);
            openNotice({ kind: 'limit', sessionId: s.sessionId, title: (e.weekly ? '每週額度用完：' : '額度用完：') + nameOf(s), text: plan });
            tell((e.weekly ? '每週額度用完：' : '額度用完：') + nameOf(s), plan);
          } else if (!limit && fresh) { openNotice({ kind: 'error', sessionId: s.sessionId, title: '被錯誤中斷：' + nameOf(s), text: e.text.slice(0, 120) + (auto ? '。兩分鐘後看板會請它再試一次。' : '。自動再試是關著的，要你自己請它繼續。') }); note(s, 'error', '被 API 的錯誤中斷：' + e.text.slice(0, 80) + (auto ? '。兩分鐘後看板會請它再試一次。' : '。自動再試是關著的。')); }
        }
        if (!due || !auto || now < due) continue;
        if (now - due > (limit ? LIMIT_STALE_MS : ERROR_STALE_MS)) { st.acted[id] = { at: e.at, state: 'stale' }; continue; }
        if (limit && this.ops.quota) {
          // still used up (the other window, or the figure has not turned over yet): wait for the next round
          const q = this.ops.quota() || {}, w = e.weekly ? q.sevenDay : q.fiveHour;
          if (w && w.pct >= 100 && w.resetsAt > now) continue;
        }
        if (!limit) {
          const r = st.retries[id] && now - st.retries[id].since < ERROR_WINDOW_MS ? st.retries[id] : { n: 0, since: now };
          if (r.n >= MAX_ERROR_RETRIES) {
            st.acted[id] = { at: e.at, state: 'gaveup' };
            if (!r.said) { r.said = true; st.retries[id] = r; note(s, 'error', '一小時內已經再試 ' + r.n + ' 次都被錯誤中斷，不再自動試'); tell('不再自動再試：' + nameOf(s), '一小時內再試了 ' + r.n + ' 次，每次都被 API 的錯誤中斷。'); }   // said once, not at every further error
            continue;
          }
          r.n++; st.retries[id] = r;
        }
        // ── ask it to carry on ──
        const text = limit ? LIMIT_PROMPT : ERROR_PROMPT;
        const what = limit ? '額度回來了，已請它接著做' : '已請它再試一次';
        if (s.owner === 'board') {
          const r = this.ops.channels.send(id, text);
          if (r && r.ok === false) { st.acted[id] = { at: e.at, state: 'failed' }; note(s, e.kind, '送不進對話：' + (r.error || '')); tell('沒有接續成：' + nameOf(s), '送不進對話：' + (r.error || '')); }
          else { st.acted[id] = { at: e.at, state: 'delivered' }; note(s, e.kind, what); tell((limit ? '額度回來了：' : '再試一次：') + nameOf(s), what + '。'); }
          continue;
        }
        const mark = '#w' + String(e.at).slice(-7);
        st.acted[id] = { at: e.at, state: 'sending', mark, sentAt: now };
        if (this.ops.remember) this.ops.remember(st);   // written down before the slow part: a restart must not send it twice
        let p; try { p = await this.ops.peer(s, '【看板自動處理 ' + mark + '】\n' + text, mark); } catch (x) { p = { state: 'failed', note: String((x && x.message) || x).slice(0, 120) }; }
        if (p && p.state === 'sent') { st.acted[id].state = 'sent'; note(s, e.kind, what + '（已送出，等它收下）'); tell((limit ? '額度回來了：' : '再試一次：') + nameOf(s), what + '。'); }
        else { st.acted[id].state = 'failed'; note(s, e.kind, '送不過去：' + ((p && p.note) || '')); tell('沒有接續成：' + nameOf(s), '看板請它接著做的訊息送不過去：' + ((p && p.note) || '') + '。'); }
      }
      if (this.ops.remember && (first || JSON.stringify(st) !== before)) this.ops.remember(st);
    } catch (e) { /* one bad round must not stop the next */ } finally { this.busy = false; }
  }
}

module.exports = { Watchdog, DEFAULTS, classify, resetTime, ending, LIMIT_PROMPT, ERROR_PROMPT, AFTER_RESET_MS, AFTER_ERROR_MS };
