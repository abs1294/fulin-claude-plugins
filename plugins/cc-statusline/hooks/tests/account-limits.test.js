#!/usr/bin/env node
// account-limits: the account's usage limits, asked of Claude Code (2026-11-24).
// Run: node hooks/tests/account-limits.test.js
//
// Why: rate-limit-snapshots.json carries what a session was last told, stamped
// with the time of the writing: a Mac showed 3% while the account was at 34%.
// Everything runs in a home of its own with a stand-in for `claude`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..'), ASK = path.join(ROOT, 'hooks', 'account-limits.js');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-limits-'));
let pass = 0, fail = 0, n = 0;
const check = (ok, label, detail) => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(12) + label + (ok ? '' : '  -> ' + JSON.stringify(detail))); };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sec = () => Math.floor(Date.now() / 1000);

// Stands in for claude: what it was started with is written down, the answer is $FAKE_ANSWER.
const FAKE = path.join(W, 'fake-claude.js');
fs.writeFileSync(FAKE, `const fs=require('fs'),path=require('path');let d='';
process.stdin.on('data',c=>{d+=c;if(!d.includes('\\n'))return;fs.appendFileSync(path.join(process.env.HOME,'asked.txt'),JSON.stringify({args:process.argv.slice(2),said:JSON.parse(d.split('\\n')[0]),session:process.env.CLAUDE_CODE_SESSION_ID||'',token:process.env.CLAUDE_CODE_MESSAGING_TOKEN||'',guard:process.env.CC_STATUSLINE_ASKING||'',key:(process.env.ANTHROPIC_API_KEY||'')+(process.env.CLAUDE_CODE_USE_BEDROCK||'')+(process.env.ANTHROPIC_AUTH_TOKEN||''),cwd:process.cwd()})+'\\n');
const a=process.env.FAKE_ANSWER;if(a==='silent')return;console.log('{"type":"system"}');console.log('not json');console.log(a);});process.stdin.on('end',()=>{fs.writeFileSync(path.join(process.env.HOME,'ended.txt'),'1');process.exit(0);});`);
// spawn('claude' ...) in the asking goes to it, whatever is installed here
const PRE = path.join(W, 'pre.js');
fs.writeFileSync(PRE, `const cp=require('child_process'),o=cp.spawn;cp.spawn=(f,a,x)=>/claude(\\.exe|\\.cmd)?$/i.test(f)?o(process.execPath,[${JSON.stringify(FAKE)},...a],Object.assign({},x,{shell:false})):o(f,a,x);`);

const home = () => { const h = path.join(W, 'h' + (++n)); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; };
const fileOf = (h) => path.join(h, '.claude', 'cc-statusline', 'state', 'account-limits.json');
const get = (h) => { try { return JSON.parse(fs.readFileSync(fileOf(h), 'utf8')); } catch (e) { return null; } };
// (tried alone: the time not to ask before follows from it, as the asking writes it)
const put = (h, j) => { if (typeof j === 'object' && Number.isFinite(j.tried)) j = Object.assign({}, j, { next: j.tried + (Number.isFinite(j.none_at) ? 3600000 : 300000) }); fs.mkdirSync(path.dirname(fileOf(h)), { recursive: true }); fs.writeFileSync(fileOf(h), typeof j === 'string' ? j : JSON.stringify(Object.assign({ v: 1 }, j))); };
const asked = (h) => { try { return fs.readFileSync(path.join(h, 'asked.txt'), 'utf8').trim().split('\n').map((x) => JSON.parse(x)); } catch (e) { return []; } };
const envOf = (h, more) => { const e = Object.assign({}, process.env, { HOME: h, USERPROFILE: h, NODE_OPTIONS: '--require ' + JSON.stringify(PRE.replace(/\\/g, '/')), CLAUDE_CODE_SESSION_ID: 'mine', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', Anthropic_Api_Key: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1' }, more); delete e.CC_STATUSLINE_ASKING; if (more && more.CC_STATUSLINE_ASKING) e.CC_STATUSLINE_ASKING = more.CC_STATUSLINE_ASKING; return e; };
const iso = (inSec) => new Date((sec() + inSec) * 1000 - 144).toISOString();
const answer = (five, seven) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: five === null ? null : { utilization: five, resets_at: iso(3600) }, seven_day: { utilization: seven, resets_at: iso(345600) } } } } });
const run = (h, a) => spawnSync(process.execPath, [ASK, '--ask'], { env: envOf(h, { FAKE_ANSWER: a }), encoding: 'utf8', timeout: 60000 });

console.log('asking');
let h = home(), t0 = Date.now(); run(h, answer(1, 34)); let j = get(h) || {}, q = asked(h)[0] || {};
check(j.seven_day && j.seven_day.used_percentage === 34 && j.five_hour.used_percentage === 1 && j.at >= t0 && j.tried >= t0, 'the figures, and when', j);
check(j.seven_day && j.seven_day.resets_at % 60 === 0 && Math.abs(j.seven_day.resets_at - sec() - 345600) <= 61, 'its time is to the minute, in seconds', j);
check(q.said && q.said.request.subtype === 'get_usage' && q.said.type === 'control_request' && asked(h).length === 1, 'no message is sent', q);
check(q.args && q.args[q.args.indexOf('--setting-sources') + 1] === '' && q.args[q.args.indexOf('--tools') + 1] === '', 'none of the settings, no tools', q.args);
check(q.session === '' && q.token === '' && q.guard === '1', 'nothing of the conversation is handed on', q);
check(q.key === '', 'nor what makes it pay another way: the file is the whole computer\'s', q);
check(fs.existsSync(path.join(h, 'ended.txt')), 'it is let end by itself, not killed', 0);
run(h, answer(1, 35)); check(asked(h).length === 1 && get(h).seven_day.used_percentage === 34, 'asked just now: not again', asked(h).length);
put(h, Object.assign(get(h), { tried: Date.now() - 301000 })); run(h, answer(null, 35)); j = get(h);
check(asked(h).length === 2 && j.seven_day.used_percentage === 35 && j.five_hour === null, 'five minutes later: again', j);
const was = get(h); put(h, Object.assign({}, was, { tried: Date.now() - 301000 })); run(h, JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'x' } })); j = get(h);
check(j.at === was.at && j.seven_day.used_percentage === 35 && Date.now() - j.tried < 20000, 'no answer: what was there stays, with its time; not tried again at once', j);
put(h, Object.assign({}, was, { tried: Date.now() + 86400000 })); run(h, answer(null, 36)); check(get(h).seven_day.used_percentage === 36, 'a time that is not yet does not stop it for a day', get(h));
put(h, '{"at":'); run(h, answer(null, 37)); check(get(h).seven_day.used_percentage === 37, 'a file that cannot be read', get(h));
h = home(); run(h, JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false, rate_limits: null } } })); j = get(h);
check(j && j.none === true && !j.at && Math.abs(j.none_at - Date.now()) < 20000, 'an account without such limits', j);
put(h, Object.assign(j, { tried: Date.now() - 1800000 })); run(h, answer(null, 5)); check(asked(h).length === 1, '... is not asked so often', asked(h).length);
put(h, Object.assign(j, { tried: Date.now() - 7 * 3600000 })); run(h, answer(null, 5)); check(get(h).seven_day.used_percentage === 5 && !get(h).none, '... and has them when it does', get(h));
// "no limits" (nobody signed in, say) does not wipe out today's figures; older ones it does
h = home(); run(h, answer(null, 34)); const NONE = JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: false, rate_limits: null } } });
put(h, Object.assign(get(h), { tried: Date.now() - 301000 })); run(h, NONE); j = get(h); check(j.seven_day && j.seven_day.used_percentage === 34 && !j.none && Date.now() - j.tried < 20000, '"no limits" does not wipe out figures of today', j);
{ const n = asked(h).length; put(h, Object.assign(get(h), { tried: j.tried - 1800000 })); run(h, NONE); check(asked(h).length === n, '... and is not asked every 5 minutes then', asked(h).length);
  // an asking that fails keeps to that; figures again, and it is every 5 minutes again
  put(h, Object.assign(get(h), { tried: Date.now() - 3700000 })); run(h, 'silent'); const m = asked(h).length; put(h, Object.assign(get(h), { tried: Date.now() - 1800000 })); run(h, NONE); check(m === n + 1 && asked(h).length === m, '... nor after an asking that failed', [n, m, asked(h).length]);
  put(h, Object.assign(get(h), { tried: Date.now() - 3700000 })); run(h, answer(null, 34)); check(get(h).none_at === undefined && get(h).next - get(h).tried === 300000, '... until there are figures again', get(h)); }
put(h, Object.assign(get(h), { at: Date.now() - 25 * 3600000, tried: Date.now() - 301000 })); run(h, NONE); check(get(h).none === true, '... older ones it does', get(h));
h = home(); fs.mkdirSync(path.dirname(fileOf(h)), { recursive: true }); fs.writeFileSync(fileOf(h), JSON.stringify({ at: Date.now(), tried: Date.now(), seven_day: { used_percentage: 99, resets_at: sec() + 9999 } })); run(h, answer(null, 34)); check(get(h).v === 1 && get(h).seven_day.used_percentage === 34, 'a file of before v is asked afresh, not taken over', get(h));
// has the limit, no window running: not the same as not having it
h = home(); run(h, JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 34, resets_at: iso(345600) } } } } })); j = get(h);
check(j && j.v === 1 && j.five_hour && j.five_hour.used_percentage === 0 && j.five_hour.resets_at === null && j.seven_day.resets_at > 0, 'a limit with no window running is told from one the account does not have', j);
h = home(); run(h, JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: 'x' }, seven_day: { utilization: 34, resets_at: iso(345600) } } } } })); check(!get(h).at && get(h).tried > 0, 'a window that cannot be read is no answer (not an account without it)', get(h));
h = home(); run(h, JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 34, resets_at: iso(345600) } } } } })); check(get(h).five_hour && get(h).five_hour.used_percentage === 0 && get(h).five_hour.resets_at === null, 'no utilization and no time: not running', get(h));
{ const { windows, stateOf } = require(ASK), S = sec(), w7 = { utilization: 34, resets_at: iso(345600) }, five = (x) => windows({ rate_limits_available: true, rate_limits: { five_hour: x, seven_day: w7 } });
  check([{}, 'x', 5, false, [], { used: 1, reset: 2 }, { utilization: 5 }, { utilization: 'a', resets_at: null }, { utilization: null, resets_at: iso(60) }].every((x) => five(x) === null), 'a window of another shape is no answer', 0);
  check(five(null).five_hour === null && five(undefined).five_hour === null, 'none, or not mentioned: the account does not have it', 0);
  check(JSON.stringify([null, undefined, { used_percentage: 0, resets_at: null }, { used_percentage: 5, resets_at: S + 60 }, { used_percentage: 5, resets_at: S - 60 }, { used_percentage: 5, resets_at: S + 30 * 86400 }, {}, 'x', { used_percentage: 5, resets_at: 'x' }].map((x) => stateOf(x))) === JSON.stringify(['none', 'none', 'idle', 'running', 'over', '', '', '', '']), 'what a window says', 0); }
h = home(); t0 = Date.now(); run(h, 'silent'); check(Date.now() - t0 < 40000 && get(h) && !get(h).at && get(h).tried, 'it never answers: given up', Date.now() - t0);

console.log('the Stop hook');
const hook = (hm, event, more) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'message-tracker.js')], { input: JSON.stringify({ session_id: 's', hook_event_name: event, prompt: 'hello there' }), env: envOf(hm, Object.assign({ FAKE_ANSWER: answer(null, 12) }, more)), encoding: 'utf8', timeout: 20000 });
const wait = (hm) => { for (let k = 0; k < 100 && !(get(hm) && get(hm).at); k++) sleep(100); return get(hm); };
h = home(); hook(h, 'UserPromptSubmit'); sleep(800); check(asked(h).length === 0, 'a message of yours does not ask', asked(h).length);
t0 = Date.now(); let r = hook(h, 'Stop'); const took = Date.now() - t0; j = wait(h);
check(r.status === 0 && r.stdout === '' && j && j.seven_day.used_percentage === 12, 'an answer does, in the background', [r.status, j]);
for (let k = 0; k < 4; k++) hook(h, 'Stop'); sleep(800); check(asked(h).length === 1, 'answers one after the other: once', asked(h).length);
h = home(); hook(h, 'Stop', { CC_STATUSLINE_ASKING: '1' }); sleep(800); check(asked(h).length === 0, 'not from within an asking', asked(h).length);

console.log('the status line');
const line = (hm, sid, limits, layout) => { fs.writeFileSync(path.join(hm, '.claude', 'cc-statusline-rows.json'), JSON.stringify({ layout: layout || 'columns' })); const x = spawnSync(process.execPath, [path.join(ROOT, 'statusline.js')], { input: JSON.stringify({ session_id: sid, cwd: W, model: { id: 'claude-opus-5-5', display_name: 'x' }, cost: {}, rate_limits: limits }), env: Object.assign(envOf(hm, {}), { NODE_OPTIONS: '', COLUMNS: '200' }), encoding: 'utf8', timeout: 60000 }); return (x.stdout || '').replace(/\x1b\[[0-9;]*m/g, ''); };
const w = (pct, inSec) => ({ used_percentage: pct, resets_at: sec() + inSec });
const snap = (hm) => JSON.parse(fs.readFileSync(path.join(hm, '.claude', 'rate-limit-snapshots.json'), 'utf8'));
const R5 = sec() + 3600, R7 = sec() + 345600, lim = (five, seven) => ({ five_hour: five === null ? null : { used_percentage: five, resets_at: R5 }, seven_day: { used_percentage: seven, resets_at: R7 } });
h = home(); let out = line(h, 'a', lim(null, 3));
check(/7d-quota .*3%/.test(out) && !/5h-quota/.test(out), 'no answer yet: as before', out);
check(snap(h).a && snap(h).a.seen === undefined && snap(h).a.t > 0, 'a figure already there: since when is not known', snap(h));
put(h, { at: Date.now() - 60000, five_hour: w(1, 3600), seven_day: w(34, 345600), tried: Date.now() }); out = line(h, 'a', lim(null, 3));
check(/7d-quota .*34%/.test(out) && /5h-quota .*1%/.test(out), 'what was answered comes before what the session was last told', out);
check(snap(h).a.seen === undefined, 'the same again: still not known', snap(h));
put(h, { at: Date.now() - 60000, five_hour: w(1, 3600), seven_day: w(34, 345645), tried: Date.now() });   // its time some seconds off the session's
out = line(h, 'a', lim(null, 36)); check(/7d-quota .*36%/.test(out) && Math.abs(snap(h).a.seen.seven_day - sec()) <= 5 && snap(h).a.seen.five_hour === undefined, 'told more since: that counts', [out, snap(h)]);
const seen = snap(h).a.seen.seven_day; sleep(1200); line(h, 'a', lim(null, 36)); check(snap(h).a.seen.seven_day === seen && snap(h).a.t > seen, 'the same again keeps its time', snap(h));
sleep(1100); line(h, 'a', lim(50, 36)); check(snap(h).a.seen.seven_day === seen && snap(h).a.seen.five_hour > seen, 'one window that changed does not make the other new', snap(h));
put(h, { at: Date.now() + 5000, five_hour: null, seven_day: w(2, 345600), tried: Date.now() }); out = line(h, 'a', lim(50, 36));
check(/7d-quota .* 2%/.test(out) && !/5h-quota/.test(out), 'a limit set back goes down, a window that is gone is not shown', out);
put(h, { at: Date.now() - 60000, five_hour: { used_percentage: 0, resets_at: null }, seven_day: w(34, 345600), tried: Date.now() }); out = line(h, 'a', lim(null, 3));
check(/7d-quota .*34%/.test(out) && !/5h-quota/.test(out), 'no 5-hour window running: none shown', out);
{ const g = home(); line(g, 'b', lim(null, 3)); put(g, { at: Date.now() - 60000, five_hour: { used_percentage: 0, resets_at: null }, seven_day: { used_percentage: 0, resets_at: null }, tried: Date.now() }); out = line(g, 'b', lim(null, 3)); }
check(/7d-quota .* 0%/.test(out) && !/ 3%| \d+d\d+h\d+m/.test(out), 'neither window running: that is the answer, not what a session was once told - nor its countdown', out);
{ const g = home(); line(g, 'c', lim(50, 44)); put(g, { none: true, none_at: Date.now() - 60000, tried: Date.now() }); out = line(g, 'c', lim(50, 44));
  // both layouts keep every other row, with a quota row or without
  fs.writeFileSync(path.join(g, '.claude', 'CLAUDE.md'), '# x\n'); const full = fileOf(g), was = fs.readFileSync(full, 'utf8');
  for (const lay of ['columns', 'stacked']) { const no = line(g, 'c', lim(50, 44), lay); fs.rmSync(full); const yes = line(g, 'c', lim(50, 44), lay); fs.writeFileSync(full, was); check(/memory/.test(no) && /memory/.test(yes) && !/-quota/.test(no) && /-quota/.test(yes), lay + ': without a quota row no other row is lost', [no, yes]); } }
check(!/44%|50%|-quota/.test(out), 'an account without limits: no quota at all', out);
put(h, { at: Date.now() - 60000, five_hour: w(9, -5), seven_day: w(9, -5), tried: Date.now() }); out = line(h, 'a', lim(50, 36));
check(/7d-quota .*36%/.test(out) && /5h-quota .*50%/.test(out), 'an answer whose windows are over: as before', out);
check(['five_hour', 'seven_day', 't'].every((k) => k in snap(h).a) && snap(h).a.five_hour.resets_at === R5, 'what goal2 reads is as it was', snap(h));

// what the status line started in the background writes into these homes for a moment yet
for (let k = 0; k < 8; k++) { sleep(1000); try { fs.rmSync(W, { recursive: true, force: true }); } catch (_) { /* in use */ } }
console.log(pass + ' passed, ' + fail + ' failed; the Stop hook took ' + took + ' ms');
process.exit(fail ? 1 : 0);
