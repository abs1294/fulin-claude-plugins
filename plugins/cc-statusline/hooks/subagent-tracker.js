const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked CAS merge (see lib-state.js). The previous local copy had no
// inter-process lock, so concurrent SubagentStart hooks silently lost entries.
const { casMerge } = require('./lib-state');

// A running entry whose SubagentStop never arrived would otherwise sit in the
// state file forever, permanently occupying a display slot with a "○" for work
// that ended long ago. Treat it as lost after this long and downgrade it to
// done, which keeps the name in the history instead of dropping it outright.
// 4h, not minutes: legitimate long-running agents of 30+ minutes are normal on
// this machine, and a too-eager threshold would mark live work as finished.
const RUNNING_STALE_MS = 4 * 60 * 60 * 1000;

// Total done-instance budget. Raised from 20 to 40 because the per-name floor
// below now reserves one slot per distinct name; 40 keeps the file small
// (~4KB at observed ~100B/entry) while leaving room for repeat instances of
// the busiest names. NOTE: this caps only pass 2 (extra instances) — pass 1's
// one-per-name floor is unconditional, so the file grows linearly with
// distinct names and this is NOT a hard file-size cap (deliberate: never
// drop a name).
const DONE_BUDGET = 40;

// Prune that preserves NAMES, not just instances.
//
// The statusline groups instances by name for display, but the old prune kept
// only the newest 20 instances outright. A few repeat calls of one agent could
// therefore evict another name's ONLY instance, and that agent vanished from
// the status line mid-session — the "agents got mysteriously refreshed" report.
// Reproduced on real data: 4 new runs made `codex:codex-rescue` disappear.
//
// Now: every distinct name keeps its newest done instance first, and only the
// leftover budget is filled with additional (newer-first) instances.
const prune = (state) => {
  const now = Date.now();
  const entries = Object.entries(state);
  const running = [], done = [];
  for (const [k, v] of entries) {
    if (v && v.status === 'running') {
      if ((now - (v.started || 0)) > RUNNING_STALE_MS) {
        done.push([k, { ...v, status: 'done', finished: v.started || now }]);
      } else {
        running.push([k, v]);
      }
    } else if (v) {
      done.push([k, v]);
    }
  }
  done.sort((a, b) => (b[1].finished || 0) - (a[1].finished || 0));

  // Pass 1: newest instance of each distinct name (guaranteed a slot).
  const kept = [], seen = new Set();
  for (const e of done) {
    const n = (e[1] && e[1].name) || e[0];
    if (!seen.has(n)) { seen.add(n); kept.push(e); }
  }
  // Pass 2: fill the remaining budget with the newest of everything else.
  if (kept.length < DONE_BUDGET) {
    const keptKeys = new Set(kept.map(e => e[0]));
    for (const e of done) {
      if (kept.length >= DONE_BUDGET) break;
      if (!keptKeys.has(e[0])) kept.push(e);
    }
  }
  // Re-sort so the file stays newest-first regardless of which pass added it.
  kept.sort((a, b) => (b[1].finished || 0) - (a[1].finished || 0));

  for (const k of Object.keys(state)) delete state[k];
  for (const [k, v] of [...running, ...kept]) state[k] = v;
};
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const event = i.hook_event_name;
    if (event !== 'SubagentStart' && event !== 'SubagentStop') return;
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = path.join(os.tmpdir(), `claude-agents-${sid}.json`);

    let name = i.agent_type;
    if (!name && typeof i.agent_id === 'string') {
      if (i.agent_id.startsWith('acompact-')) name = 'compact';
    }
    if (!name) return;

    // Per-instance key: prefer agent_id (stable), fallback to name + timestamp to avoid collision
    const key = (typeof i.agent_id === 'string' && i.agent_id) ? i.agent_id : `${name}-${Date.now()}`;
    const myStamp = Date.now();

    casMerge(file,
      (state) => {
        if (event === 'SubagentStart') {
          state[key] = { name, status: 'running', started: myStamp };
        } else {
          const prev = state[key] || {};
          state[key] = { name, status: 'done', started: prev.started, finished: myStamp };
        }
        // Keep live entries, guarantee every name a slot, cap the rest.
        prune(state);
      },
      (after) => {
        const e = after[key];
        if (!e) return false;
        return event === 'SubagentStart' ? e.started === myStamp : e.finished === myStamp;
      }
    );
  } catch (e) {}
});
