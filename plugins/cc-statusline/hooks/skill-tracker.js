const fs = require('fs');
const os = require('os');
const path = require('path');

// Atomic write: temp file + rename (single atomic FS op on POSIX & Windows),
// so the statusline reader never sees a half-written file.
const atomicWrite = (f, data) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
};

// CAS merge: retry until our change is visible in a fresh re-read. Guards
// against two concurrent PostToolUse hooks overwriting each other's entry.
const casMerge = (file, mutate, verify, maxRetries = 10) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    mutate(cur);
    atomicWrite(file, JSON.stringify(cur));
    let after = {};
    try { after = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
    if (verify(after)) return;
  }
};

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
        // Prune: keep the 20 most-recently-used skills
        const entries = Object.entries(state)
          .sort((a, b) => b[1].last - a[1].last)
          .slice(0, 20);
        for (const k of Object.keys(state)) delete state[k];
        for (const [k, v] of entries) state[k] = v;
      },
      (after) => after[name]?.last === myStamp
    );
  } catch (e) {}
});
