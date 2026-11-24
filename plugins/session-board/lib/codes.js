'use strict';
// Fixed names of sessions: what the other members of a collaboration reach a session by (SendMessage), the same whatever
// its title becomes, however often its process is started again, and in every collaboration it joins. Kept in the board's
// settings as 'sessionCodes': {n: the last number given, codes: {sessionId: name}, old: [names
// that were given before and are one no more]}. Those given before 0.22.0 are in the
// collaborations themselves (setting 'collabs'): of several, the one of a collaboration under way, then the latest.
// Also read by scripts/usage-scan.js and scripts/notify-hook.js, which run on their own: Claude Code writes a session's
// name down as its title, and a fixed name says nothing of what the conversation is about.
const Collab = require('./collab');

const collabsOf = (value) => { const v = value('collabs', []); return Array.isArray(v) ? v.filter((c) => c && Array.isArray(c.members)).map((c) => Object.assign({}, c, { members: c.members.filter((m) => m && typeof m === 'object') })) : []; };
const once = (value) => { const m = new Map(); return (k, d) => { if (!m.has(k)) m.set(k, value(k, d)); return m.get(k); }; };   // each setting read once
// value: (key, default) -> the setting. -> {n, codes}
function book(value) {
  const v = value('sessionCodes', {}), codes = {}, own = v && v.codes && typeof v.codes === 'object' ? v.codes : {};
  // (read out of the collaborations only while nothing is written down: freeze)
  if (!(v && v.codes)) for (const c of collabsOf(value).sort((a, b) => (a.state === 'active') - (b.state === 'active') || (a.id || 0) - (b.id || 0))) for (const m of c.members) { const n = Collab.safeName(m.name); if (n && m.sessionId) codes[m.sessionId] = n; }
  Object.assign(codes, own);
  const seen = new Set();
  for (const sid of Object.keys(codes)) { if (seen.has(codes[sid])) codes[sid] = codes[sid].slice(0, 60) + '-' + sid.slice(0, 8); seen.add(codes[sid]); }
  return { n: v && Number.isInteger(v.n) ? v.n : 0, codes, old: v && Array.isArray(v.old) ? v.old : [] };
}
// Every name that is (or was given as) a fixed name.
function known(value0) { const value = once(value0), b = book(value); return new Set(Object.values(b.codes).concat(b.old, ...collabsOf(value).map((c) => c.members.map((m) => m.name))).filter((x) => typeof x === 'string' && x)); }
// Those of before 0.22.0, written down once: worked out anew each time, they would change when a collaboration ends.
function freeze(value, put) {
  const v = value('sessionCodes', null); if (v && v.codes) return false;
  const b = book(value); if (!Object.keys(b.codes).length) return false;
  put('sessionCodes', Object.assign(b, { old: [...known(value)] }));
  return true;
}
// The session's name, given now if it has none. put: (key, value) -> saves it; live: names in use now (a settings store
// that was lost starts its numbers over, while sessions still carry the old ones)
function give(value, put, sid, short, pattern, live = []) {
  const b = book(value); if (b.codes[sid]) return b.codes[sid];
  const taken = new Set(Object.values(b.codes).concat(b.old, live));
  let name;
  // a pattern that leaves the number out, or a name too long for it: the number first
  do { b.n++; name = Collab.fixedName(pattern, b.n, short); if (!name || taken.has(name)) name = Collab.fixedName('', b.n, short); } while (taken.has(name));
  b.codes[sid] = name; put('sessionCodes', b);
  return name;
}
// A conversation that goes on as another one (a message edited and sent again): the name goes along. -> the name, or ''
function move(value, put, from, to) {
  const b = book(value), name = b.codes[from]; if (!name || from === to) return '';
  delete b.codes[from]; b.codes[to] = name; put('sessionCodes', b);
  return name;
}
// The same, for what asks at every refresh and every process start: read at most once a second, and again at once after
// any change made here. One per settings store (value).
let seen = { at: 0, value: null, codes: {}, known: new Set() };
function cached(value, put) {
  if (seen.value !== value || Date.now() - seen.at > 1000) {
    if (put && seen.value !== value) { try { freeze(value, put); } catch (e) {} }
    seen = { at: Date.now(), value, codes: book(value).codes, known: known(value) };
  }
  return seen;
}
const changed = (f) => (...a) => { try { return f(...a); } finally { seen.at = 0; } };
module.exports = { book, known, cached, freeze: changed(freeze), give: changed(give), move: changed(move) };
