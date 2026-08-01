const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked CAS merge (see lib-state.js). The previous local copy had no
// inter-process lock, so concurrent PostToolUse hooks could lose entries.
const { casMerge } = require('./lib-state');

// Skills are already keyed BY NAME (one entry per skill, with a count), so
// unlike the agents file there is no instance/name mismatch to fix here — every
// entry is a distinct name and the cap can only ever drop whole names.
// Raised 20 -> 40 to match the agents budget and push that cliff further out;
// the display only shows the top 5, so this is purely retention headroom.
const SKILL_BUDGET = 40;

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    // Skills have no Start/Stop hook events — the only attach point is
    // PostToolUse on the Skill tool, which fires AFTER the skill runs.
    // So this records "used" only; there is no running state to show.
    if (i.hook_event_name !== 'PostToolUse') return;
    const toolName = i.tool_name || '';
    if (toolName !== 'Skill') return;

    // Skill tool's required input field is `skill` (e.g. "git-commit",
    // "red-blue-review:red-blue-review"). Strip any plugin: prefix for display.
    const raw = i.tool_input?.skill;
    if (!raw || typeof raw !== 'string') return;
    const name = raw.includes(':') ? raw.split(':').pop() : raw;

    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = path.join(os.tmpdir(), `claude-skills-${sid}.json`);
    const myStamp = Date.now();

    casMerge(file,
      (state) => {
        const prev = state[name] || { count: 0, last: 0 };
        state[name] = { count: prev.count + 1, last: myStamp };
        // Prune: keep the most-recently-used skills, newest first.
        const entries = Object.entries(state)
          .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
          .slice(0, SKILL_BUDGET);
        for (const k of Object.keys(state)) delete state[k];
        for (const [k, v] of entries) state[k] = v;
      },
      (after) => after[name]?.last === myStamp
    );
  } catch (e) {}
});
