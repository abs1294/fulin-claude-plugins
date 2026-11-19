'use strict';
// The harness plugin's state in one project folder, read from the files it keeps there - for the office's rooms.
//
// harness (another plugin of this marketplace) installs a way of working into a project with /harness:init, and checks
// with /harness:review whether it is doing its job. In the project it keeps (plugins/harness, hooks/templates):
//   .claude/harness/README.md                     there at all: harness is installed here
//   .claude/harness/learning/pending.json         {items: [...]} - what the learning loop proposes; status "pending" =
//                                                 waiting for you. Approved only by your own words typed in Claude Code
//                                                 ("核可 <id>"): learn-pending.js refuses an approval that comes from a
//                                                 tool. The board approves by saying that line in a conversation of the
//                                                 folder (the page's 核可/駁回 buttons), where learn-approve.js takes it.
//   .claude/harness/reviews/<YYYY-MM-DD>.md       the report of each health check
//   .claude/harness/learning/usage.json           {requests} - one more at each turn
//   .claude/harness/learning/health-baseline.json {baseDate, requestsAtBase} - where the count since the last check starts
// A health check is due after 30 days or 300 requests since the last one, whichever comes first
// (hooks/templates/health-check-reminder.js THRESHOLD_DAYS / REQUEST_THRESHOLD).
// Only reads. Nothing is run.
const fs = require('fs');
const path = require('path');

const DAYS_DUE = 30, REQUESTS_DUE = 300;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };

const cache = new Map();   // folder -> {key, at, data}
// -> {installed: false} or {installed: true, pending: [...], pendingCount, lastReview, reviewFile, daysSince, requestsSince, due: [..reasons]}
function stateOf(folder, now = Date.now()) {
  const h = path.join(folder, '.claude', 'harness');
  if (!fs.existsSync(path.join(h, 'README.md'))) return { installed: false };
  const L = path.join(h, 'learning'), R = path.join(h, 'reviews');
  const key = [path.join(L, 'pending.json'), path.join(L, 'usage.json'), path.join(L, 'health-baseline.json'), R].map(mtime).join('|');
  const c = cache.get(folder);
  if (c && c.key === key && now - c.at < 600000) return c.data;
  const p = readJson(path.join(L, 'pending.json'));
  const items = p && Array.isArray(p.items) ? p.items : [];
  const pending = items.filter((x) => x && x.status === 'pending').map((x) => ({ id: String(x.id || ''), level: x.level || '', kind: x.kind || '', action: x.action || '', target: x.target || '', summary: String(x.summary || '').slice(0, 600), content: String(x.content || '').slice(0, 2000) }));
  let reviews = []; try { reviews = fs.readdirSync(R).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort(); } catch (e) {}
  const last = reviews.length ? reviews[reviews.length - 1].slice(0, 10) : '';
  const u = readJson(path.join(L, 'usage.json')), b = readJson(path.join(L, 'health-baseline.json'));
  const requestsSince = u && b && Number.isFinite(u.requests) && Number.isFinite(b.requestsAtBase) && u.requests >= b.requestsAtBase ? u.requests - b.requestsAtBase : null;
  const daysSince = last ? Math.floor((now - new Date(last + 'T00:00:00').getTime()) / 86400000) : null;
  const due = [];
  if (daysSince != null && daysSince >= DAYS_DUE) due.push('距上次健檢 ' + daysSince + ' 天');
  if (requestsSince != null && requestsSince >= REQUESTS_DUE) due.push('距上次健檢已 ' + requestsSince + ' 次對話');
  if (!last) due.push('還沒做過健檢');
  const data = { installed: true, pending, pendingCount: pending.length, lastReview: last, reviewFile: last ? path.join(R, last + '.md') : '', daysSince, requestsSince, due };
  cache.set(folder, { key, at: now, data });
  return data;
}

module.exports = { stateOf, DAYS_DUE, REQUESTS_DUE };
