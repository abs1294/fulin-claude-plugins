'use strict';
// The mic's own words (asked 2026-11-20: like Typeless and Wispr Flow, a dictionary of your names and terms, and what it
// learns from your corrections - "每個使用者自己維護"): kept in this computer's board folder, one file per person, never in
// a repository and never shared. Three kinds:
//   words    added by you (settings page), or learned (below)
//   fixes    learned from your corrections: after the mic put tidied words in the box, what you changed before sending
//            ("哥特" -> "git"); seen again, the tidying puts it right by itself
//   auto     made up each time from what is on this board - its folders' names and its conversations' titles (no file:
//            they come and go with the board); one you do not want is put in "hidden"
// Used three ways: as hints to the browser's recognizer (SpeechRecognition.phrases, when the browser has it), as keywords
// for the OpenAI transcription (when that is chosen), and given to the tidying with the background.
//
// One per project (asked 2026-11-22: "by 專案，不能全域，畢竟排版要吃"): the tidying puts a misheard word right by these,
// and one project's names are another's noise. Kept in vocab/<an id of the folder>.json (a hash of its path); the
// words "auto" makes up come from that folder's own conversations only. A conversation in no known folder has none.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = () => path.join(os.homedir(), '.claude', 'session-board', 'vocab');
// the one before (0.18 and earlier: one for every folder) - read only to be copied into a project when you ask
const LEGACY = () => path.join(os.homedir(), '.claude', 'session-board', 'vocab.json');
const keyOf = (cwd) => path.normalize(String(cwd || '')).replace(/[\\/]+$/, '').toLowerCase();
// -> the file of a folder's words, or '' (no folder: nothing is kept)
function fileFor(cwd) { return cwd ? path.join(DIR(), crypto.createHash('sha256').update(keyOf(cwd)).digest('hex').slice(0, 16) + '.json') : ''; }
const FILE = fileFor;
const MAX_WORDS = 500, MAX_FIXES = 300, MAX_TERM = 60;
// one line, no < > (the OpenAI transcription refuses a whole request with them in a keyword)
const clean = (t) => String(t == null ? '' : t).replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);

function load(file) {
  let j = {}; try { if (file) j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    words: arr(j.words).filter((w) => w && typeof w.term === 'string' && w.term).map((w) => ({ term: clean(w.term), at: Number(w.at) || 0, learned: !!w.learned })),
    fixes: arr(j.fixes).filter((f) => f && typeof f.heard === 'string' && typeof f.meant === 'string').map((f) => ({ heard: clean(f.heard), meant: clean(f.meant), n: Number(f.n) || 1, at: Number(f.at) || 0 })),
    hidden: arr(j.hidden).filter((h) => typeof h === 'string').map(clean),
  };
}
function save(v, file) {
  if (!file) throw new Error('這個對話不在任何專案資料夾裡，詞庫沒有地方存');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, file);
}

// Words worth knowing from what is on the board: names written with letters (folder names, the English in titles) -
// the ones a recognizer listening for Chinese gets wrong. Most frequent first.
function autoTerms(sources) {
  const n = new Map();
  for (const s of sources || []) for (const m of String(s || '').matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._\-/][A-Za-z0-9]+)*/g)) {
    const t = m[0]; if (t.length < 3 || /^(the|and|for|with|from|this|that|http|https|www|com)$/i.test(t)) continue;
    n.set(t, (n.get(t) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

// Everything, for the settings page: {words, fixes, hidden, auto}
function list(sources, file) {
  const v = load(file), hide = new Set(v.hidden.map((x) => x.toLowerCase())), mine = new Set(v.words.map((w) => w.term.toLowerCase()));
  return Object.assign(v, { auto: autoTerms(sources).filter((t) => !hide.has(t.toLowerCase()) && !mine.has(t.toLowerCase())).slice(0, 150) });
}
// The words to hint with, yours first, then the board's; at most `max`
function terms(sources, max = 100, file) {
  const v = list(sources, file);
  const out = []; const seen = new Set();
  for (const t of v.words.map((w) => w.term).concat(v.fixes.map((f) => f.meant), v.auto)) { const k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); out.push(t); } }
  return out.slice(0, max);
}
// The corrections learned, most used first
function fixes(max = 60, file) { return load(file).fixes.sort((a, b) => b.n - a.n || b.at - a.at).slice(0, max).map((f) => ({ heard: f.heard, meant: f.meant })); }

// -> {ok, error?}
function add(term, file) {
  const t = clean(term); if (!t) return { ok: false, error: '是空的' };
  const v = load(file);
  if (v.words.some((w) => w.term.toLowerCase() === t.toLowerCase())) return { ok: true };
  if (v.words.length >= MAX_WORDS) return { ok: false, error: '詞庫最多 ' + MAX_WORDS + ' 個詞' };
  v.words.push({ term: t, at: Date.now(), learned: false });
  v.hidden = v.hidden.filter((h) => h.toLowerCase() !== t.toLowerCase());
  save(v, file); return { ok: true };
}
// a word of yours or a learned one taken out; one of the board's own is hidden instead (it would come back otherwise)
function remove(term, file) {
  const t = clean(term).toLowerCase(); const v = load(file);
  const before = v.words.length; v.words = v.words.filter((w) => w.term.toLowerCase() !== t);
  if (v.words.length === before && !v.hidden.some((h) => h.toLowerCase() === t)) v.hidden.push(clean(term));
  save(v, file); return { ok: true };
}
function unlearn(heard, meant, file) {
  const v = load(file); v.fixes = v.fixes.filter((f) => !(f.heard === clean(heard) && f.meant === clean(meant))); save(v, file); return { ok: true };
}

// What you changed in the words the mic gave you, before sending them: each replaced piece, short ones only ("哥特 ->
// git", not a sentence rewritten). Words are runs of letters/digits or single CJK characters; punctuation is not a change.
const TOK = /[A-Za-z0-9][A-Za-z0-9._\-/]*|[㐀-鿿豈-﫿]/g;
// a web address: any scheme with :// (http, ssh, file, HTTPS ...), and git's short form user@host:path (git@github.com:o/r,
// user@host:repo.git) - each tried from the start of a run only (from inside a long run of letters it was tried again at
// every one, n²)
const URL_RE = /(?<![A-Za-z0-9+.-])[0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|(?<![\w.+-])[\w.+-]+@[\w.-]+:(?=[\w~.\/-])[\w~.\/+@=%#&$!,-]*/g;
function edits(given, sent) {
  const a = String(given || '').match(TOK) || [], b = String(sent || '').match(TOK) || [];
  if (!a.length || !b.length || a.length > 400 || b.length > 400) return [];
  // longest common subsequence, then the stretches that differ on both sides
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  // rewritten rather than corrected (less than 6 in 10 words kept): only the words written with letters that were put
  // right in it are learned ("哥特" -> "git" inside a sentence said again) - a rewritten sentence is not a mishearing, the
  // name it fixed is (asked 2026-11-21: the tidying is to be right at the moment it is done)
  // (a few words only - "哥特 push" -> "git push" - is a correction whatever the share)
  const rewrite = Math.min(a.length, b.length) >= 5 && L[0][0] < 0.6 * Math.min(a.length, b.length);
  const out = []; let i = 0, j = 0, da = [], db = [];
  const join = (xs) => xs.reduce((s, x) => s + (s && /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(x) ? ' ' : '') + x, '');
  const flush = () => { if (da.length && db.length) out.push({ heard: join(da), meant: join(db) }); da = []; db = []; };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { flush(); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) da.push(a[i++]);
    else db.push(b[j++]);
  }
  while (i < a.length) da.push(a[i++]);
  while (j < b.length) db.push(b[j++]);
  flush();
  // a correction, not a rewrite: short on both sides, and something to hear differently (letters in what you meant, or
  // a few characters swapped)
  // a web address pasted in is not a word misheard (its pieces would be learned as one: 網頁 -> https example.com/a)
  const outside = new Set(String(sent || '').replace(URL_RE, ' ').match(TOK) || []);
  const url = new Set((String(sent || '').match(URL_RE) || []).flatMap((u) => u.match(TOK) || []).filter((t) => !outside.has(t)));
  return out.filter((x) => !(x.meant.match(TOK) || []).some((t) => url.has(t)) && x.heard !== x.meant && x.heard.length <= 20 && x.meant.length <= 30 && (/[A-Za-z]/.test(x.meant) || (!rewrite && x.meant.length <= 6)) && (!rewrite || (x.heard.length <= 12 && /^[A-Za-z0-9._\-/ ]+$/.test(x.meant)))).slice(0, 5);
}
// -> the corrections learned now
// Names written with letters that are in what you sent and were not in what the mic gave you ("git", "session-board"):
// when what you changed cannot be paired with what was heard (a sentence said again), these are still words to listen
// for next time (asked 2026-11-21: the tidying is to be right at the moment it is done). Not ones in a web address.
const NAME = /[A-Za-z][A-Za-z0-9._\-]*[A-Za-z0-9]/g;
// Said again rather than corrected: under 6 in 10 of the words kept (as edits() judges it)
function rewritten(given, sent) {
  const a = String(given || '').match(TOK) || [], b = String(sent || '').match(TOK) || [];
  if (Math.min(a.length, b.length) < 5 || a.length > 400 || b.length > 400) return false;
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  return L[0][0] < 0.6 * Math.min(a.length, b.length);
}
const SEG = String.raw`[A-Za-z0-9_.~+@=%#&$\u00c0-\u024f-]`;
const CJK = '[\\u1100-\\u11ff\\u3040-\\u30ff\\u3130-\\u318f\\u3400-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff]';
const PART = '(?:' + SEG + '|(?<!' + CJK + ')' + CJK + '+(?=' + SEG + '*\\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])))';
// (tried from the start of a run of path characters only - from inside one it was tried again at every character, n²)
// (a drive: a letter, a colon and a slash; right after a mark only a capital - out-C:\\x, e.g.C:/ - a small letter there
// ends a name: util.c:src/x)
const PATH = new RegExp('(?:(?<!' + SEG + ')[A-Za-z]:(?=[\\\\/])|(?<![A-Za-z0-9])[A-Z]:(?=[\\\\/])|(?<!' + SEG + '))' + PART + '*(?:[\\\\/]' + PART + '*)+', 'g');
function newNames(given, sent) {
  const had = new Set((String(given || '').match(NAME) || []).map((x) => x.toLowerCase()));
  // (not the pieces of a web address or of a path: C:\\work\\x.md, src/foo+bar.js, packages/@scope/tool - a path is made of
  // the characters file and folder names use, with a slash in it, and ends at any other: a space, a colon, ? !, quotes and
  // brackets, Chinese, Japanese or Korean - so the words written right next to a path stay; a drive, C:, only where no
  // letter is written right before it)
  const text = String(sent || '').replace(URL_RE, ' ').replace(PATH, ' ');
  return [...new Set((text.match(NAME) || []).filter((x) => x.length >= 2 && x.length <= 30 && !had.has(x.toLowerCase())))].slice(0, 5);
}
// -> what was learned: [{heard, meant}] for a correction, [{heard: '', meant}] for a word to listen for
function learn(given, sent, file) {
  const got = edits(given, sent);
  if (!got.length) {
    // only a sentence said again: words typed on after what the mic gave ("…，順便跑 npm test") are not names misheard
    if (!rewritten(given, sent)) return [];
    const names = newNames(given, sent); if (!names.length) return [];
    const v = load(file), now = Date.now(), added = [];
    for (const t of names) if (!v.words.some((w) => w.term.toLowerCase() === t.toLowerCase()) && v.words.length < MAX_WORDS) { v.words.push({ term: clean(t), at: now, learned: true }); added.push({ heard: '', meant: clean(t) }); }
    if (added.length) save(v, file);
    return added;
  }
  const v = load(file), now = Date.now();
  for (const x of got) {
    const f = v.fixes.find((y) => y.heard === clean(x.heard) && y.meant === clean(x.meant));
    if (f) { f.n++; f.at = now; } else v.fixes.push({ heard: clean(x.heard), meant: clean(x.meant), n: 1, at: now });
    // what you meant, when written with letters, is a word to listen for too
    if (/[A-Za-z]/.test(x.meant) && !v.words.some((w) => w.term.toLowerCase() === x.meant.toLowerCase()) && v.words.length < MAX_WORDS) v.words.push({ term: clean(x.meant), at: now, learned: true });
  }
  v.fixes = v.fixes.sort((a, b) => b.at - a.at).slice(0, MAX_FIXES);
  save(v, file); return got;
}

// The old file's words and corrections copied into a project's (asked when it is there: kept, never deleted) -> {ok, words, fixes}
// What a copy of the old file would add to this project's: what it does not have yet - words, corrections and hidden words
// alike - and only as much as there is room for; what the project has is never pushed out (review 2026-11-22: hidden ones
// were not counted; once copied the button stayed; a full list had its own older corrections cut). The count offered
// and the copy made are this one plan.
// (each taken once, the old file's own repeats too; the newest corrections first when not all fit, as learn() keeps them;
// a word hidden in one and a word of yours in the other: yours wins, as add() makes it - review 2026-11-22)
function plan(v, old) {
  const seen = (arr, key) => { const s = new Set(); return arr.filter((x) => { const k = key(x); if (s.has(k)) return false; s.add(k); return true; }); };
  const lw = (t) => String(t).toLowerCase();
  const have = new Set(v.words.map((x) => lw(x.term)));
  const words = seen(old.words.filter((w) => !have.has(lw(w.term))), (w) => lw(w.term)).slice(0, Math.max(0, MAX_WORDS - v.words.length));
  const mine = new Set([...have, ...words.map((w) => lw(w.term))]);
  const fixes = seen(old.fixes.filter((f) => !v.fixes.some((x) => x.heard === f.heard && x.meant === f.meant)), (f) => f.heard + '\u0000' + f.meant)
    .sort((a, b) => b.at - a.at).slice(0, Math.max(0, MAX_FIXES - v.fixes.length));
  const hidden = seen(old.hidden.filter((h) => !mine.has(lw(h)) && !v.hidden.some((x) => lw(x) === lw(h))), lw);
  return { words, fixes, hidden };
}
function importLegacy(file, from = LEGACY()) {
  if (!file) return { ok: false, error: '這個對話不在任何專案資料夾裡' };
  const old = load(fs.existsSync(from) ? from : ''), v = load(file), p = plan(v, old);
  const added = new Set(p.words.map((w) => w.term.toLowerCase()));
  v.words.push(...p.words); v.fixes.push(...p.fixes);
  v.hidden = v.hidden.filter((h) => !added.has(h.toLowerCase())).concat(p.hidden);   // (a word now yours is not hidden)
  save(v, file); return { ok: true, words: p.words.length, fixes: p.fixes.length, hidden: p.hidden.length };
}
// -> how many entries a copy would add now (0: nothing to offer - the button goes)
function legacyCount(file, from = LEGACY()) { if (!fs.existsSync(from)) return 0; const p = plan(load(file), load(from)); return p.words.length + p.fixes.length + p.hidden.length; }

module.exports = { FILE, fileFor, DIR, LEGACY, importLegacy, legacyCount, load, save, list, terms, fixes, add, remove, unlearn, edits, learn, newNames, rewritten, autoTerms, clean, MAX_WORDS };
