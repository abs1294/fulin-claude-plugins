#!/usr/bin/env node
// What a conversation has used keeps counting without a status line: the Stop / SubagentStop / UserPromptSubmit hooks
// bring state/claude-toksum2-<sid>.json up to date (scripts/session-usage.js), in a made-up home folder.
// Run: node hooks/tests/session-usage.test.js -> one line a check, exit 1 when one fails.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
const check = (ok, what, got) => { if (ok) pass++; else { fail++; console.log('FAIL | ' + what + ' | ' + JSON.stringify(got)); } };
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-su-')), sid = 'abcdabcd-1111-2222-3333-444455556666', key = 'abcdabcd1111222233334444';
const env = Object.assign({}, process.env, { USERPROFILE: H, HOME: H, CC_STATUSLINE_SETTLE_MS: '50', CC_STATUSLINE_NO_ALL: '1', CC_STATUSLINE_ASKING: '1' });
const dir = path.join(H, '.claude', 'projects', 'p'), tp = path.join(dir, sid + '.jsonl'), sub = path.join(dir, sid, 'subagents'), state = path.join(H, '.claude', 'cc-statusline', 'state', 'claude-toksum2-' + key + '.json');
fs.mkdirSync(sub, { recursive: true });
const turn = (id, model, n) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-24T00:00:00Z', message: { id, model, content: [{ type: 'text', text: '回覆文字' }], usage: { input_tokens: n, output_tokens: 0 } } }) + '\n';
const hook = (f, o) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', f)], { env, input: JSON.stringify(Object.assign({ session_id: sid, transcript_path: tp, cwd: H }, o)), encoding: 'utf8' });
const read = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')); } catch (e) { return null; } };
const wait = (ok) => { const end = Date.now() + 15000; let j; do { j = read(); if (j && ok(j)) return j; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']); } while (Date.now() < end); return j; };
try {
  fs.writeFileSync(tp, turn('a', 'claude-opus-5-5', 1e6) + turn('a', 'claude-opus-5-5', 1e6));        // opus 4 per million in; the same message twice
  fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), turn('s', 'claude-haiku-4-5', 1e6));             // haiku 1
  const t0 = Date.now(), r = hook('message-tracker.js', { hook_event_name: 'Stop' }), took = Date.now() - t0;
  check(r.status === 0 && took < 3000, 'the Stop hook does not wait for it', [r.status, took, r.stderr]);
  let j = wait((x) => x.total && x.total.tok === 2e6);
  check(j && j.v === 1 && Math.abs(j.at - Date.now()) < 60000, 'v and at', j && [j.v, j.at]);
  check(j && j.context && j.context.tokens === 1e6 && j.context.model === 'claude-opus-5-5' && j.context.at === Date.parse('2026-11-24T00:00:00Z'), 'how much of the window is in use', j && j.context);
  check(j && JSON.stringify(j.total) === JSON.stringify({ cost: 5, tok: 2000000, mainCost: 4, mainTok: 1000000, agentCost: 1, agentTok: 1000000, agentRuns: 1, unpricedTok: 0, approxTok: 0 }), 'the figures, subagents apart, each message once', j && j.total);
  fs.appendFileSync(tp, turn('b', 'claude-haiku-4-5', 1e6));
  hook('message-tracker.js', { hook_event_name: 'UserPromptSubmit', prompt: '再來一次' });
  j = wait((x) => x.total && x.total.cost === 6); check(j && j.total.cost === 6, 'a message: what was added since, once', j && j.total);
  fs.writeFileSync(path.join(sub, 'agent-y.jsonl'), turn('t', 'claude-haiku-4-5', 2e6));
  hook('subagent-tracker.js', { hook_event_name: 'SubagentStop', agent_id: 'y', agent_type: 'qa' });
  j = wait((x) => x.total && x.total.agentRuns === 2); check(j && j.total.agentCost === 3 && j.total.cost === 8, 'a subagent that ended', j && j.total);
  { const end = Date.now() + 15000, f = path.join(H, '.claude', 'usage-data', 'records', '2026-11', 'p.jsonl'); let n = 0; do { try { n = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch (e) {} if (n < 4) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']); } while (n < 4 && Date.now() < end); check(n === 4, 'the hooks keep the usage records too', n); }
  // the status line reads the same file and adds nothing twice
  const s = spawnSync(process.execPath, [path.join(ROOT, 'statusline.js')], { env, input: JSON.stringify({ session_id: sid, transcript_path: tp, cwd: H, model: { display_name: 'x' }, cost: { total_cost_usd: 999 } }), encoding: 'utf8' });
  j = read(); check(s.status === 0 && j.total.cost === 8 && /8\.00/.test(s.stdout.replace(/\x1b\[[0-9;]*m/g, '')), 'the status line shows the same figure', [s.status, j.total, s.stderr.slice(0, 200)]);
  // a workflow's subagents, deeper; a copy of a conversation: what it carried over is the original's
  fs.mkdirSync(path.join(sub, 'workflows', 'wf_1'), { recursive: true }); fs.writeFileSync(path.join(sub, 'workflows', 'wf_1', 'agent-w.jsonl'), turn('w', 'claude-haiku-4-5', 1e6));
  fs.appendFileSync(tp, turn('copied', 'claude-opus-5-5', 1e6).replace('{"type"', '{"sessionId":"' + sid + '","requestSessionId":"99999999-0000-0000-0000-000000000000","type"'));
  fs.appendFileSync(tp, turn('own', 'claude-haiku-4-5', 1e6).replace('{"type"', '{"requestSessionId":"' + sid + '","type"'));
  hook('message-tracker.js', { hook_event_name: 'Stop' });
  j = wait((x) => x.total && x.total.agentRuns === 3); check(j && j.total.agentCost === 4 && j.total.cost === 10, 'a workflow subagent counted, a copied turn not', j && j.total);
  // the transcript cannot be opened just then: what is kept stays, with its time
  {
    const was = read(), L = JSON.stringify(path.join(ROOT, 'scripts', 'lib-session-usage.js')), PL = JSON.stringify(path.join(ROOT, 'scripts', 'lib-price.js'));
    spawnSync(process.execPath, ['-e', 'const fs=require("fs"),o=fs.openSync;fs.openSync=function(f,...a){if(/abcdabcd-1111[^\\\\/]*\\.jsonl$/.test(String(f)))throw Object.assign(new Error("x"),{code:"EBUSY"});return o.call(fs,f,...a);};const p=require(' + PL + '),t=p.loadTable();require(' + L + ').update({transcript:' + JSON.stringify(tp) + ',file:' + JSON.stringify(state) + ',resolvePrice:p.makeResolver(t.table),priceSig:t.sig,write:fs.writeFileSync});'], { env });
    j = read(); check(j.total.cost === was.total.cost, 'a transcript that cannot be opened just then', [j.total, was.total]);
  }
  // a file written before 1.10.0 is read again from the start (it left some out)
  const old = read(); delete old.v; delete old.at; delete old.total; delete old.how; fs.writeFileSync(state, JSON.stringify(old));
  fs.appendFileSync(tp, turn('c', 'claude-haiku-4-5', 1e6));
  hook('message-tracker.js', { hook_event_name: 'Stop' });
  j = wait((x) => x.v === 1); check(j && j.v === 1 && j.total.cost === 11, 'a file of an earlier version is read again', j && j.total);
  // no transcript: nothing, and no file made up
  const other = hook('message-tracker.js', { hook_event_name: 'Stop', session_id: 'ffffffff', transcript_path: path.join(dir, 'none.jsonl') });
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},800)']);
  check(other.status === 0 && !fs.existsSync(state.replace(key, 'ffffffff')), 'no transcript: no file', other.stderr);
} finally { try { fs.rmSync(H, { recursive: true, force: true }); } catch (e) {} }
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
