'use strict';
// The subagents a terminal session has running, with what each is doing - read from its own transcript.
//
// cc-statusline knows only their kinds ("general-purpose") and times; what one was asked to do is in the Agent tool
// call that started it (input.description). One is running from that call until
//   - its result comes back (a subagent run in the foreground), or
//   - a <task-notification> naming that call (<tool-use-id>) says it stopped (one run in the background; its first
//     result is only "Async agent launched ...").
// Only the end of the transcript is read (TAIL_BYTES): a subagent started before that is not listed here - the page
// still shows it by its kind, from cc-statusline.
const fs = require('fs');

const TAIL_BYTES = 3 * 1024 * 1024;
const MAX = 12;

function tail(file, bytes) {
  let fd;
  try {
    const size = fs.statSync(file).size, from = Math.max(0, size - bytes);
    fd = fs.openSync(file, 'r'); const b = Buffer.alloc(size - from); fs.readSync(fd, b, 0, b.length, from);
    const t = b.toString('utf8');
    return from > 0 ? t.slice(t.indexOf('\n') + 1) : t;
  } catch (e) { return ''; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
}
const textOf = (e) => {
  if (e.type === 'queue-operation') return typeof e.content === 'string' ? e.content : '';
  const c = e.message && e.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join('') : '';
};

// -> [{id, kind, description, startedAt}] oldest first. Kept per file while its size and time are the same (the stats are
// asked for every few seconds; the transcript of an idle session does not change).
const kept = new Map();
function running(file, o = {}) {
  let st = null; try { st = fs.statSync(file); } catch (e) { return []; }
  const key = file + '|' + (o.tailBytes || TAIL_BYTES);
  const k = kept.get(key);
  if (k && k.size === st.size && k.mtimeMs === st.mtimeMs) { kept.delete(key); kept.set(key, k); return k.list; }   // used: to the back
  const list = readRunning(file, o);
  kept.delete(key); kept.set(key, { size: st.size, mtimeMs: st.mtimeMs, list });
  if (kept.size > 200) kept.delete(kept.keys().next().value);   // the one used longest ago
  return list;
}
function readRunning(file, o) {
  const started = new Map(), done = new Set();
  for (const line of tail(file, o.tailBytes || TAIL_BYTES).split('\n')) {
    // a quick look before parsing: the subagent tool is "Agent" (older Claude Code: "Task")
    if (!line || (!line.includes('"Agent"') && !line.includes('"Task"') && !line.includes('tool_result') && !line.includes('task-notification'))) continue;
    let e; try { e = JSON.parse(line); } catch (x) { continue; }
    const c = e.message && e.message.content;
    if (e.type === 'assistant' && Array.isArray(c)) {
      for (const x of c) if (x && x.type === 'tool_use' && (x.name === 'Agent' || x.name === 'Task') && x.id) {
        const i = x.input || {};
        started.set(x.id, { id: x.id, kind: String(i.subagent_type || 'general-purpose'), description: String(i.description || '').replace(/\s+/g, ' ').trim().slice(0, 160), startedAt: Date.parse(e.timestamp) || 0 });
      }
      continue;
    }
    if (e.type === 'user' && Array.isArray(c)) {
      for (const x of c) if (x && x.type === 'tool_result' && x.tool_use_id) {
        const t = typeof x.content === 'string' ? x.content : JSON.stringify(x.content || '');
        if (!/Async agent launched/.test(t)) done.add(x.tool_use_id);   // a background one goes on after this
      }
    }
    const t = textOf(e);
    // every notice in what came in (several can come in one message, after other text); only whole ones (with the
    // closing tag) count, and only for a call that is in this transcript (a pasted look-alike for another changes nothing)
    if (t.includes('<task-notification>')) {
      const re = /<task-notification>([\s\S]*?)<\/task-notification>/g; let m;
      while ((m = re.exec(t))) {
        const id = ((/<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[1]) || [])[1] || '').trim();
        const st = (/<status>([^<]+)<\/status>/.exec(m[1]) || [])[1] || '';
        if (id && st && st !== 'running' && started.has(id)) done.add(id);
      }
    }
  }
  return [...started.values()].filter((a) => !done.has(a.id)).slice(-MAX);
}

module.exports = { running, TAIL_BYTES };
