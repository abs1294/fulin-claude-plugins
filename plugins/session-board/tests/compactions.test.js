'use strict';
// What each compaction left (lib/compactions.js): Claude Code's summary for everyone, harness's handoff letter where
// it is written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/compactions');

const SID = '11111111-2222-4333-8444-555555555555';
const line = (o) => JSON.stringify(o) + '\n';
const summary = (ts, text) => line({ type: 'user', isCompactSummary: true, timestamp: ts, message: { role: 'user', content: text } });
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

test('summaries cleaned of Claude Code\'s opening notes; newest first; a letter matched to the compaction after it', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cmp-')), t = path.join(d, SID + '.jsonl');
  const t1 = Date.UTC(2026, 10, 26, 1, 0, 0), t2 = Date.UTC(2026, 10, 26, 3, 0, 0), t3 = Date.UTC(2026, 10, 26, 5, 0, 0);
  fs.writeFileSync(t,
    line({ type: 'user', timestamp: new Date(t1 - 1000).toISOString(), message: { role: 'user', content: '你好' } }) +
    summary(new Date(t1).toISOString(), 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: A\n\nIf you need specific details from before compaction (like exact code snippets), read the full transcript at: x') +
    summary(new Date(t2).toISOString(), [{ type: 'text', text: '<artifact-content-authored-by-others/>\nThe summarized conversation included Artifact content.\nThis session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n</system-reminder>\n<analysis>\nnotes\nlist.Summary:\n1. Primary Request and Intent: B' }]) +
    summary(new Date(t3).toISOString(), '## What this work is for:\n\nC'));
  // harness: a letter written just before the 2nd compaction, and one with no compaction after it
  const snaps = path.join(d, SID, 'compact-snapshots'); fs.mkdirSync(snaps, { recursive: true });
  fs.writeFileSync(path.join(snaps, stamp(t2 - 3 * 60000) + '.handoff.md'), '## 未完成\n交接信 B');
  fs.writeFileSync(path.join(snaps, stamp(t3 + 3600000) + '.handoff.md'), '沒有壓縮跟著它');
  fs.writeFileSync(path.join(snaps, stamp(t2 - 3 * 60000) + '.summary.md'), 'not a letter');
  const r = await C.list(t, SID);
  // how many times is cc-statusline's to say (lib/stats.js), not counted from the transcript here
  assert.deepStrictEqual([r.ok, 'total' in r, r.hasHarness], [true, false, true]);
  assert.deepStrictEqual(r.items.map((i) => [i.summary, i.handoff]), [['## What this work is for:\n\nC', null], ['1. Primary Request and Intent: B', '## 未完成\n交接信 B'], ['1. Primary Request and Intent: A', null]]);
  assert.strictEqual(r.items[1].at, t2);
});

test('no harness: summaries alone; no transcript: said so', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cmp-')), t = path.join(d, SID + '.jsonl');
  fs.writeFileSync(t, summary('2026-11-26T01:00:00.000Z', 'Summary:\nX'));
  const r = await C.list(t, SID);
  assert.deepStrictEqual([r.ok, r.hasHarness, r.items.length, r.items[0].handoff, r.items[0].summary], [true, false, 1, null, 'X']);
  const none = await C.list(path.join(d, 'missing.jsonl'), SID);
  assert.strictEqual(none.ok, false);
});
