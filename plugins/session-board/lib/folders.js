'use strict';
// A folder as you say it: its whole path, or only its name (asked 2026-11-24: 使用者可能連路徑的概念都沒有，他可能只會給你
// 這個資料夾的名字). A name is the last part of a path, with no slash in it; upper and lower case are the same. The folders
// known are those conversations ran in, and the ones those are in (claude-mem runs in ~/.claude-mem/observer-sessions/x:
// asked for by its name, it is ".claude-mem").
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32', SEP = WIN ? /[\\/]+/ : /\/+/, END = WIN ? /[\\/]+$/ : /\/+$/;   // (a backslash is a letter like any other in a Mac's names)
// pasted in quotes: without them. One that is part of the name (a Mac allows it) stays: only a pair is taken off.
const clean = (t) => { const s = String(t || '').trim(); return /^(["']).*\1$/.test(s) && s.length > 1 ? s.slice(1, -1).trim() : s; };
// the same letters, however they are put together (a Mac may keep a name's accents apart), upper or lower case
const fold = (s) => String(s).normalize('NFC').toLowerCase();
const isName = (t) => { const s = clean(t).replace(END, ''); return !!s && !SEP.test(s) && s !== '~' && s !== '.' && s !== '..' && !/^[A-Za-z]:$/.test(s); };
// '~' is your home; no slash at the end (the root keeps its: / and C:\, also written C: or C:/)
const whole = (t) => {
  const s = path.normalize(clean(t).replace(WIN ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, () => os.homedir()).replace(/^([A-Za-z]:)$/, (m) => (WIN ? m + '\\' : m)));
  return s === path.parse(s).root ? s : s.replace(END, '');
};
const parts = (p) => path.normalize(String(p || '')).split(SEP).filter(Boolean);
// What Finder and Explorer show for the folders of your home, and what they are called on the disk.
const SHOWN = { __proto__: null, 桌面: 'desktop', 文件: 'documents', 下載: 'downloads', 下載項目: 'downloads', 圖片: 'pictures', 影片: WIN ? 'videos' : 'movies', 音樂: 'music' };
const names = (t) => { const n = fold(clean(t).replace(END, '')); return SHOWN[n] ? [n, SHOWN[n]] : [n]; };
// (the shown name is only your home's own: a Desktop somewhere else is not 桌面)
const homes = (p, home) => !!home && fold(p) === fold(path.join(os.homedir(), home));
const name = (p) => parts(p).pop() || '';

// Is it in (or is it) this folder? entry: a path, or a name - then any folder of that name.
function within(cwd, entry) {
  if (!cwd || !clean(entry)) return false;
  // a folder of your home by the name it is shown by is that one; any other name, any folder of that name
  if (isName(entry)) { const [n, home] = names(entry); return parts(cwd).some((x) => fold(x) === n) || (!!home && within(cwd, path.join(os.homedir(), home))); }
  const f = fold(whole(cwd)), d = fold(whole(entry));
  return f === d || f.startsWith(END.test(d) ? d : d + path.sep);
}
const withinAny = (cwd, list) => list.some((x) => within(cwd, x));

// The folder and the ones it is in, itself first.
function chain(p) {
  const out = [];
  for (let x = path.normalize(p).replace(WIN ? /(?!^)[\\/]+$/ : /(?!^)\/+$/, ''); x && !out.includes(x); x = path.dirname(x)) { out.push(x); if (path.dirname(x) === x) break; }
  return out;
}
// counts: Map folder -> how many conversations. The known folders with q in their name (or, q with a slash, in their
// path), each with all that is inside it: the same name first, then the ones with most. Not the root of a disk.
function search(q, counts, max = 12) {
  const raw = clean(q), k = fold(raw).replace(END, ''), byPath = SEP.test(raw) || raw.startsWith('~'), want = byPath ? fold(whole(raw)) : k, also = byPath ? '' : names(raw)[1], sums = new Map();
  for (const [cwd, n] of counts) {
    for (const p of chain(cwd)) {
      if (path.dirname(p) === p) continue;
      const nm = fold(name(p));
      if (k && !(byPath ? fold(p).includes(want) : nm.includes(k) || homes(p, also))) continue;
      if (!k && p !== path.normalize(cwd)) continue;
      const key = fold(p), had = sums.get(key); if (had) had.n += n; else sums.set(key, { path: p, name: name(p), n });
    }
  }
  const same = (x) => (fold(x.name) === k || homes(x.path, also) ? 0 : 1);
  return [...sums.values()].sort((a, b) => same(a) - same(b) || b.n - a.n || a.path.localeCompare(b.path)).slice(0, max);
}

// What was typed -> {ok, path} ('' for nothing), or {ok: false, error, choices}. A name is looked for among the known
// folders that still exist: one a conversation ran in comes before one that only holds such a folder.
function resolve(text, counts, isDir) {
  const t = clean(text); if (!t) return { ok: true, path: '' };
  const said = String(text).trim(); if (path.isAbsolute(said) && isDir(said)) return { ok: true, path: said === path.parse(said).root ? said : said.replace(END, '') };   // just as it is
  if (!isName(t)) { const p = whole(t); return path.isAbsolute(p) && isDir(p) ? { ok: true, path: p } : { ok: false, error: '這個資料夾不存在：' + t.slice(0, 200) }; }
  const ns = names(t), ran = new Set([...counts.keys()].map((x) => fold(path.normalize(x))));
  const all = search(t, counts, 1000).filter((x) => (fold(x.name) === ns[0] || homes(x.path, ns[1])) && isDir(x.path)), own = all.filter((x) => ran.has(fold(x.path))), hit = own.length ? own : all;
  if (hit.length === 1) return { ok: true, path: hit[0].path };
  if (!hit.length) return { ok: false, error: '沒有用過叫「' + t.slice(0, 80) + '」的資料夾。請從清單選、按「選擇資料夾…」，或貼上完整路徑' };
  return { ok: false, choices: hit.map((x) => x.path), error: '有 ' + hit.length + ' 個叫「' + t.slice(0, 80) + '」的資料夾，請選一個：' + hit.slice(0, 5).map((x) => x.path).join('、') + (hit.length > 5 ? '，還有 ' + (hit.length - 5) + ' 個' : '') };
}

module.exports = { isName, whole, within, withinAny, search, resolve };
