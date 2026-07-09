#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);

    // Row visibility config (see /cc-statusline:rows). Missing file = everything on.
    const rowDefaults = { summary:1, dir:1, repo:1, model:1, cost:1, usage:1, quota:1, agents:1, skills:1, crons:1, memory_mcp:1, edited:1, history:1 };
    let rowCfg = { ...rowDefaults };
    let cfgEnabled = true;
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'cc-statusline-rows.json'), 'utf8'));
      for (const k of Object.keys(rowDefaults)) if (k in stored) rowCfg[k] = !!stored[k];
      if (stored.enabled === false) cfgEnabled = false;
    } catch (e) {}
    // Master switch off — print nothing (Claude Code shows blank status area)
    if (!cfgEnabled) { process.stdout.write(''); return; }
    const showRow = k => !!rowCfg[k];

    const R = '\x1b[0m', DIM = '\x1b[2m';
    const CYAN = '\x1b[36m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', MAGENTA = '\x1b[35m', BLUE = '\x1b[34m';

    // Atomic write: write to a per-pid temp file then rename. On both POSIX
    // (rename(2)) and Windows (MoveFileEx with REPLACE_EXISTING) this is a
    // single atomic filesystem op, so concurrent readers never see a half-
    // written file and the target is either the old content or the new.
    const atomicWrite = (f, data) => {
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
    };

    // CAS-style merge: read → mutate → atomic write → re-read → verify. If
    // another writer raced past us between our write and the verify read,
    // our change is gone and we retry with fresh state. Bounded to 5 tries
    // to stay cheap under pathological contention; each round is ≈ 1ms.
    // Returns the final state observed after verification.
    const casMerge = (file, mutate, verify, maxRetries = 10) => {
      let finalState = {};
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let cur = {};
        try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
        mutate(cur);
        atomicWrite(file, JSON.stringify(cur));
        let after = {};
        try { after = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
        finalState = after;
        if (verify(after)) return finalState;
      }
      return finalState;
    };

    // Unicode East Asian Width: returns 2 for fullwidth/wide chars, 1 otherwise.
    // Based on UAX #11 (Unicode Standard Annex) + common emoji.
    const isWide = cp =>
      (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
      (cp >= 0x231a && cp <= 0x231b) ||   // ⌚⌛
      (cp >= 0x23e9 && cp <= 0x23f3) ||   // ⏩-⏳
      (cp >= 0x23f8 && cp <= 0x23fa) ||   // ⏸-⏺
      (cp >= 0x25fd && cp <= 0x25fe) ||   // ◽◾
      (cp >= 0x2614 && cp <= 0x2615) ||   // ☔☕
      (cp >= 0x2648 && cp <= 0x2653) ||   // ♈-♓
      cp === 0x267f ||                     // ♿
      cp === 0x26a1 ||                     // ⚡
      (cp >= 0x26aa && cp <= 0x26ab) ||    // ⚪⚫
      (cp >= 0x26bd && cp <= 0x26be) ||    // ⚽⚾
      (cp >= 0x26c4 && cp <= 0x26c5) ||    // ⛄⛅
      cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea || // ⛎⛔⛪
      (cp >= 0x26f2 && cp <= 0x26f3) ||    // ⛲⛳
      cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || // ⛵⛺⛽
      cp === 0x2705 ||                     // ✅
      cp === 0x2728 ||                     // ✨
      cp === 0x274c || cp === 0x274e ||    // ❌❎
      (cp >= 0x2753 && cp <= 0x2755) ||    // ❓❔❕
      cp === 0x2757 ||                     // ❗
      (cp >= 0x2795 && cp <= 0x2797) ||    // ➕➖➗
      cp === 0x27b0 || cp === 0x27bf ||    // ➰➿
      (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals → CJK Symbols
      (cp >= 0x3041 && cp <= 0x33bf) ||   // Hiragana → CJK Compatibility
      (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
      (cp >= 0x4e00 && cp <= 0xa4cf) ||   // CJK Unified Ideographs + Yi
      (cp >= 0xa960 && cp <= 0xa97c) ||   // Hangul Jamo Extended-A
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe6b) ||   // Vertical Forms + CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth ASCII
      (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
      (cp >= 0x1f004 && cp <= 0x1f9ff) || // Emoji block (Mahjong → Supplemental Symbols)
      (cp >= 0x1fa00 && cp <= 0x1faff) || // Chess symbols + Extended-A emoji
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B-F
      (cp >= 0x30000 && cp <= 0x3fffd);   // CJK Extension G+

    const dw = s => {
      let w = 0;
      for (const ch of s.replace(/\x1b\[[0-9;]*m/g, '')) {
        w += isWide(ch.codePointAt(0)) ? 2 : 1;
      }
      return w;
    };
    const pad = (s, w) => { const n = w - dw(s); return n > 0 ? s + ' '.repeat(n) : s; };
    const fit = (s, w) => pad(trunc(s, w), w); // trunc then pad = exact width
    const trunc = (s, w) => {
      let rw = 0, result = '', inEsc = false;
      for (let j = 0; j < s.length; j++) {
        if (s[j] === '\x1b') { inEsc = true; result += s[j]; continue; }
        if (inEsc) { result += s[j]; if (/[a-zA-Z]/.test(s[j])) inEsc = false; continue; }
        const cw = isWide(s.codePointAt(j)) ? 2 : 1;
        if (rw + cw > w) break;
        rw += cw; result += s[j];
      }
      return result;
    };
    const bar = (pct, len = 10) => {
      const filled = Math.max(0, Math.min(len, Math.round(pct / 100 * len)));
      return '\u2588'.repeat(filled) + '\u2591'.repeat(len - filled);
    };
    const cc = pct => pct >= 80 ? RED : pct >= 50 ? YELLOW : GREEN;
    const fmtDur = min => {
      if (min < 60) return `${min}min`;
      if (min < 1440) { const h = Math.floor(min/60), m = min%60; return m > 0 ? `${h}hr ${m}min` : `${h}hr`; }
      const dd = Math.floor(min/1440), h = Math.floor((min%1440)/60);
      return h > 0 ? `${dd}d ${h}hr` : `${dd}d`;
    };
    const fmtTok = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
    const ago = ms => { const m = Math.round((Date.now()-ms)/60000); return m < 1 ? 'now' : m < 60 ? m+'m ago' : Math.floor(m/60)+'h ago'; };

    // ── Data ──
    const model = (i.model?.display_name || '?').replace('Claude ', '');
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);

    // Claude Code sometimes resets total_cost / duration / lines (context compact,
    // auto-recovery, etc). Instead of freezing at max (which could over-report),
    // track DELTAS: when payload >= last_baseline, add delta to total; when payload
    // resets (drops below baseline), just re-baseline without touching total.
    // This way total keeps climbing through resets but never double-counts.
    const curCost = i.cost?.total_cost_usd ?? 0;
    const curDur = i.cost?.total_duration_ms ?? 0;
    const curAdd = i.cost?.total_lines_added ?? 0;
    const curRm = i.cost?.total_lines_removed ?? 0;
    const curTok = (i.context_window?.total_input_tokens ?? 0) + (i.context_window?.total_output_tokens ?? 0);
    const cumPath = path.join(os.tmpdir(), `claude-cum-${sid}.json`);
    // Each field: { total: cumulative, base: last-observed payload value }
    let cum = { cost:{total:0,base:0}, dur:{total:0,base:0}, add:{total:0,base:0}, rm:{total:0,base:0}, tok:{total:0,base:0} };
    try {
      const stored = JSON.parse(fs.readFileSync(cumPath, 'utf8'));
      // Migrate old flat format {cost,dur,add,rm,tok} → new {total,base}
      for (const k of Object.keys(cum)) {
        if (stored[k] && typeof stored[k] === 'object') cum[k] = stored[k];
        else if (typeof stored[k] === 'number') cum[k] = { total: stored[k], base: stored[k] };
      }
    } catch (e) {}
    const step = (key, cur) => {
      const c = cum[key];
      if (cur >= c.base) { c.total += (cur - c.base); c.base = cur; }
      else { c.base = cur; } // reset detected — new baseline, don't touch total
    };
    step('cost', curCost); step('dur', curDur); step('add', curAdd); step('rm', curRm); step('tok', curTok);
    atomicWrite(cumPath, JSON.stringify(cum));
    const cost = '$' + cum.cost.total.toFixed(2);
    const dur = fmtDur(Math.round(cum.dur.total / 60000));
    const ctx = Math.round(i.context_window?.used_percentage ?? 0);
    // If a rate-limit window's reset has already passed in real time, payload's
    // used_percentage is stale (payload only refreshes on message submit). Assume
    // a new window started empty and show 0% until payload catches up.
    const _nowSec = Math.floor(Date.now() / 1000);
    const rolledOver = (rl) => rl?.resets_at && rl.resets_at <= _nowSec;

    // Cross-session rate-limit aggregation: quotas are GLOBAL across all Claude
    // Code sessions, but each session's payload only reflects its own latest
    // observation. Share snapshots via ~/.claude/rate-limit-snapshots.json so
    // every session can see the highest observed %used within the same window.
    const rlSnapFile = path.join(os.homedir(), '.claude', 'rate-limit-snapshots.json');
    const mySnap = {
      t: _nowSec,
      five_hour: i.rate_limits?.five_hour || null,
      seven_day: i.rate_limits?.seven_day || null,
    };
    const STALE_SEC = 300;
    // CAS merge: multiple sessions hit this file every 30s so last-writer-
    // wins would drop ~5% of entries under load (see commit 5b75b09). We
    // retry until our own sid entry is visible after write.
    const rlSnaps = casMerge(rlSnapFile,
      (snaps) => {
        snaps[sid] = mySnap;
        for (const k of Object.keys(snaps)) {
          if (!snaps[k]?.t || _nowSec - snaps[k].t > STALE_SEC) delete snaps[k];
        }
      },
      (after) => after[sid]?.t === mySnap.t
    );
    // Aggregate across sessions: different Claude Code sessions can hold
    // cached rate_limits from DIFFERENT 5h windows (session cached old window,
    // never sent a new message). Same-resets_at match was too strict and
    // split sessions into isolated groups that each displayed their own MAX
    // — desync. Instead:
    //   1. Collect snapshots whose resets_at is still in the future (live).
    //   2. Pick the window MOST sessions agree on (plurality by resets_at),
    //      so a lone idle session with a divergent resets_at can't hijack it.
    //   3. Return MAX used_percentage in that winning window.
    //   4. If no live snapshots and my own payload is fresh → use payload.
    //   5. Otherwise 0 (everyone rolled over, nothing to show).
    // Sanity cap: 5h window resets within 5h, 7d within 7d. Anything >8d in
    // the future is garbage (malformed payload or bad test data) and would
    // otherwise win the "latest resets_at" tiebreak and poison the display.
    const MAX_FUTURE_SEC = 8 * 86400;
    const aggMax = (field) => {
      const myRL = i.rate_limits?.[field];
      const liveSnaps = [];
      for (const snap of Object.values(rlSnaps)) {
        const s = snap?.[field];
        if (s && typeof s.used_percentage === 'number'
            && s.resets_at > _nowSec
            && s.resets_at - _nowSec <= MAX_FUTURE_SEC) {
          liveSnaps.push(s);
        }
      }
      if (liveSnaps.length === 0) {
        return (myRL?.resets_at > _nowSec && typeof myRL.used_percentage === 'number')
          ? myRL.used_percentage : 0;
      }
      // Pick the window the MOST sessions agree on (plurality by resets_at).
      // Taking the latest resets_at let a single idle session holding a stale/
      // divergent resets_at hijack the display (e.g. one session showed a 7d
      // window 2.5d later than 7 active sessions and pinned the bar at its old
      // 16%). Count votes per window; ties broken by later resets_at.
      const votes = new Map();
      for (const s of liveSnaps) votes.set(s.resets_at, (votes.get(s.resets_at) || 0) + 1);
      let bestR = 0, bestVotes = 0;
      for (const [r, v] of votes) {
        if (v > bestVotes || (v === bestVotes && r > bestR)) { bestVotes = v; bestR = r; }
      }
      let max = 0;
      for (const s of liveSnaps) {
        if (s.resets_at === bestR && s.used_percentage > max) max = s.used_percentage;
      }
      return max;
    };
    const r5h = Math.round(aggMax('five_hour'));
    const r7d = Math.round(aggMax('seven_day'));
    const added = cum.add.total;
    const removed = cum.rm.total;
    const tokTotal = cum.tok.total;
    const sessionName = i.session_name || '';

    let branch = '', dirty = 0, repoName = '';
    try {
      branch = (spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
      dirty = (spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim().split('\n').filter(Boolean).length;
      const remoteUrl = (spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
      const m = remoteUrl.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (m) repoName = `${m[1]}/${m[2]}`;
      else { const tl = (spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim(); if (tl) repoName = path.basename(tl); }
    } catch (e) {}
    const shortDir = (i.cwd || i.workspace?.current_dir || '').split(/[/\\]/).slice(-2).join('/');

    // Compute seconds remaining for a rolling-window reset. If resets_at has
    // already passed (payload stale), roll into the next window of period_sec.
    const countdownSec = (resetAt, period_sec) => {
      if (!resetAt) return null;
      const nowSec = Math.floor(Date.now() / 1000);
      if (resetAt > nowSec) return resetAt - nowSec;
      return period_sec - ((nowSec - resetAt) % period_sec);
    };
    // d/h/m countdown with leading zeros dropped, always down to the minute.
    // Hour-only precision made the last <1h of a window read a bare "0d0h"
    // (looks frozen). Now: "23m", "1h5m", "2d12h30m".
    const fmtCountdown = (s) => {
      const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
      if (dd) return `${dd}d${hh}h${mm}m`;
      if (hh) return `${hh}h${mm}m`;
      return `${mm}m`;
    };
    let resetInfo = '';
    {
      const s = countdownSec(i.rate_limits?.five_hour?.resets_at, 5 * 3600);
      if (s != null) resetInfo = `${DIM}resets${R} ${fmtCountdown(s)}`;
    }
    let reset7dInfo = '';
    {
      const s = countdownSec(i.rate_limits?.seven_day?.resets_at, 7 * 86400);
      if (s != null) reset7dInfo = `${DIM}resets${R} ${fmtCountdown(s)}`;
    }

    let effort = '';
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
      const lvl = settings.effortLevel || 'default';
      const ORANGE = '\x1b[38;5;208m';
      const effortColor = {
        low: DIM,
        default: GREEN,
        medium: GREEN,
        high: YELLOW,
        xhigh: ORANGE,
        max: RED,
      }[lvl] || GREEN;
      effort = `${DIM}effort${R} ${effortColor}${lvl}${R}`;
    } catch (e) {}

    let agentItems = [];
    try {
      const agents = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-agents-${sid}.json`), 'utf8'));
      // Group by agent name — supports concurrent invocations (e.g. 3 critics in parallel)
      const byName = {};
      for (const [key, info] of Object.entries(agents)) {
        // Migration: old format was keyed by name (no info.name), new format is keyed by agent_id
        const n = info.name || key;
        if (!byName[n]) byName[n] = { running: 0, done: 0, latestFinished: 0 };
        if (info.status === 'running') byName[n].running++;
        else { byName[n].done++; if ((info.finished || 0) > byName[n].latestFinished) byName[n].latestFinished = info.finished; }
      }
      // Build entries: running first, then latest-done, up to 5 most-recent.
      const nameEntries = Object.entries(byName).sort((a, b) => {
        if (a[1].running !== b[1].running) return b[1].running - a[1].running;
        return b[1].latestFinished - a[1].latestFinished;
      }).slice(0, 5);
      // One entry per agent (each becomes its own third-column row); names can be
      // wider now that they're no longer packed onto a single shared line.
      agentItems = nameEntries.map(([n, s]) => {
        const short = n.length > 20 ? n.slice(0, 20) : n;
        const parts = [];
        if (s.running > 0) parts.push(`${YELLOW}\u25cb${s.running > 1 ? `\u00d7${s.running}` : ''}${R}`);
        if (s.done > 0) parts.push(`${GREEN}\u2713${s.done > 1 ? `\u00d7${s.done}` : ''}${R}${s.latestFinished ? ` ${DIM}${ago(s.latestFinished)}${R}` : ''}`);
        return `${short} ${parts.join(' ')}`;
      });
    } catch (e) {}

    // Skills used this session — written by skill-tracker.js on PostToolUse(Skill).
    // No running state (PostToolUse fires after the skill runs), so we only show
    // "used": name + xN count + how long ago, most-recent first, up to 4 names.
    let skillItems = [];
    try {
      const skills = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-skills-${sid}.json`), 'utf8'));
      const entries = Object.entries(skills)
        .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
        .slice(0, 5);
      // One entry per skill (each becomes its own third-column row).
      skillItems = entries.map(([n, s]) => {
        const short = n.length > 20 ? n.slice(0, 20) : n;
        const cnt = (s.count > 1) ? `${DIM}×${s.count}${R}` : '';
        const when = s.last ? ` ${DIM}${ago(s.last)}${R}` : '';
        return `${GREEN}${short}${R}${cnt}${when}`;
      });
    } catch (e) {}

    // Scheduled jobs — written by cron-tracker.js on PostToolUse(CronCreate|CronDelete|ScheduleWakeup).
    // One-shot jobs whose fire time passed (>90s grace) are treated as fired and hidden
    // (the hook can't observe the actual fire event; recurring jobs show until CronDelete).
    // Rendered as the FIXED bottom-two rows of the third (agents/skills) column.
    let cronRows = [];
    try {
      let jobs = {};
      try { jobs = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-crons-${sid}.json`), 'utf8')); } catch (e) {}
      const active = Object.values(jobs).filter((j) => j && (j.at == null ? j.recurring : j.at > Date.now() - 90000));
      const timed = active.filter((j) => j.at != null).sort((a, b) => a.at - b.at);
      const recurringN = active.length - timed.length;
      const head = `${DIM}crons${R}${active.length > 1 ? ` ${DIM}×${active.length}${R}` : ''}`;
      let body;
      if (timed.length) {
        const nx = new Date(timed[0].at);
        const hhmm = `${String(nx.getHours()).padStart(2, '0')}:${String(nx.getMinutes()).padStart(2, '0')}`;
        body = `  ⏰ ${YELLOW}${hhmm}${R}${timed[0].label ? ` ${DIM}${timed[0].label}${R}` : ''}`;
      } else if (recurringN > 0) {
        body = `  ⏰ ${DIM}循環×${recurringN}${R}`;
      } else {
        body = `  ${DIM}—${R}`;
      }
      cronRows = [head, body];
    } catch (e) { cronRows = [`${DIM}crons${R}`, `  ${DIM}—${R}`]; }

    let compactCount = 0;
    try { compactCount = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-compacts-${sid}.json`), 'utf8')).count; } catch (e) {}

    let fileParts = [];
    try { fileParts = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-files-${sid}.json`), 'utf8')); } catch (e) {}

    let msgHistory = [];
    try {
      msgHistory = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `claude-msgs-${sid}.json`), 'utf8'));
    } catch (e) {}

    // Memory: check which CLAUDE.md / rules are loaded
    const memParts = [];
    const cwd = i.cwd || i.workspace?.current_dir || '';
    if (fs.existsSync(path.join(os.homedir(), '.claude', 'CLAUDE.md'))) memParts.push(`${GREEN}global${R}`);
    const projMd = [path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')];
    if (projMd.some(p => { try { return fs.existsSync(p); } catch(e) { return false; } })) memParts.push(`${GREEN}project${R}`);
    try {
      const rulesDir = path.join(cwd, '.claude', 'rules');
      if (fs.existsSync(rulesDir)) {
        const ruleCount = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).length;
        if (ruleCount > 0) memParts.push(`${GREEN}${ruleCount} rules${R}`);
      }
    } catch(e) {}

    // MCP: read mcp-status-cache.json (populated by mcp-status-refresh.js → `claude mcp list`)
    let mcpParts = [], mcpTotal = 0, mcpHealthy = 0;
    try {
      const mcpCache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'mcp-status-cache.json'), 'utf8'));
      const servers = mcpCache.servers || {};
      for (const [name, info] of Object.entries(servers)) {
        mcpTotal++;
        if (info.status === 'connected') {
          mcpHealthy++;
        } else {
          const shortName = name.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, '');
          // Match /mcp UI icons: ✔ connected, ✘ failed, △ needs auth
          const icon = info.status === 'auth' ? `\u25b3` : `\u2718`;
          const color = info.status === 'auth' ? YELLOW : RED;
          mcpParts.push(`${color}${shortName} ${icon}${R}`);
        }
      }
    } catch(e) {}
    // Fire background refresh so next render has fresh data (the refresher self-skips if cache fresh).
    // Pass cwd so `claude mcp list` consistently sees the same MCP set as the running session.
    try {
      const { spawn } = require('child_process');
      const refresher = path.join(os.homedir(), '.claude', 'hooks', 'mcp-status-refresh.js');
      if (fs.existsSync(refresher)) {
        // Don't pass cwd — let refresher default to home dir for a stable global view.
        // Passing the session cwd caused the list to flicker based on project-scoped .mcp.json
        // (e.g. phantom 'discord'/'line' entries appearing when spawned from plugin folders).
        const p = spawn(process.execPath, [refresher], { detached: true, stdio: 'ignore', windowsHide: true });
        p.unref();
      }
    } catch(e) {}

    // ── Build left-side content ──
    const gitParts = [];
    if (repoName) gitParts.push(`${CYAN}${repoName}${R}`);
    if (branch) gitParts.push(`${MAGENTA}${branch}${R}${dirty ? ` ${DIM}(${dirty} changed)${R}` : ''}`);
    const gitInfo = gitParts.join(' ');

    // Aggregate total cost + tokens across ALL sessions by walking every claude-cum-*.json
    let allCost = 0, allTok = 0;
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith('claude-cum-') && f.endsWith('.json')) {
          try {
            const c = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), f), 'utf8'));
            allCost += c.cost?.total || 0;
            allTok += c.tok?.total || 0;
          } catch (e) {}
        }
      }
    } catch (e) {}
    const allCostStr = '$' + allCost.toFixed(2);

    // Split rows: [leftCol, rightCol] — each cell gated by /cc-statusline:rows config.
    // Empty cells collapse: if a whole column (left OR right across both rows) is empty,
    // the remaining cells merge into full-width rows (no empty grid cells).
    const linesInfo = `${GREEN}+${added}${R} ${RED}-${removed}${R} ${DIM}lines${R}`;
    let splitRow1L = showRow('dir')   ? `\u{1f4c1} ${shortDir}  ${linesInfo}` : '';
    let splitRow1R = showRow('model') ? `${CYAN}${model}${R}  ${effort}` : '';
    let splitRow2L = showRow('repo')  ? (gitInfo || '') : '';
    let splitRow2R = showRow('cost')  ? `${DIM}cost${R} ${cost} ${DIM}(all${R} ${allCostStr}${DIM})${R} \u00b7 ${dur}` : '';

    // Collapsed "top rows" — full-width rows rendered BEFORE the split block (if any).
    // Used when a whole column is empty (one side totally unused → no point in 2-cell layout).
    const preSplitRows = [];
    const leftEmpty = !splitRow1L && !splitRow2L;
    const rightEmpty = !splitRow1R && !splitRow2R;
    if (leftEmpty && (splitRow1R || splitRow2R)) {
      if (splitRow1R) preSplitRows.push(splitRow1R);
      if (splitRow2R) preSplitRows.push(splitRow2R);
      splitRow1L = splitRow1R = splitRow2L = splitRow2R = '';
    } else if (rightEmpty && (splitRow1L || splitRow2L)) {
      if (splitRow1L) preSplitRows.push(splitRow1L);
      if (splitRow2L) preSplitRows.push(splitRow2L);
      splitRow1L = splitRow1R = splitRow2L = splitRow2R = '';
    }
    // Whole-empty row skip: if both cells of a row are empty, don't emit that row at all
    const hasRow1 = !!(splitRow1L || splitRow1R);
    const hasRow2 = !!(splitRow2L || splitRow2R);
    const hasSplitBlock = hasRow1 || hasRow2;

    // Full-width left rows — each row gated by /cc-statusline:rows config
    const compactLabel = `${compactCount} time${compactCount === 1 ? '' : 's'}`;
    const ctxLine = `${DIM}tokens${R} ${fmtTok(tokTotal)} ${DIM}(all${R} ${fmtTok(allTok)}${DIM})${R}  ${DIM}context${R} ${cc(ctx)}${bar(ctx)} ${ctx}%${R}  ${DIM}compact${R} ${compactLabel}`;
    // 5h and 7d quota side by side. The verbose "resets" word before each
    // countdown is replaced with a compact "│" separator to keep width down.
    const reset5hCompact = resetInfo.replace(`${DIM}resets${R} `, `${DIM}│${R} `);
    const reset7dCompact = reset7dInfo.replace(`${DIM}resets${R} `, `${DIM}│${R} `);
    const quotaLine = `${DIM}5h-quota${R} ${cc(r5h)}${bar(r5h)} ${r5h}%${R} ${reset5hCompact}     ${DIM}7d-quota${R} ${cc(r7d)}${bar(r7d)} ${r7d}%${R} ${reset7dCompact}`;
    const fullLeftRows = [];
    if (showRow('usage')) fullLeftRows.push(ctxLine);
    if (showRow('quota')) fullLeftRows.push(quotaLine);
    // agents / skills moved to the third (far-right) column — see r3rows below.
    const memStr = memParts.length ? `${DIM}memory${R} ${memParts.join(`${DIM} \u00b7 ${R}`)}` : '';
    let mcpStr = '';
    if (mcpTotal > 0) {
      // Counts only — individual server names (mcpParts: failed/auth-needed) were
      // dropped to keep the left panel narrow.
      const mcpLine = mcpParts.length
        ? `${GREEN}${mcpHealthy}${R}/${mcpTotal} active`
        : `${GREEN}${mcpTotal}${R} active`;
      mcpStr = `${DIM}mcp${R} ${mcpLine}`;
    }
    // Track column offset of │ within content area (for border connectors ┬/┴)
    let memMcpRowIdx = -1, memMcpCol = -1;
    if (showRow('memory_mcp') && (memStr || mcpStr)) {
      if (memStr && mcpStr) {
        memMcpCol = dw(memStr) + 1; // offset inside padded content area (after "memStr ")
      }
      memMcpRowIdx = fullLeftRows.length;
      const combined = [memStr, mcpStr].filter(Boolean).join(` ${DIM}\u2502${R} `);
      fullLeftRows.push(combined);
    }
    const sep = ` ${DIM}\u2192${R} `;
    if (showRow('edited') && fileParts.length) {
      // Per-filename cap: keep last chars so extension stays visible; truncate front with …
      const shortFile = f => f.length > 25 ? '\u2026' + f.slice(-24) : f;
      let fitted = [], usedW = 8; // "edited  " label width
      for (const f of fileParts) {
        const sf = shortFile(f);
        const fw = sf.length + (fitted.length ? 3 : 0);
        if (usedW + fw > 70) break; // tighter row width so LEFT_W stays lean
        fitted.push(sf); usedW += fw;
      }
      if (fitted.length) fullLeftRows.push(`${DIM}edited${R}  ${fitted.join(sep)}`);
    }

    // Session summary — Claude-written file > session_name > first msg > sid
    // Gated by /cc-statusline:rows — empty summary = summary block skipped entirely later
    let summary = '';
    if (showRow('summary')) {
      try {
        const sf = path.join(os.tmpdir(), `claude-summary-${sid}.txt`);
        summary = fs.readFileSync(sf, 'utf8').trim().split('\n')[0].slice(0, 500);
      } catch (e) {}
      if (!summary) summary = sessionName || '';
      if (!summary && msgHistory.length) {
        const firstUser = msgHistory.find(m => m.r === 'u');
        if (firstUser) summary = firstUser.t.replace(/\n/g, ' ').trim().slice(0, 60);
      }
      if (!summary) summary = `session ${sid.slice(0, 8)}`;
    }
    const hasSummary = !!summary;

    // ── Measure widths ──
    let maxLL = Math.max(dw(splitRow1L), dw(splitRow2L));
    let maxLR = Math.max(dw(splitRow1R), dw(splitRow2R));
    const LLW = maxLL + 2;
    const LRW = maxLR + 2;
    const LEFT_INNER = LLW + 1 + LRW;

    let maxFull = 0;
    for (const f of fullLeftRows) maxFull = Math.max(maxFull, dw(f) + 2);
    let LEFT_W = Math.max(LEFT_INNER, maxFull);
    // Total box = terminal width exactly. No wider, no narrower.
    // Detection order matters. Claude Code pipes stdout/stderr (so .columns is
    // undefined) but DOES export COLUMNS with the real TUI width — verified by
    // probe: COLUMNS=179 on a window where PowerShell WindowSize.Width returned
    // a bogus fixed 120 (it reads the console BUFFER width, not the live window).
    // So: TTY columns first (correct when a TTY exists), then COLUMNS (Claude
    // Code's authoritative value), then /dev/tty, and PowerShell LAST as a weak
    // win32 guess — previously PowerShell ran 2nd and its 120 shadowed COLUMNS,
    // which is exactly why the third column never appeared.
    let TERM_W = process.stdout.columns || process.stderr.columns || 0;
    if (!TERM_W) { try { TERM_W = parseInt(process.env.COLUMNS, 10) || 0; } catch(e) {} }
    if (!TERM_W) {
      try {
        const tty = require('tty');
        const fd = fs.openSync('/dev/tty', 'r');
        const stream = new tty.ReadStream(fd);
        TERM_W = stream.columns || 0;
        stream.destroy();
      } catch(e) {}
    }
    if (!TERM_W && process.platform === 'win32') {
      try {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-c', '$Host.UI.RawUI.WindowSize.Width'], { encoding: 'utf8', timeout: 2000 });
        TERM_W = parseInt((r.stdout || '').trim(), 10) || 0;
      } catch(e) {}
    }
    // Fallback width — 120 is conservative; bump to 160 so wider terminals
    // (common 160/180/210 cols) get more room for the message history column.
    if (!TERM_W) TERM_W = 160;
    // Don't subtract padding — let the box fill full terminal width.
    // Claude Code's padding shifts our output right, but the box itself should be terminal-wide.

    // Third column (agents + skills) — moved out of the left panel to the far
    // right of the message-history column. Each array entry is one rendered row:
    // a dim "agents"/"skills" HEADER row followed by one indented row per item,
    // so each agent/skill gets its own line directly beneath its header.
    const r3rows = [];
    if (showRow('agents') && agentItems.length) {
      r3rows.push(`${DIM}agents${R}`);
      for (const it of agentItems) r3rows.push(`  ${it}`);
    }
    if (showRow('skills') && skillItems.length) {
      r3rows.push(`${DIM}skills${R}`);
      for (const it of skillItems) r3rows.push(`  ${it}`);
    }
    // crons block: FIXED bottom-two rows of this column（使用者指定：固定吃掉欄底兩 row）。
    // r3fixed 不進 r3rows（那是由上往下填的流動內容）；渲染採 token 兩段式——先排版、
    // 最後才知道欄高，再把「最後 |r3fixed| 個 cell」換成 cron 內容（見 r3cell 與收尾替換）。
    const r3fixed = showRow('crons') ? cronRows : [];
    const hasR3 = r3rows.length > 0 || r3fixed.length > 0;
    // Third column target width ~32 (user-chosen), but it must not starve the
    // message column. Space available to the right of the left panel:
    // Thresholds lowered (was 18/20) so narrower terminals can still surface the
    // third column instead of dumping agents/skills back into the left panel.
    // MSG_MIN_FOR_R3 must stay >= the showMsgs cutoff (MSG_W >= 15); otherwise
    // R3 reserves only 14 for messages, showMsgs goes false, and the whole third
    // column is rejected — an off-by-one that hid R3 at TERM_W~130 (LEFT_W~89).
    // R3_TARGET is CONTENT-DRIVEN: the third column should only be as wide as
    // its widest row (capped at 32), not a fixed 32 that steals space from the
    // message column when agents/skills are short. +2 for the cell's " … " pad.
    const R3_CAP = 32, R3_MIN = 14, MSG_MIN_FOR_R3 = 15;
    let r3ContentW = 0;
    for (const r of r3rows) r3ContentW = Math.max(r3ContentW, dw(r) + 2);
    for (const r of r3fixed) r3ContentW = Math.max(r3ContentW, dw(r) + 2);
    const R3_TARGET = Math.min(R3_CAP, r3ContentW);
    const rightAvail = Math.max(0, TERM_W - LEFT_W - 3); // -3 = "│ … │" frame around msg col
    // Pick R3_W so the message column keeps at least MSG_MIN_FOR_R3 chars.
    // If even R3_MIN can't fit alongside a usable message column, R3_W = 0
    // (the column falls back to the left panel below).
    // R3_W as a CONTINUOUS function of rightAvail (not two hard thresholds).
    // Two-step thresholds caused a non-monotonic jump (R-EDGE-01): widening the
    // terminal by 1 col could make the message column shrink ~18 cols as the
    // third column popped in. Here the third column grows smoothly from 0:
    //   - reserve MSG_MIN_FOR_R3 for messages, give the rest to R3 (capped at TARGET)
    //   - but if that leaves R3 below R3_MIN (too narrow to be useful), drop to 0
    // so MSG_W is monotonic non-decreasing in TERM_W and there's no sudden cliff.
    let R3_W = 0;
    if (hasR3) {
      // Space left for the third column after reserving MSG_MIN_FOR_R3 for the
      // message column and 1 for the divider │.
      const spaceForR3 = rightAvail - 1 - MSG_MIN_FOR_R3;
      // Give the third column exactly its content width (R3_TARGET), capped by
      // available space. It NEVER takes more than it needs — short agents/skills
      // → narrow column → the message column keeps the rest (fixes truncation).
      const cand = Math.min(R3_TARGET, spaceForR3);
      // Show it only if the space can host a useful width: the smaller of "what
      // the content needs" and R3_MIN. (Short content < R3_MIN is fine — we don't
      // reject the column just because its content happens to be narrow.)
      R3_W = (cand >= Math.min(R3_TARGET, R3_MIN)) ? cand : 0;
    }

    // Left = content-driven (never truncated). Right = remaining terminal space,
    // minus the third column (+1 for its │ divider) when present.
    // `let` because the left-panel fallback below may grow LEFT_W, after which
    // MSG_W must be recomputed or the frame overflows TERM_W (V1).
    let MSG_W = Math.max(0, rightAvail - (R3_W > 0 ? R3_W + 1 : 0));
    let showMsgs = showRow('history') && MSG_W >= 15; // hide right column if too narrow or user disabled
    // Third column rides on the message column's frame, so it only renders when
    // the message column does. If messages are hidden, agents/skills fall back
    // to the left panel (handled below by re-adding them to fullLeftRows).
    let showR3 = hasR3 && showMsgs && R3_W > 0;

    // Fallback: if the third column can't render (message column hidden), put
    // agents/skills back into the left panel so they're never lost.
    // NOTE: re-adding here is AFTER LEFT_W was finalized (line ~522), so a
    // re-added row wider than the existing left panel would overflow the frame
    // (V1). Guard: only re-add, then clamp LEFT_W-dependent draw width to the
    // actual content. agents/skills lines are short (names capped at 12/14),
    // and this path only triggers on very narrow terminals; we additionally
    // recompute LEFT_W below to absorb any width growth.
    if (hasR3 && !showR3) {
      for (const r of [...r3rows, ...r3fixed]) {
        fullLeftRows.push(r);
        LEFT_W = Math.max(LEFT_W, dw(r) + 2); // V1 guard: keep frame aligned
      }
      // LEFT_W may have grown → message column must give back that space, else
      // LEFT_W + MSG_W frame exceeds TERM_W and the border misaligns (V1 repro).
      MSG_W = Math.max(0, TERM_W - LEFT_W - 3);
      // If the recomputed message column is now too narrow, hide it entirely
      // (LEFT_W-only single column) rather than render a cramped/garbled column.
      showMsgs = showRow('history') && MSG_W >= 15;
    }
    // Right cell width of the split block — depends on the (possibly grown) LEFT_W,
    // so compute it AFTER the fallback may have widened LEFT_W. (Restored: this
    // const was accidentally dropped while changing showR3 to let.)
    const LRW_RECALC = LEFT_W - LLW - 1;

    // Summary wrap (character-level, matching actual render width = LEFT_W - 18)
    // "session summary " label is 16 chars; subsequent rows indent 16 spaces.
    // Content area on each row is LEFT_W - 2 (inside │ │) minus 16 label/indent.
    const MAX_SUM_LINES = 2;
    const maxSumW_calc = LEFT_W - 18;
    const sumLines = [];
    if (hasSummary) { let curLine = '', curW = 0, truncated = false;
      const chars = [...summary];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
        if (curW + cw > maxSumW_calc && curLine) {
          if (sumLines.length + 1 >= MAX_SUM_LINES) {
            const rest = chars.slice(i).join('');
            if (rest.length > 0) {
              while (curW + 1 > maxSumW_calc && curLine) {
                const last = curLine[curLine.length - 1];
                curW -= isWide(last.codePointAt(0)) ? 2 : 1;
                curLine = curLine.slice(0, -1);
              }
              sumLines.push(curLine + '\u2026');
              truncated = true;
              break;
            }
          }
          sumLines.push(curLine);
          curLine = ch; curW = cw;
        } else {
          curLine += ch; curW += cw;
        }
      }
      if (!truncated && curLine && sumLines.length < MAX_SUM_LINES) sumLines.push(curLine);
      if (!sumLines.length) sumLines.push('');
    }

    // Count total rows for right-column slot allocation.
    // Split-open divider can be absorbed by the top border when split is the first section;
    // bottom border can absorb the split-close when split is the last section.
    const topMergeSplitSlot = hasSplitBlock && !hasSummary && preSplitRows.length === 0; // same condition as topMergeSplit
    const splitContentRows = (hasRow1 ? 1 : 0) + (hasRow2 ? 1 : 0);
    const splitOpenDivider = (hasSplitBlock && !topMergeSplitSlot) ? 1 : 0;
    const splitCloseDivider = (hasSplitBlock && fullLeftRows.length > 0) ? 1 : 0;
    const allFullRows = preSplitRows.length + fullLeftRows.length;
    const fullDividers = Math.max(0, preSplitRows.length - 1) + (fullLeftRows.length > 1 ? fullLeftRows.length - 1 : 0);
    let sectionDividers = 0;
    // When the split block directly follows the summary (no pre-split rows), the
    // draw path emits ONE physical divider (the split-open ├─┬─┤) serving both as
    // section boundary and split opening. Counting a section divider here too
    // overcounts totalSlots by 1, so the NEWEST message slot is never rendered.
    if (hasSummary && (preSplitRows.length || hasSplitBlock || fullLeftRows.length)
        && !(hasSplitBlock && preSplitRows.length === 0)) sectionDividers++;
    if (preSplitRows.length && fullLeftRows.length && !hasSplitBlock) sectionDividers++;
    const totalSlots = sumLines.length + splitContentRows + allFullRows + splitOpenDivider + splitCloseDivider + fullDividers + sectionDividers;

    const rightMsgs = [];
    // Show the latest `totalSlots` messages (oldest-on-top within the window)
    const sliced = msgHistory.slice(-totalSlots);
    const padCount = Math.max(0, totalSlots - sliced.length);
    for (let j = 0; j < padCount; j++) rightMsgs.push('');
    for (const m of sliced) {
      const icon = m.r === 'u' ? `${BLUE}\u25b6${R}` : `${GREEN}\u25c0${R}`;
      // m.t may be missing on a malformed history entry \u2014 guard or the whole
      // statusline crashes to "statusline error: ... reading 'replace'" (MSG-3).
      const text = trunc(String(m.t ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(), MSG_W - 4);
      rightMsgs.push(`${icon} ${text}`);
    }

    // ── Draw ──
    const h = c => `${DIM}${c}${R}`;
    const hl = (n) => '\u2500'.repeat(n);
    // hl with marks: { idx: char } replaces positions within the ─ run
    const hlm = (n, marks) => {
      const arr = Array(n).fill('\u2500');
      if (marks) for (const k of Object.keys(marks)) { const i = +k; if (i >= 0 && i < n) arr[i] = marks[k]; }
      return arr.join('');
    };
    // Column offset (within hl span) where the mem/mcp │ sits.
    // Content area starts at abs col 2 (│ + space). hl spans abs cols 1..LEFT_W.
    // So hl idx = (2 + memMcpCol) - 1 = 1 + memMcpCol.
    const mcpHlIdx = memMcpCol >= 0 ? 1 + memMcpCol : -1;
    const output = [];
    let ri = 0; // right message index

    // Top border — if the FIRST section is the split block, merge the split-open into
    // the top border so there's no redundant ├─┬─┤ right after ┌─┐.
    const topMergeSplit = hasSplitBlock && !hasSummary && preSplitRows.length === 0;
    if (topMergeSplit) {
      // top border with split column divider baked in: ┌───┬───┬───┐ (or ┌───┬───┐ if no msgs)
      if (showMsgs) output.push(`${h('\u250c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LRW_RECALC))}${h('\u252c')}${h(hl(MSG_W))}${showR3 ? h('\u252c') + h(hl(R3_W)) : ''}${h('\u2510')}`);
      else          output.push(`${h('\u250c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LRW_RECALC))}${h('\u2510')}`);
    } else if (showMsgs) {
      output.push(`${h('\u250c')}${h(hl(LEFT_W))}${h('\u252c')}${h(hl(MSG_W))}${showR3 ? h('\u252c') + h(hl(R3_W)) : ''}${h('\u2510')}`);
    } else {
      output.push(`${h('\u250c')}${h(hl(LEFT_W))}${h('\u2510')}`);
    }

    // Helper: right column cell (truncated to fit) or empty if hidden
    const rcell = () => {
      if (!showMsgs) return '';
      const content = fit(rightMsgs[ri] || '', MSG_W - 2);
      ri++;
      return ` ${content} ${h('\u2502')}`;
    };
    // Helper: third-column cell (agents/skills + fixed crons bottom block)\u3002
    // \u5169\u6bb5\u5f0f\u6e32\u67d3\uff1a\u6392\u7248\u671f\u53ea\u767c token \u4f54\u4f4d\u4e26\u8a08\u6578\uff08\x00R3#n\x00\uff0c\u6b63\u5e38\u8f38\u51fa\u4e0d\u53ef\u80fd\u51fa\u73fe\u6b64
    // \u63a7\u5236\u5b57\u5143\uff09\uff0c\u5168\u90e8 host row \u6392\u5b8c\u624d\u77e5\u9053\u6b04\u9ad8 totalSlots\uff0c\u6536\u5c3e\u6642\u628a token \u63db\u6210\u5be6\u969b
    // \u5167\u5bb9\u2014\u2014\u524d\u6bb5\u7531\u4e0a\u800c\u4e0b\u586b r3rows\uff08agents/skills\uff09\uff0c\u300c\u6700\u5f8c |r3fixed| \u683c\u300d\u56fa\u5b9a\u7d66
    // crons \u5340\u584a\uff08\u4f7f\u7528\u8005\u6307\u5b9a\u6b04\u5e95\u5169 row\uff09\uff0c\u4e2d\u9593\u4e0d\u8db3\u8655\u7559\u767d\u3002
    let r3slot = 0;
    const r3cell = () => {
      if (!showR3) return '';
      return ` \x00R3#${r3slot++}\x00 ${h('\u2502')}`;
    };
    // Combined right suffix for every CONTENT/DIVIDER row: msg cell + third cell.
    const rsuffix = () => rcell() + r3cell();

    // Summary rows
    if (hasSummary) {
      for (let si = 0; si < sumLines.length; si++) {
        const label = si === 0 ? `${DIM}session summary${R} ` : ' '.repeat(16);
        output.push(`${h('\u2502')} ${label}${pad(sumLines[si], LEFT_W - 18)} ${h('\u2502')}${rsuffix()}`);
      }
    }

    // pre-split full-width rows (when an entire split column collapsed to single-cell)
    if (preSplitRows.length > 0) {
      if (hasSummary) output.push(`${h('\u251c')}${h(hl(LEFT_W))}${h('\u2524')}${rsuffix()}`);
      for (let j = 0; j < preSplitRows.length; j++) {
        if (j > 0) output.push(`${h('\u251c')}${h(hl(LEFT_W))}${h('\u2524')}${rsuffix()}`);
        output.push(`${h('\u2502')} ${pad(preSplitRows[j], LEFT_W - 2)} ${h('\u2502')}${rsuffix()}`);
      }
    }

    // Split block — skip individual rows if both cells empty
    if (hasSplitBlock) {
      // Emit split-open divider only if NOT merged with top border
      if (!topMergeSplit) {
        output.push(`${h('\u251c')}${h(hl(LLW))}${h('\u252c')}${h(hl(LRW_RECALC))}${h('\u2524')}${rsuffix()}`);
      }
      if (hasRow1) output.push(`${h('\u2502')} ${pad(splitRow1L, LLW - 2)} ${h('\u2502')} ${pad(splitRow1R, LRW_RECALC - 2)} ${h('\u2502')}${rsuffix()}`);
      if (hasRow2) output.push(`${h('\u2502')} ${pad(splitRow2L, LLW - 2)} ${h('\u2502')} ${pad(splitRow2R, LRW_RECALC - 2)} ${h('\u2502')}${rsuffix()}`);
      if (fullLeftRows.length > 0) {
        output.push(`${h('\u251c')}${h(hl(LLW))}${h('\u2534')}${h(hl(LRW_RECALC))}${h('\u2524')}${rsuffix()}`);
      }
    } else if (!preSplitRows.length && hasSummary && fullLeftRows.length > 0) {
      output.push(`${h('\u251c')}${h(hl(LEFT_W))}${h('\u2524')}${rsuffix()}`);
    } else if (preSplitRows.length > 0 && fullLeftRows.length > 0) {
      output.push(`${h('\u251c')}${h(hl(LEFT_W))}${h('\u2524')}${rsuffix()}`);
    }

    // Full-width left rows
    for (let j = 0; j < fullLeftRows.length; j++) {
      output.push(`${h('\u2502')} ${pad(fullLeftRows[j], LEFT_W - 2)} ${h('\u2502')}${rsuffix()}`);
      if (j < fullLeftRows.length - 1) {
        const marks = {};
        if (mcpHlIdx >= 0) {
          if (j + 1 === memMcpRowIdx) marks[mcpHlIdx] = '\u252c'; // ┬
          else if (j === memMcpRowIdx) marks[mcpHlIdx] = '\u2534'; // ┴
        }
        output.push(`${h('\u251c')}${h(hlm(LEFT_W, marks))}${h('\u2524')}${rsuffix()}`);
      }
    }

    // Drain any third-column rows that had no host content/divider row to ride
    // on (R-EDGE-04 / V2): emit a divider + a blank-left/blank-message row whose
    // third cell carries the leftover entry. Needed slots = 流動內容（agents/skills）
    // + 固定 crons 區塊——欄高必須容納兩者，crons 才有「欄底兩 row」可佔。
    const r3Needed = r3rows.length + r3fixed.length;
    if (showR3 && r3slot < r3Needed) {
      while (r3slot < r3Needed) {
        output.push(`${h('├')}${h(hl(LEFT_W))}${h('┤')}${rcell()}${r3cell()}`);
        output.push(`${h('│')} ${pad('', LEFT_W - 2)} ${h('│')}${rcell()}${r3cell()}`);
      }
    }

    // Bottom border
    const bottomMarks = {};
    // If mem/mcp is the last full row, extend its ┴ down to the bottom
    if (mcpHlIdx >= 0 && memMcpRowIdx === fullLeftRows.length - 1) bottomMarks[mcpHlIdx] = '\u2534';
    // If split block was the last thing emitted (no full rows after), the split divider lands on bottom
    if (hasSplitBlock && fullLeftRows.length === 0) {
      if (showMsgs) {
        output.push(`${h('\u2514')}${h(hl(LLW))}${h('\u2534')}${h(hl(LRW_RECALC))}${h('\u2534')}${h(hl(MSG_W))}${showR3 ? h('\u2534') + h(hl(R3_W)) : ''}${h('\u2518')}`);
      } else {
        output.push(`${h('\u2514')}${h(hl(LLW))}${h('\u2534')}${h(hl(LRW_RECALC))}${h('\u2518')}`);
      }
    } else {
      if (showMsgs) {
        output.push(`${h('\u2514')}${h(hlm(LEFT_W, bottomMarks))}${h('\u2534')}${h(hl(MSG_W))}${showR3 ? h('\u2534') + h(hl(R3_W)) : ''}${h('\u2518')}`);
      } else {
        output.push(`${h('\u2514')}${h(hlm(LEFT_W, bottomMarks))}${h('\u2518')}`);
      }
    }

    // 第三欄 token 收尾替換（兩段式渲染的第二段）：totalSlots = 欄實際高度。
    // slot 0..(totalSlots-|r3fixed|-1) 由上而下放 r3rows（不足留白）；
    // 最後 |r3fixed| 格固定放 crons 區塊（欄底兩 row，使用者指定）。
    if (showR3) {
      const totalSlots = r3slot;
      const fixedStart = totalSlots - r3fixed.length;
      const r3TextFor = (n) => (n >= fixedStart && r3fixed.length ? (r3fixed[n - fixedStart] || '') : (r3rows[n] || ''));
      for (let oi = 0; oi < output.length; oi++) {
        if (output[oi].indexOf('\x00R3#') !== -1) {
          output[oi] = output[oi].replace(/\x00R3#(\d+)\x00/g, (_, n) => fit(r3TextFor(+n), R3_W - 2));
        }
      }
    }

    process.stdout.write(output.join('\n'));
  } catch (e) {
    process.stdout.write('statusline error: ' + e.message);
  }
});
