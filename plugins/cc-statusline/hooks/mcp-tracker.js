const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked CAS merge (see lib-state.js) — same reason as skill-tracker: concurrent
// PostToolUse hooks would otherwise lose entries.
const { casMerge } = require('./lib-state');

// Keyed BY TOOL NAME (one entry per mcp tool, with a count), so like skills and
// unlike agents there is no instance/name mismatch — the cap only ever drops
// whole names. Matches the skills/agents budget of 40; display shows far fewer,
// so this is purely retention headroom.
const MCP_BUDGET = 40;

// Display name: strip the mcp__ prefix, then strip the noise prefixes the health
// row also strips, so both places call the same server the same thing.
//   mcp__claude_ai_Gmail__create_draft  -> Gmail__create_draft
//   mcp__claude-in-chrome__computer     -> claude-in-chrome__computer
//
// The tool name spells a server with non-word chars replaced by underscores
// ("claude.ai Gmail" -> "claude_ai_Gmail"), so matching it needs underscore
// variants of the health row's `^plugin:[^:]+:` and `^claude\.ai `. Those two
// are anchored on LITERAL separators, and widening them to a character class is
// what broke an earlier version of this: `^plugin[:_][^:_]+[:_]` treats every
// underscore as a separator, so a server genuinely NAMED `plugin_foo` had its
// own name eaten (`mcp__plugin_foo__bar` -> `_bar`), and `^claude[._]ai[._ ]`
// did the same to a server named `claude_ai` (`mcp__claude_ai__ping` ->
// `_ping`). Measured, not hypothetical.
//
// So the separator here is the DOUBLE underscore that actually delimits
// server from tool, never a single one, and a prefix is only stripped when a
// real server name survives it. `mcp__claude_ai__ping` keeps `claude_ai__ping`:
// `claude_ai` is the whole server name, not a prefix on one.
const displayName = (raw) => {
  const body = raw.replace(/^mcp__/, '');
  // Split on the first `__`: everything before it is the server, the rest the
  // tool path (which may itself contain `__` and is left untouched).
  const sep = body.indexOf('__');
  if (sep <= 0) return body;
  let server = body.slice(0, sep);
  const rest = body.slice(sep);
  // `claude_ai_<name>` / `plugin_<pluginName>_<name>` -> `<name>`, but only when
  // <name> is non-empty, so a server actually called `claude_ai` or `plugin_foo`
  // keeps its name.
  const m = /^claude_ai_(.+)$/.exec(server) || /^plugin_[^_]+_(.+)$/.exec(server);
  if (m) server = m[1];
  return server + rest;
};

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    // MCP tools have no Start/Stop hook events — the only attach point is
    // PostToolUse, which fires AFTER the call. So this records "called" only;
    // there is no running state to show.
    if (i.hook_event_name !== 'PostToolUse') return;
    const toolName = i.tool_name || '';
    if (!toolName.startsWith('mcp__')) return;

    const name = displayName(toolName);
    if (!name) return;

    // Error detection is best-effort: the exact PostToolUse payload shape for a
    // FAILED mcp call is not verified here, so probe the shapes Claude Code is
    // known to use (transcript tool_result carries is_error) and fall back to
    // "success" when nothing matches. A missed failure only under-counts the
    // red marker; it never breaks the row.
    const resp = i.tool_response;
    let failed = false;
    if (resp && typeof resp === 'object') {
      if (resp.is_error === true || resp.isError === true) failed = true;
      else if (typeof resp.status === 'string' && /^(error|failed)$/i.test(resp.status)) failed = true;
    }

    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = path.join(os.tmpdir(), `claude-mcp-${sid}.json`);
    const myStamp = Date.now();

    casMerge(file,
      (state) => {
        const prev = state[name] || { count: 0, errors: 0, last: 0 };
        state[name] = {
          count: prev.count + 1,
          errors: prev.errors + (failed ? 1 : 0),
          last: myStamp,
        };
        // Prune: keep the most-recently-used tools, newest first.
        const entries = Object.entries(state)
          .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
          .slice(0, MCP_BUDGET);
        for (const k of Object.keys(state)) delete state[k];
        for (const [k, v] of entries) state[k] = v;
      },
      (after) => after[name]?.last === myStamp
    );
  } catch (e) {}
});
