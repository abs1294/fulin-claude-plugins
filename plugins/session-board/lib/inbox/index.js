'use strict';
// The inbox as the board uses it: its settings, one fetch of all sources at a
// time, the timer, and connecting Gmail.
//
// Settings live in the board's database under the key "inbox":
//   me             who you are: your mail addresses and names, separated by commas or line breaks. The Gmail
//                  account's own address is always counted in, without being written here. Used to file
//                  mail from those addresses as yours, and to tell triage that what they wrote is not a
//                  request made to you.
//   pollMinutes    fetch every this many minutes; 0 = only when asked. Default 15.
//   gmailLabel     empty (default): all received mail is fetched. A label name: only mail under it.
//   gmailDays      how far back Gmail is asked (default 7)
//   teamsSelfId    your Teams id; messages from it are yours (shown on the right,
//                  and they do not reopen a thread). Without it every message
//                  counts as incoming.
//   teamsDays      how far back Teams is read (default 7)
//   slackToken     a Slack bot token (xoxb-…); slackSelfId: your Slack user id
// The first time, GMAIL_LABEL / TEAMS_SELF_ID / TEAMS_POLL_DAYS are taken from
// customer-hub's .env if that is on this machine.
//
// Gmail's sign-in: the OAuth client is customer-hub's (~/.customer-hub/
// credentials.json). The board keeps its OWN token, in
// ~/.claude/session-board/gmail-token.json, asked for with read-only access;
// customer-hub's token.json is used only until then and is never rewritten.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('../config');
const DB = require('../db');
const { Inbox, SOURCES } = require('./store');
const Src = require('./sources');
const TeamsDb = require('./teams-localdb');
const Triage = require('./triage');

const DEFAULTS = { me: '', triage: true, pollMinutes: 15, gmailLabel: '', gmailDays: 7, teamsSelfId: '', teamsDays: 7, slackToken: '', slackSelfId: '', slackDays: 7 };
const SECRET_DIR = path.join(os.homedir(), '.customer-hub');
// A customer-hub .env to take the first settings from, when one is named. Nothing is assumed about where
// anyone keeps theirs: without SESSION_BOARD_OLD_ENV there is no such import, and the settings start empty.
const OLD_ENV = process.env.SESSION_BOARD_OLD_ENV || '';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

class InboxService {
  constructor(o = {}) {
    this.dbFile = o.db || DB.DB_FILE;
    this.tokenFile = o.tokenFile || path.join(path.dirname(this.dbFile), 'gmail-token.json');
    this.secretDir = o.secretDir || SECRET_DIR;
    this.oldEnv = o.oldEnv === undefined ? OLD_ENV : o.oldEnv;
    this.fetch = o.fetch || ((...a) => fetch(...a));
    this.inbox = new Inbox(this.dbFile);
    this.running = null;
    this.last = null;        // {at, total, results}
    this.pending = null;     // a Gmail sign-in in progress
    this.triageRun = o.triageRun || null;   // tests replace the model call
  }

  settings() {
    let s = config.value('inbox', null, this.dbFile);
    if (!s || typeof s !== 'object') {
      s = {};
      // Taken over once from the system this was ported from.
      try {
        const env = {};
        for (const l of (this.oldEnv ? fs.readFileSync(this.oldEnv, 'utf8') : '').split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
        if (env.TEAMS_SELF_ID) s.teamsSelfId = env.TEAMS_SELF_ID;
        if (Number(env.TEAMS_POLL_DAYS) > 0) s.teamsDays = Number(env.TEAMS_POLL_DAYS);
      } catch (e) {}
      config.setValue('inbox', s, this.dbFile);
    }
    return Object.assign({}, DEFAULTS, s);
  }

  saveSettings(patch) {
    const cur = this.settings(), next = {};
    for (const k of Object.keys(DEFAULTS)) next[k] = cur[k];
    const num = (k, min, max) => { if (patch[k] === undefined) return null; const n = Number(patch[k]); if (!Number.isFinite(n) || n < min || n > max) return k; next[k] = Math.round(n); return null; };
    const bad = num('pollMinutes', 0, 1440) || num('gmailDays', 1, 365) || num('teamsDays', 1, 90) || num('slackDays', 1, 90);
    if (bad) return { ok: false, error: '數字超出範圍：' + bad };
    if (typeof patch.triage === 'boolean') next.triage = patch.triage;
    if (typeof patch.me === 'string') {
      const was = cur.me;
      next.me = patch.me.split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12).join(', ').slice(0, 600);
      // Who you are changed: threads that mention you are judged again, with that known.
      if (next.me !== was) { config.setValue('inbox', next, this.dbFile); this.rejudgeMentions(); }
    }
    for (const k of ['gmailLabel', 'teamsSelfId', 'slackSelfId', 'slackToken'])   /* (me is handled above: it is a list) */ if (typeof patch[k] === 'string') next[k] = patch[k].trim().slice(0, 300);
    config.setValue('inbox', next, this.dbFile);
    return { ok: true };
  }

  // The attachments of a mail thread, saved on this computer (see Src.gmailAttachments).
  attachments(threadId) { return Src.gmailAttachments(this.cfg(), threadId, path.join(path.dirname(this.dbFile), 'attachments'), this.fetch); }

  cfg() {
    const s = this.settings();
    const own = fs.existsSync(this.tokenFile);
    return Object.assign({}, s, { myAddresses: this.identities().filter((x) => x.includes('@')).map((x) => x.toLowerCase()), gmailSecretDir: this.secretDir, gmailCredFile: this.credFile(), gmailTokenFile: own ? this.tokenFile : path.join(this.secretDir, 'token.json') });
  }

  // Everything that names you: what the settings say, plus the address of the connected Gmail account.
  identities() {
    const list = String(this.settings().me || '').split(',').map((x) => x.trim()).filter(Boolean);
    const acct = String(this.inbox.state('gmail:account', '') || '').trim();
    if (acct && !list.some((x) => x.toLowerCase() === acct.toLowerCase())) list.unshift(acct);
    return list;
  }

  // Marks for judging again the threads in which one of your addresses or names appears in something
  // somebody else wrote (a quoted reply of yours, a mention). -> how many.
  rejudgeMentions() {
    const ids = this.identities();
    if (!ids.length) return 0;
    Triage.pendingCount(this.inbox.db);   // makes sure the judgement columns exist
    const like = ids.map(() => "lower(m.body) LIKE ?").join(' OR ');
    const r = this.inbox.db.prepare("UPDATE inbox_thread SET triage_upto = NULL WHERE status <> 'done' AND triage IS NOT NULL AND thread_id IN (SELECT DISTINCT m.thread_id FROM inbox_message m WHERE m.direction = 'in' AND (" + like + "))")
      .run(...ids.map((x) => '%' + x.toLowerCase().replace(/[%_]/g, ' ') + '%'));
    return r.changes;
  }

  // The OAuth client ("credentials.json" from Google Cloud Console, type Desktop app). The board's own
  // place for it comes first, so someone who never had customer-hub can use Gmail too:
  //   ~/.claude/session-board/gmail-credentials.json, then ~/.customer-hub/credentials.json.
  credFile() {
    const own = path.join(path.dirname(this.tokenFile), 'gmail-credentials.json');
    return fs.existsSync(own) ? own : path.join(this.secretDir, 'credentials.json');
  }
  hasCred() { try { const j = JSON.parse(fs.readFileSync(this.credFile(), 'utf8')); const c = j.installed || j.web || j; return !!(c.client_id && c.client_secret); } catch (e) { return false; } }

  // What the page shows about each source. The Slack token itself never leaves the server.
  status() {
    const s = this.settings(), cfg = this.cfg();
    const reauth = this.inbox.state('gmail:reauth', null);
    return {
      gmail: { configured: Src.gmailConfigured(cfg), hasClient: this.hasCred(), clientFile: path.join(path.dirname(this.tokenFile), 'gmail-credentials.json'), ownToken: fs.existsSync(this.tokenFile), needsReauth: !!reauth, reauthAt: reauth && reauth.at, account: this.inbox.state('gmail:account', ''), routes: this.inbox.enabledRefs('gmail').length, label: s.gmailLabel, days: s.gmailDays },
      slack: { configured: !!s.slackToken, routes: this.inbox.enabledRefs('slack').length },
      teams: { configured: TeamsDb.available(), selfKnown: !!(s.teamsSelfId || this.inbox.state('teams:self', '')), selfGuessed: !s.teamsSelfId && !!this.inbox.state('teams:self', '') },
      settings: Object.assign({}, s, { slackToken: s.slackToken ? '（已設定）' : '' }), identities: this.identities(),
      last: this.last, running: !!this.running, counts: this.inbox.counts(),
    };
  }

  // One fetch of every source (or the one named). A second call while one is running gets the same answer.
  poll(only) {
    if (this.running) return this.running;
    const job = (async () => {
      const cfg = this.cfg(), results = [];
      for (const src of SOURCES) {
        if (only && only !== src) continue;
        try {
          if (src === 'gmail') {
            const r = await Src.pollGmail(this.inbox, cfg, this.fetch);
            if (!r.skipped) { this.inbox.setState('gmail:reauth', null); if (r.account) this.inbox.setState('gmail:account', r.account); }
            results.push(r);
          } else if (src === 'slack') results.push(await Src.pollSlack(this.inbox, cfg, this.fetch));
          else results.push(Src.pollTeams(this.inbox, cfg));
        } catch (e) {
          if (e instanceof Src.ReauthError) this.inbox.setState('gmail:reauth', { at: Date.now() });
          results.push({ source: src, error: String(e.message || e).slice(0, 300), ingested: 0, reauth: e instanceof Src.ReauthError });
        }
      }
      this.last = { at: Date.now(), total: results.reduce((a, r) => a + (r.ingested || 0), 0), results };
      // Judging follows fetching: whatever has come in and has not been judged yet is judged now.
      if (this.settings().triage) {
        try { this.last.triage = await Triage.runAll(this.dbFile, { run: this.triageRun, me: this.identities() }); }
        catch (e) { this.last.triage = { ok: false, error: String(e.message || e).slice(0, 200) }; }
      }
      return this.last;
    })().finally(() => { this.running = null; });
    this.running = job;
    return job;
  }

  // Called once a minute by the server: fetches when the interval has passed.
  tick(now = Date.now()) {
    const every = this.settings().pollMinutes;
    if (!every || this.running) return false;
    if (this.last && now - this.last.at < every * 60000) return false;
    this.poll().catch(() => {});
    return true;
  }

  // ── connecting Gmail ──
  // Starts a sign-in: a small listener on a free local port takes Google's
  // answer (a "Desktop" OAuth client may only be sent back to this machine).
  // Returns the address to open. The listener closes itself after the answer,
  // or after ten minutes.
  startGmailConnect() {
    return new Promise((resolve, reject) => {
      let c;
      try { const j = JSON.parse(fs.readFileSync(this.credFile(), 'utf8')); c = j.installed || j.web || j; if (!c.client_id || !c.client_secret) throw new Error('x'); }
      catch (e) { return reject(new Error('還沒有 Google 的 OAuth 用戶端。請到 Google Cloud Console 建一個「電腦版應用程式」用戶端並啟用 Gmail API，把下載的 JSON 存成 ' + path.join(path.dirname(this.tokenFile), 'gmail-credentials.json'))); }
      if (this.pending) { try { this.pending.server.close(); } catch (e) {} this.pending = null; }
      const state = crypto.randomBytes(16).toString('hex');
      const page = (text) => '<!doctype html><meta charset="utf-8"><title>Session 看板</title><body style="font:16px system-ui;padding:48px;max-width:560px;margin:auto"><h2>' + text + '</h2><p>可以關掉這一頁，回到看板。</p>';
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const done = (code, text) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(text)); };
        if (u.pathname !== '/') return done(404, '找不到這一頁');
        if (u.searchParams.get('state') !== state) return done(400, '這個連結不是這次登入產生的，沒有採用');
        const finish = () => { clearTimeout(timer); server.close(); this.pending = null; };
        if (u.searchParams.get('error')) { done(200, 'Gmail 沒有連接：' + String(u.searchParams.get('error')).replace(/[^\w .-]/g, '').slice(0, 80)); return finish(); }
        try {
          const r = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: u.searchParams.get('code') || '', client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code' }).toString() });
          const j = await r.json();
          if (!j.refresh_token) throw new Error(j.error_description || j.error || 'Google 沒有給長期權杖');
          fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
          fs.writeFileSync(this.tokenFile, JSON.stringify({ refresh_token: j.refresh_token, scope: j.scope || SCOPE, obtained_at: Date.now() }, null, 1));
          this.inbox.setState('gmail:reauth', null);
          done(200, 'Gmail 已連接（唯讀）');
          this.poll('gmail').catch(() => {});
        } catch (e) { done(500, 'Gmail 沒有連接：' + String(e.message || e).slice(0, 200)); }
        finish();
      });
      let redirect = '';
      const timer = setTimeout(() => { try { server.close(); } catch (e) {} if (this.pending && this.pending.state === state) this.pending = null; }, 10 * 60000);
      timer.unref();
      server.on('error', (e) => reject(e));
      server.listen(0, '127.0.0.1', () => {
        redirect = 'http://127.0.0.1:' + server.address().port;
        this.pending = { server, state };
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for (const [k, v] of Object.entries({ client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state })) url.searchParams.set(k, v);
        resolve({ url: url.toString(), redirect });
      });
      server.unref();
    });
  }
}

module.exports = { InboxService, DEFAULTS, SCOPE };
