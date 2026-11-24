'use strict';
// Fixed names of sessions: what the other members of a collaboration reach a session by (SendMessage), the same whatever
// its title becomes, however often its process is started again, and in every collaboration it joins. Kept in the board's
// settings as 'sessionCodes': {n: the last number given, codes: {sessionId: name}, old: [names
// that were given before and are one no more]}. Those given before 0.22.0 are in the
// collaborations themselves (setting 'collabs'): of several, the one of a collaboration under way, then the latest.
// Also read by scripts/usage-scan.js and scripts/notify-hook.js, which run on their own: Claude Code writes a session's
// name down as its title, and a fixed name says nothing of what the conversation is about.
const Collab = require('./collab');

const collabsOf = (value) => { const v = value('collabs', []); return Array.isArray(v) ? v.filter((c) => c && Array.isArray(c.members)) : []; };
// value: (key, default) -> the setting. -> {n, codes}
function book(value) {
  const v = value('sessionCodes', {}), codes = {}, own = v && v.codes && typeof v.codes === 'object' ? v.codes : {};
  for (const c of collabsOf(value).sort((a, b) => (a.state === 'active') - (b.state === 'active') || (a.id || 0) - (b.id || 0))) for (const m of c.members) { const n = Collab.safeName(m.name); if (n && m.sessionId) codes[m.sessionId] = n; }
  Object.assign(codes, own);
  const seen = new Set();
  for (const sid of Object.keys(codes)) { if (seen.has(codes[sid])) codes[sid] = codes[sid].slice(0, 60) + '-' + sid.slice(0, 8); seen.add(codes[sid]); }
  return { n: v && Number.isInteger(v.n) ? v.n : 0, codes, old: v && Array.isArray(v.old) ? v.old : [] };
}
// Every name that is (or was given as) a fixed name.
function known(value) { const b = book(value); return new Set(Object.values(b.codes).concat(b.old, ...collabsOf(value).map((c) => c.members.map((m) => m.name))).filter((x) => typeof x === 'string' && x)); }
// Those of before 0.22.0, written down once: worked out anew each time, they would change when a collaboration ends.
function freeze(value, put) {
  const v = value('sessionCodes', null); if (v && v.codes) return false;
  const b = book(value); if (!Object.keys(b.codes).length) return false;
  put('sessionCodes', Object.assign(b, { old: [...known(value)] }));
  return true;
}
// The session's name, given now if it has none. put: (key, value) -> saves it
function give(value, put, sid, short, pattern) {
  const b = book(value); if (b.codes[sid]) return b.codes[sid];
  const taken = new Set(Object.values(b.codes).concat(b.old));
  let name;
  // a pattern that leaves the number out, or a name too long for it: the number first
  do { b.n++; name = Collab.fixedName(pattern, b.n, short); if (!name || taken.has(name)) name = Collab.fixedName('', b.n, short); } while (taken.has(name));
  b.codes[sid] = name; put('sessionCodes', b);
  return name;
}
module.exports = { book, known, freeze, give };
