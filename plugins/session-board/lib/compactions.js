'use strict';
// What each compaction of a conversation left behind, for the 「壓縮 N 次」 chip (asked 2026-11-26: "can it bring out the
// handoff letter - but think of those who have none"):
//   summary  what Claude Code wrote for itself when it compacted - in every conversation's transcript (a user line with
//            isCompactSummary), so everyone has it
//   handoff  a handoff letter, only where harness's compact hooks are installed in the project: harness writes
//            <transcript folder>/<session id>/compact-snapshots/<stamp>.handoff.md just before compacting (PreCompact,
//            hooks/templates/compact-snapshot.js), <stamp> = UTC YYYYMMDDTHHMMSS
// Text only - the number of tokens before and after is usage, which only cc-statusline gathers;
// this reads content, as the board does to show a conversation.
// A transcript can be large (80 MB and more): read as a stream, only lines that say isCompactSummary are parsed.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MAX = 40;   // the newest ones; a conversation compacted more often than this shows its last forty
const MATCH_MS = 15 * 60000;   // a letter belongs to the compaction that follows it within this time (the letter is
                               // written first, the summary after; writing it takes up to about four minutes)

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '');
// the lines Claude Code puts around its own summary: what was asked to be continued, and notes for the model - not
// part of what the summary says (the summary itself is kept whole)
function cleanSummary(t) {
  let s = String(t || '');
  // its opening notes (content written by others, "This session is being continued…", the tools used before - inside
  // <system-reminder>) come before the summary itself
  if (/^\s*(<artifact-content|This session is being continued)/.test(s)) {
    const r = s.lastIndexOf('</system-reminder>'); if (r >= 0 && r < 60000) s = s.slice(r + '</system-reminder>'.length);
    else { const k = s.indexOf('The summary below covers'); if (k >= 0) s = s.slice(s.indexOf('\n', k) + 1); }
  }
  // the model's own working notes before its summary, kept by some versions: <analysis>…</analysis>
  // (Claude Code takes the tags out, so the notes run straight into "Summary:" - seen 2026-11-26)
  s = s.replace(/^\s*<analysis>[\s\S]*?<\/analysis>\s*/, '').replace(/^\s*<summary>\s*/, '').replace(/\s*<\/summary>\s*$/, '');
  const i = s.indexOf('Summary:'); if (i >= 0 && (i < 400 || /^\s*<analysis>/.test(s))) s = s.slice(i + 'Summary:'.length);
  const j = s.search(/\n\s*If you need specific details from before compaction/); if (j > 0) s = s.slice(0, j);
  return s.trim();
}
const stampMs = (st) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(st); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; };

// the handoff letters harness wrote for this conversation: [{at, file, text}]
function handoffs(transcript, sid) {
  const dir = path.join(path.dirname(transcript), String(sid), 'compact-snapshots');
  let names = []; try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const m = /^(\d{8}T\d{6})\.handoff\.md$/.exec(n); if (!m) continue;
    const at = stampMs(m[1]); if (!Number.isFinite(at)) continue;
    let text = ''; try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { continue; }
    out.push({ at, file: path.join(dir, n), text });
  }
  return out.sort((a, b) => a.at - b.at);
}

// -> Promise<{ok, items: [{at, summary, handoff}] newest first, hasHarness}>
function list(transcript, sid) {
  return new Promise((resolve) => {
    if (!transcript || !fs.existsSync(transcript)) return resolve({ ok: false, error: '找不到這個對話的紀錄', items: [] });
    const found = [];
    let rl;
    try { rl = readline.createInterface({ input: fs.createReadStream(transcript, { encoding: 'utf8' }), crlfDelay: Infinity }); }
    catch (e) { return resolve({ ok: false, error: String(e.message || e), items: [] }); }
    rl.on('line', (line) => {
      if (!line.includes('"isCompactSummary":true')) return;
      let o; try { o = JSON.parse(line); } catch (e) { return; }
      if (!o.isCompactSummary) return;
      const at = Date.parse(o.timestamp || '');
      const summary = cleanSummary(textOf(o.message && o.message.content));
      if (summary) found.push({ at: Number.isFinite(at) ? at : 0, summary });
    });
    rl.on('error', () => resolve({ ok: false, error: '讀不到這個對話的紀錄', items: [] }));
    rl.on('close', () => {
      const letters = handoffs(transcript, sid), used = new Set();
      // each letter to the first compaction after it (within MATCH_MS); a letter with no compaction after it is left out
      const items = found.map((f) => {
        let best = -1;
        letters.forEach((l, i) => { if (!used.has(i) && l.at <= f.at + 60000 && f.at - l.at <= MATCH_MS && (best < 0 || l.at > letters[best].at)) best = i; });
        if (best >= 0) used.add(best);
        return { at: f.at, summary: f.summary, handoff: best >= 0 ? letters[best].text : null };
      });
      resolve({ ok: true, items: items.reverse().slice(0, MAX), total: items.length, hasHarness: letters.length > 0 });
    });
  });
}

module.exports = { list, cleanSummary, handoffs, stampMs, MATCH_MS };
