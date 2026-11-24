// What one conversation has used so far: tokens and API-equivalent cost, its
// subagents included, read from its transcripts -- incrementally -- and kept in
// state/claude-toksum2-<sid>.json. THE place every other plugin reads a
// conversation's figures from (session-board); nobody else counts them.
//
// Written by the status line at every render and by the hooks after a reply, a
// message and a subagent (scripts/session-usage.js), so it keeps counting where
// there is no status line at all. Before that it stood still from the moment a
// conversation moved from a terminal to session-board (2026-11-24: 1147 shown
// for three days, 1631 real).
//
// File, for readers: { v: 1, at, total, context }
//   at     ms, when it was last brought up to date
//   total  { cost, tok, mainCost, mainTok, agentCost, agentTok, agentRuns, unpricedTok, approxTok }
//          cost in USD at list price; agentRuns: how many subagents have a transcript;
//          unpricedTok / approxTok > 0: part of it has no price, or a stand-in one
//          what a copy of a conversation (--fork-session) carried over is not in it
//   context  { tokens, model, effort, at } of the newest reply in the conversation: what went in
//          (input, cache read and cache write) is how much of the window is in use. null: no reply yet.
//          In a copy of a conversation (--fork-session) that is one carried over until it has its own:
//          what was carried over costs the copy nothing, but it fills its window
//   Fields are added, never changed. Our own (may change): files, ids, sig, missing, how.
//   Written before 1.10.0: no v / at / total.
'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const priceLib = require('./lib-price');

const HOW = 3;   // how turns are counted: goes up when that changes, and everything is read again
const num = (x) => (Number.isFinite(x) ? Math.max(0, x) : 0);

// The main transcript plus everything beside it: subagents are under
// <dir>/<session-id>/subagents/*.jsonl, those of a workflow deeper
// (subagents/workflows/wf_x/*.jsonl; until 1.10.0 they were left out: a
// conversation of $185 read $54).
// -> {list: [{p, k}], partial}: k is its name under the conversation ('' the conversation itself), the same however the path
// is spelled and wherever the project folder is moved; partial: a folder could not be read.
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
function targets(transcript) {
  const list = [{ p: transcript, k: '' }], base = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'));
  let partial = false;
  const walk = (dir, rel, depth) => {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') partial = true; return; }
    for (const e of es) {
      const p = path.join(dir, e.name), k = rel + '/' + (FOLD ? e.name.toLowerCase() : e.name);
      if (e.isDirectory()) { if (depth < 6) walk(p, k, depth + 1); } else if (e.name.endsWith('.jsonl')) list.push({ p, k });
    }
  };
  walk(base, '', 0);
  return { list, partial };
}

// -> { total, context, missing: price keys to look up } or null when no transcript could be
// read. Each file keeps its own byte offset. The state records the price-table
// signature it was computed under; when the table changes (a backfilled price)
// the sums are stale and everything is read again. How turns are deduped, and
// why: statusline.js ("Real session token usage").
const MARK = 256;   // bytes before where the last reading stopped, kept as a hash: a file rewritten since is told by it
const markOf = (p, off) => {
  const n = Math.min(MARK, off); if (!n) return '';
  let fd; try { fd = fs.openSync(p, 'r'); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off - n); return require('crypto').createHash('md5').update(b).digest('base64').slice(0, 12); } catch (e) { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
};
function update({ transcript, file, resolvePrice, priceSig, write }) {
  let prev = { files: {}, ids: [], missing: [], context: null, at: 0 }, kept = null;   // kept: what is there, also when it was counted otherwise (a price changed since) and cannot be carried on
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.v >= 1 && raw.total && typeof raw.total === 'object') kept = raw;
    if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object' && raw.sig === priceSig && raw.how === HOW) {
      prev = { files: raw.files, ids: Array.isArray(raw.ids) ? raw.ids : [], missing: Array.isArray(raw.missing) ? raw.missing : [], context: raw.context && typeof raw.context === 'object' ? raw.context : null, at: num(raw.at) };
    }
  } catch (e) {}
  const { list, partial } = targets(transcript);
  // A transcript shorter than it was, or rewritten: what is kept describes something else, so everything is read again.
  for (const { p, k } of list) {
    const f = prev.files[k]; if (!f) continue;
    let size; try { size = fs.statSync(p).size; } catch (e) { continue; }
    const off = num(f.off), mark = off && off <= size ? markOf(p, off) : '';
    if (mark === null) continue;   // cannot be read this moment: what is kept stays
    if (off > size || (off && mark !== f.mark)) { prev = { files: {}, ids: [], missing: [], context: null, at: 0 }; break; }
  }
  // Keys seen in bytes consumed earlier still need their lookup.
  const missing = new Set(prev.missing);
  const seen = new Set(prev.ids);
  const files = {};
  const total = { cost: 0, tok: 0, mainCost: 0, mainTok: 0, agentCost: 0, agentTok: 0, agentRuns: 0, unpricedTok: 0, approxTok: 0 };
  let readAny = false, failed = partial, context = prev.context;
  const take = (k, f) => {
    files[k] = f;
    total.tok += f.tok; total.cost += f.cost; total.unpricedTok += f.unpricedTok; total.approxTok += f.approxTok;
    if (k === '') { total.mainCost += f.cost; total.mainTok += f.tok; } else { total.agentCost += f.cost; total.agentTok += f.tok; if (f.tok > 0) total.agentRuns++; }
  };
  for (const { p: tp, k } of list) {
    let st;
    try { st = fs.statSync(tp); } catch (e) { if (e.code !== 'ENOENT') failed = true; continue; }
    // size 0 is a not-yet-written transcript or (on Windows) a directory, which
    // statSync also reports as size 0 while openSync would happily open it.
    if (!st.isFile() || st.size === 0) continue;

    const p0 = prev.files[k];
    let off = p0 ? num(p0.off) : 0;
    let fTok = p0 ? num(p0.tok) : 0;
    let fCost = p0 ? num(p0.cost) : 0;
    let fUnp = p0 ? num(p0.unpricedTok) : 0;
    let fApx = p0 ? num(p0.approxTok) : 0;
    if (off > st.size) { off = 0; fTok = 0; fCost = 0; fUnp = 0; fApx = 0; }   // it was cut this very moment

    readAny = true;
    if (off === st.size) { take(k, { off, mark: p0.mark, tok: fTok, cost: fCost, unpricedTok: fUnp, approxTok: fApx }); continue; }

    let buf = '';
    let consumed = off;
    let fd = null;
    try {
      fd = fs.openSync(tp, 'r');
      const CHUNK = 1 << 20;
      const chunk = Buffer.allocUnsafe(CHUNK);
      // StringDecoder, not chunk.toString(): a multi-byte character straddling a
      // chunk boundary would otherwise decode as two U+FFFD replacements. That
      // corrupts the JSON on that line AND inflates Buffer.byteLength by 2 bytes
      // per occurrence, so the stored offset drifts past the real position and
      // the next reading skips live data. The decoder holds the partial sequence
      // until the next chunk completes it.
      const decoder = new StringDecoder('utf8');
      let pos = off;
      while (pos < st.size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        buf += decoder.write(chunk.subarray(0, n));
        // Only whole lines are processed; a trailing partial line stays in buf
        // and is re-read next time, because consumed never advances past it.
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          consumed += Buffer.byteLength(line, 'utf8') + 1;
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            const u = j.message && j.message.usage;
            if (!u) continue;
            // Dedup by message.id across ALL files: the same assistant turn is
            // written several times, and a subagent turn can also be echoed into
            // the parent transcript. keep-first.
            if (k === '' && j.isSidechain !== true && j.message.model !== '<synthetic>') {
              context = { tokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens), model: typeof j.message.model === 'string' ? j.message.model : '', effort: typeof j.effort === 'string' ? j.effort.slice(0, 12) : '', at: Date.parse(j.timestamp) || 0 };
            }
            const id = j.message.id;
            if (id) { if (seen.has(id)) continue; seen.add(id); }
            // A copy of a conversation (--fork-session) holds what it was copied from, and
            // says whose request each of those turns was: they are the original's.
            if (k === '' && typeof j.requestSessionId === 'string' && j.requestSessionId && j.requestSessionId !== path.basename(transcript, '.jsonl')) continue;
            const t = priceLib.usageTok(u);
            fTok += t;
            const r = resolvePrice(j.message.model);
            if (!r.exact) missing.add(r.key);
            if (!r.pr) fUnp += t;
            else { fCost += priceLib.usageCost(u, r.pr); if (!r.exact) fApx += t; }
          } catch (e) { /* half-written or non-JSON line: skip */ }
        }
      }
    } catch (e) {
      failed = true;   // Keep whatever this file contributed before the failure.
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
    take(k, { off: consumed, mark: (consumed === off && p0 ? p0.mark : markOf(tp, consumed)) || '', tok: fTok, cost: fCost, unpricedTok: fUnp, approxTok: fApx });
  }
  // One that was counted and is not there now (it, or its folder, cannot be read this moment; a subagent's that was
  // cleared away): what it came to stays. Its messages are known, so it could not be counted again later.
  for (const [k, f] of Object.entries(prev.files)) if (!files[k] && f && typeof f === 'object') take(k, { off: num(f.off), mark: f.mark || '', tok: num(f.tok), cost: num(f.cost), unpricedTok: num(f.unpricedTok), approxTok: num(f.approxTok) });
  // It had to be counted from the start and not everything could be read: what there is stays, rather than a part of it.
  if (failed && kept && !Object.keys(prev.files).length) return { total: kept.total, context: kept.context || null, missing: [...missing] };
  if (!readAny) return null;
  // Cap the id list: only ids that could still reappear matter, and an unbounded
  // array would grow the state file forever on long sessions.
  const ids = [...seen].slice(-4000);
  try { write(file, JSON.stringify({ v: 1, at: failed && prev.at ? prev.at : Date.now(), total, context, files, ids, sig: priceSig, how: HOW, missing: [...missing] })); } catch (e) {}
  return { total, context, missing: [...missing] };
}

module.exports = { update };
