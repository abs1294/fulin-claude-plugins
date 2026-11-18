'use strict';
// "Edit and send again" for a board conversation: where in its transcript to carry it on from, so that the edited
// message takes the place of the one you said there.
//
// Claude Code carries a conversation on from a given entry with --resume <id> --resume-session-at <entry uuid>
// (with --fork-session, under a new id; the original is left as it was). Measured 2026-11-18 on 2.1.327: a two-turn
// conversation carried on from the first reply knew only what was said before it.
//
// The place is the newest reply (an "assistant" entry) before the message, found by walking back its parentUuid
// chain; none (the first message) means a conversation that starts afresh. A message from before the last compaction
// cannot be gone back to: Claude Code holds only the summary of what came before it.
const fs = require('fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -> {ok: true, at: '<assistant uuid>' | null} | {ok: false, error}
function resumePoint(file, uuid) {
  if (!UUID.test(String(uuid || ''))) return { ok: false, error: '缺少要編輯的那則訊息' };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: '讀不到這個對話的紀錄' }; }
  const by = new Map();
  let lastCompact = -1, line = 0, at = -1;
  for (const raw of text.split('\n')) {
    line++;
    if (!raw.trim()) continue;
    let e; try { e = JSON.parse(raw); } catch (x) { continue; }
    if (!e || typeof e.uuid !== 'string') continue;
    by.set(e.uuid, { type: e.type, parent: typeof e.parentUuid === 'string' ? e.parentUuid : null, line, said: said(e) });
    if ((e.type === 'system' && e.subtype === 'compact_boundary') || (e.type === 'user' && e.isCompactSummary)) lastCompact = line;
    if (e.uuid === uuid) at = line;
  }
  const me = by.get(uuid);
  if (!me) return { ok: false, error: '這則訊息在對話紀錄裡找不到（可能還沒寫進去，等一下再試）' };
  if (!me.said) return { ok: false, error: '只有你自己打的訊息可以編輯' };
  if (lastCompact > at) return { ok: false, error: '這則在對話被壓縮之前，Claude Code 只留下摘要，沒辦法回到這裡重來' };
  for (let p = me.parent, n = 0; p && n < 100000; n++) {
    const e = by.get(p);
    if (!e) break;
    if (e.type === 'assistant') return { ok: true, at: p };
    p = e.parent;
  }
  return { ok: true, at: null };
}

// what you typed: a user entry of words (not a tool's result, not a summary, not a notice), or one said while it worked
function said(e) {
  if (e.isSidechain || e.isMeta) return false;
  if (e.type === 'attachment') return !!(e.attachment && e.attachment.type === 'queued_command');
  if (e.type !== 'user' || e.isCompactSummary || !e.message) return false;
  const c = e.message.content;
  if (typeof c === 'string') return !!c.trim();
  return Array.isArray(c) && c.some((b) => b && b.type === 'text') && !c.some((b) => b && b.type === 'tool_result');
}

module.exports = { resumePoint, UUID };
