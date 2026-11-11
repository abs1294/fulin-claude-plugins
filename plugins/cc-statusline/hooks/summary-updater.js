// UserPromptSubmit: every ~10 messages, nudge Claude to update session summary.
// Also on every trigger, sync the latest summary into the transcript as a
// `custom-title` entry so /resume picker shows a meaningful name instead of
// "first user message" fallback.
const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked read -> increment -> write of the message counter (lib-state): two
// prompts' hooks racing unlocked would both read N and both write N+1.
const { atomicWrite, withFileLock, stateFile } = require('./lib-state');

// Most recent custom-title in the transcript (null if none). Reads backwards in
// 4 MB chunks and stops at the first match, instead of loading the whole file
// as one string: long sessions reach hundreds of MB and the whole-file read
// peaked at ~1.1 GB per prompt on a 360 MB transcript (2026-11-11).
// Same result as scanning lines from the end: the first line containing the
// marker wins, even if it fails to parse (then the title is null).
function lastCustomTitle(file) {
  const MARK = '"type":"custom-title"';
  const MARKB = Buffer.from(MARK);
  const CHUNK = 4 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    const pick = (line) => { let t = null; try { t = JSON.parse(line).customTitle; } catch (e) {} return t; };
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      // Fast skip: no marker in any complete line of this chunk -> keep only the
      // leading partial line as carry, without decoding every line to a string.
      const firstNl = data.indexOf(10);
      if (firstNl < 0 || data.indexOf(MARKB, firstNl + 1) === -1) {
        carry = Buffer.from(firstNl < 0 ? data : data.subarray(0, firstNl));
        continue;
      }
      let end = data.length;
      for (let k = len - 1; k >= 0; k--) {
        if (data[k] !== 10) continue;
        const line = data.toString('utf8', k + 1, end);
        end = k;
        if (line.includes(MARK)) return pick(line);
      }
      carry = Buffer.from(data.subarray(0, end));
    }
    const first = carry.toString('utf8');
    return first.includes(MARK) ? pick(first) : null;
  } finally {
    fs.closeSync(fd);
  }
}
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const countFile = stateFile(`claude-msgcount-${sid}`);
    const summaryFile = stateFile(`claude-summary-${sid}.txt`);

    // Sync current summary → transcript custom-title (takes effect in /resume picker).
    // Skip if no transcript path or no summary yet. Only rewrite when it would change,
    // so we don't bloat the transcript with duplicate entries.
    try {
      if (i.transcript_path && fs.existsSync(i.transcript_path) && fs.existsSync(summaryFile)) {
        const sumRaw = fs.readFileSync(summaryFile, 'utf8').trim().split('\n')[0];
        const title = sumRaw.length > 40 ? sumRaw.slice(0, 39) + '\u2026' : sumRaw;
        if (title && i.session_id) {
          // Find most recent existing custom-title in the transcript to avoid duplicates
          const lastTitle = lastCustomTitle(i.transcript_path);
          if (lastTitle !== title) {
            const entry = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: i.session_id });
            fs.appendFileSync(i.transcript_path, entry + '\n');
          }
        }
      }
    } catch (e) {}

    const count = withFileLock(countFile, () => {
      let n = 0;
      try { n = parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10) || 0; } catch (e) {}
      n++;
      atomicWrite(countFile, String(n));
      return n;
    });
    if (count === undefined) return;   // lock not had: skip this tick rather than guess

    // Every 10 messages, ask Claude to update summary
    if (count % 10 === 0) {
      const output = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `[Session summary update] Update the WHOLE-SESSION summary in ${summaryFile} using the Write tool.

A session-spanning summary, not just the most recent topic. Capture the session's overall trajectory from start to now.

Steps:
1. Read ${summaryFile} (may not exist).
2. Mentally add the new topic(s) from recent activity.
3. Rewrite so the result stays within HARD LIMIT 120 characters, single line, comma-separated phrases.

Compression rules when adding would exceed 120 chars (MANDATORY — this is not optional):
- Merge related sub-topics into a broader theme (e.g. "A 修正, A 優化, A 測試" → "A 全面整理")
- Drop the least-significant older item (small tweaks, minor fixes) to make room for the new one
- Keep at least ONE earlier theme to preserve trajectory — do NOT collapse into just-the-latest
- The most recent meaningful topic MUST appear

Format: one line, comma-separated phrases, ≤120 chars. User's language. Write tool, silent — do not mention this in chat.`
        }
      };
      process.stdout.write(JSON.stringify(output));
      return;
    }
  } catch (e) {}
});
