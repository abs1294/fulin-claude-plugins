#!/usr/bin/env node
// The usage records (scripts/lib-records.js): every message once, priced, kept; in a made-up home folder.
// Run: node hooks/tests/records.test.js -> one line a failed check, exit 1 when there is one.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync, spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..'), LIB = path.join(ROOT, 'scripts', 'lib-records.js');
let pass = 0, fail = 0;
const check = (ok, what, got) => { if (ok) pass++; else { fail++; console.log('FAIL | ' + what + ' | ' + JSON.stringify(got)); } };
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rec-')), env = Object.assign({}, process.env, { USERPROFILE: H, HOME: H });
const PRJ = path.join(H, '.claude', 'projects'), REC = path.join(H, '.claude', 'usage-data', 'records'), P = 'C--w-proj', D = path.join(PRJ, P);
const run = (o) => { const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(' + JSON.stringify(LIB) + ').collect(' + JSON.stringify(o || {}) + ')))'], { env, encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch (e) { return r.stderr; } };
const all = () => { const out = []; let ms = []; try { ms = fs.readdirSync(REC).filter((m) => /^\d{4}-/.test(m)); } catch (e) {} for (const m of ms) for (const f of fs.readdirSync(path.join(REC, m))) for (const l of fs.readFileSync(path.join(REC, m, f), 'utf8').split('\n')) if (l) { try { out.push(Object.assign({ m, f }, JSON.parse(l))); } catch (e) { out.push({ bad: l }); } } return out; };
const meta = () => JSON.parse(fs.readFileSync(path.join(REC, 'meta.json'), 'utf8'));
const turn = (id, model, ts, usage, x) => JSON.stringify(Object.assign({ type: 'assistant', cwd: 'C:\\w\\proj', timestamp: ts, entrypoint: 'cli', message: { id, model, content: [{ type: 'text', text: '秘密內容' }], usage } }, x)) + '\n';
const U = { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 4000, cache_creation: { ephemeral_1h_input_tokens: 1000 }, output_tokens_details: { thinking_tokens: 50 } };
const oldFile = (f) => fs.utimesSync(f, new Date(2026, 0, 1), new Date(2026, 0, 1));
try {
  const S = '11111111-1111-4111-8111-111111111111', sub = path.join(D, S, 'subagents');
  fs.mkdirSync(path.join(sub, 'workflows', 'wf_1'), { recursive: true });
  const main = path.join(D, S + '.jsonl');
  fs.writeFileSync(main, JSON.stringify({ type: 'agent-setting', agentSetting: 'qa' }) + '\n' + turn('a', 'claude-opus-5-5', '2026-10-31T23:30:00Z', U) + turn('a', 'claude-opus-5-5', '2026-10-31T23:30:00Z', U) + '{"broken "usage"\n' + turn('s', 'claude-haiku-4-5', '2026-11-02T00:00:00Z', { input_tokens: 10 }) + turn('syn', '<synthetic>', '2026-11-02T00:00:00Z', { input_tokens: 9 }) + turn('g', 'gpt-9', '2026-11-02T00:00:00Z', { input_tokens: 7 }) + turn('', 'claude-haiku-4-5', '2026-11-02T00:00:00Z', { input_tokens: 5 }));
  fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), turn('s', 'claude-haiku-4-5', '2026-11-02T00:00:00Z', { input_tokens: 10 }));
  fs.writeFileSync(path.join(sub, 'agent-x.meta.json'), JSON.stringify({ agentType: 'name', customAgentType: 'engineer', teamName: 't' }));
  fs.writeFileSync(path.join(sub, 'workflows', 'wf_1', 'agent-w.jsonl'), turn('w', 'claude-opus-9', '2026-11-03T00:00:00Z', { input_tokens: 1000000 }));
  let r = run(); let x = all();
  check(r && r.added === 5 && JSON.stringify(r.missing) === '["opus-9"]', 'each message once; the program\'s own lines not', r);
  const by = (id) => x.find((y) => y.id === id);
  const a = by('a');
  check(a && a.m === '2026-10' && a.f === P + '.jsonl' && a.sid === S && !a.agent && a.role === 'qa' && a.file === undefined && a.line === 2 && a.key === 'opus-5-5' && a.in === 1000 && a.out === 2000 && a.cw5 === 2000 && a.cw1 === 1000 && a.rd === 4000 && a.think === 50 && a.entry === 'cli' && Math.abs(a.cost - 0.0628) < 1e-9 && a.flag === undefined, 'a conversation\'s record', a);
  const s = by('s'); check(s && s.agent === 'agent-x' && s.role === 'engineer' && s.team === 1 && s.file === S + '/subagents/agent-x.jsonl' && s.line === 1, 'what stands in both is the subagent\'s', s);
  check(by('w').agent === 'agent-w' && by('w').flag === 'approx' && by('w').cost > 0 && by('w').role === '?', 'a workflow\'s subagent; a stand-in price', by('w'));
  check(by('g').flag === 'unpriced' && by('g').cost === undefined && by('g').key === undefined, 'no price', by('g'));
  check(x.some((y) => y.id === undefined && y.in === 5), 'a message without an id', x.length);
  check(!JSON.stringify(x).includes('秘密') && !fs.readFileSync(path.join(REC, 'meta.json'), 'utf8').includes('秘密'), 'no conversation text', '');
  let m = meta(); check(m.v === 1 && Math.abs(m.at - Date.now()) < 60000 && m.prices['opus-5-5'].exact === true && m.prices['opus-9'].exact === false && m.modelIds['claude-opus-5-5'] === 'opus-5-5' && m.projects[P].path === 'C:\\w\\proj' && m.months.join() === '2026-10,2026-11' && m.records === 5, 'meta', m);
  r = run(); check(r.added === 0 && all().length === 5, 'again: nothing', r);
  // only what was added; a line not finished is taken when it is
  const half = turn('b', 'claude-haiku-4-5', '2026-11-04T00:00:00Z', { input_tokens: 1 });
  fs.appendFileSync(main, half.slice(0, 40)); r = run(); check(r.added === 0, 'an unfinished line waits', r);
  fs.appendFileSync(main, half.slice(40)); r = run({ transcript: main }); check(r.added === 1 && by.call(null, 'a') && all().find((y) => y.id === 'b').line === 9, 'then it is taken, its line counted right', all().find((y) => y.id === 'b'));
  // only the conversation named
  const other = path.join(D, '22222222-1111-4111-8111-111111111111.jsonl'); fs.writeFileSync(other, turn('o', 'claude-haiku-4-5', '2026-11-04T00:00:00Z', { input_tokens: 1 }));
  r = run({ transcript: main }); check(r.added === 0, 'another conversation is not looked at for this one', r);
  r = run(); check(r.added === 1, 'it is, when everything is', r);
  // a copy of a conversation, younger: what it carried over stays the original's
  const copy = path.join(D, '00000000-1111-4111-8111-111111111111.jsonl'); fs.writeFileSync(copy, fs.readFileSync(main, 'utf8') + turn('c', 'claude-haiku-4-5', '2026-11-05T00:00:00Z', { input_tokens: 1 }));
  r = run(); check(r.added === 1 && all().find((y) => y.id === 'c').sid.startsWith('00000000'), 'a copy: only what was said in it', r);
  // a transcript cleared away: its records stay; the same message elsewhere is not counted again
  fs.unlinkSync(other); r = run(); check(all().some((y) => y.id === 'o'), 'a cleared transcript\'s records stay', all().length);
  fs.writeFileSync(other, turn('o', 'claude-haiku-4-5', '2026-11-04T00:00:00Z', { input_tokens: 1 })); r = run(); check(r.added === 0, 'and are not counted again', r);
  // a transcript made shorter (rewritten): read again, nothing twice
  fs.writeFileSync(main, turn('a', 'claude-opus-5-5', '2026-10-31T23:30:00Z', U) + turn('d', 'claude-haiku-4-5', '2026-11-05T00:00:00Z', { input_tokens: 1 })); r = run(); check(r.added === 1, 'a rewritten transcript', r);
  // a writing that did not finish: half a line, and messages not noted
  const n0 = all().length, rf = path.join(REC, '2026-11', P + '.jsonl');
  fs.appendFileSync(main, turn('e', 'claude-haiku-4-5', '2026-11-06T00:00:00Z', { input_tokens: 1 }));
  fs.appendFileSync(rf, JSON.stringify({ id: 'e', ts: Date.parse('2026-11-06T00:00:00Z'), sid: S, line: 3, model: 'claude-haiku-4-5', key: 'haiku-4-5', in: 1, cost: 0.000001 }) + '\n{"id":"half');
  fs.writeFileSync(path.join(REC, '.own', 'dirty'), '1');
  r = run(); x = all(); check(r.added === 0 && x.length === n0 + 1 && !x.some((y) => y.bad) && x.filter((y) => y.id === 'e').length === 1 && !fs.existsSync(path.join(REC, '.own', 'dirty')) && meta().records === n0 + 1, 'mended, nothing twice', [r, x.length, n0]);
  // a price found later: the records of that model are priced again
  fs.writeFileSync(path.join(H, '.claude', 'usage-data', 'cc-statusline-prices.json'), JSON.stringify({ prices: { 'opus-9': { in: 100, out: 1, cw: 1, cw1h: 1, cr: 1 } } }));
  r = run(); const w = all().find((y) => y.id === 'w'); check(w.cost === 100 && w.flag === undefined && meta().prices['opus-9'].exact === true && all().find((y) => y.id === 'a').cost === a.cost && all().length === n0 + 1, 'priced again', w);
  // a copy seen before the conversation it was copied from, and one the original does not have
  {
    const O = '77777777-1111-4111-8111-111111111111', C = '66666666-1111-4111-8111-111111111111', of = path.join(D, O + '.jsonl'), cf = path.join(D, C + '.jsonl'), hb = { input_tokens: 1 };
    const said = turn('k1', 'claude-haiku-4-5', '2026-11-08T00:00:00Z', hb, { sessionId: O });
    fs.writeFileSync(of, said);
    fs.writeFileSync(cf, turn('k1', 'claude-haiku-4-5', '2026-11-08T00:00:00Z', hb, { sessionId: C, requestSessionId: O }) + turn('k2', 'claude-haiku-4-5', '2026-11-08T00:00:01Z', hb, { sessionId: C, requestSessionId: O }) + turn('k3', 'claude-haiku-4-5', '2026-11-08T00:00:02Z', hb, { sessionId: C, requestSessionId: C }) + turn('k4', 'claude-haiku-4-5', '2026-11-08T00:00:03Z', hb, { sessionId: C, requestSessionId: '55555555-0000-4000-8000-000000000000' }));
    run({ transcript: cf }); let y = all(); const who = (id) => (y.filter((z) => z.id === id).map((z) => z.sid.slice(0, 2)).join());
    check(who('k1') === '' && who('k3') === '66' && who('k4') === '66', 'a copy seen first leaves what it carried over', [who('k1'), who('k2'), who('k3'), who('k4')]);
    run(); y = all(); check(who('k1') === '77' && who('k2') === '66' && who('k3') === '66', 'the original\'s is the original\'s; what only the copy has is not lost', [who('k1'), who('k2'), who('k3')]);
    run(); check(all().length === y.length, 'and nothing twice', [all().length, y.length]);
  }
  // rewritten longer than it was: nothing in it is passed over
  {
    const f = path.join(D, '88888888-1111-4111-8111-111111111111.jsonl'), hb = { input_tokens: 1 }, T = (i) => turn(i, 'claude-haiku-4-5', '2026-11-09T00:00:00Z', hb);
    fs.writeFileSync(f, T('r1') + T('orphan')); run(); fs.writeFileSync(f, T('r1') + T('r2') + T('r3') + T('r4')); run();
    check(['r1', 'r2', 'r3', 'r4', 'orphan'].every((i) => all().filter((y) => y.id === i).length === 1), 'a rewritten transcript, longer', all().filter((y) => /^r\d/.test(y.id || '')).map((y) => y.id));
  }
  // what is not a time is passed over
  fs.appendFileSync(main, turn('t0', 'claude-haiku-4-5', '1970-01-01T00:00:00Z', { input_tokens: 1 }) + turn('t9', 'claude-haiku-4-5', '+012026-01-01T00:00:00Z', { input_tokens: 1 }) + turn('tx', 'claude-haiku-4-5', 'x', { input_tokens: 1 })); r = run();
  check(r.added === 0 && !fs.readdirSync(REC).some((f) => f.startsWith('+')), 'not a time', r);
  // meta.at is when everything was looked at
  { const t1 = meta().at; const q = run({ transcript: main }); check(q.everything === false && meta().at === t1, 'a single conversation does not make the rest look fresh', [q, meta().at - t1]); }
  // ended while it was being written: prices, models and the number are there afterwards, and a price found later reaches all of it
  {
    const H2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rec2-')), e2 = Object.assign({}, process.env, { USERPROFILE: H2, HOME: H2 }), d2 = path.join(H2, '.claude', 'projects', P), R2 = path.join(H2, '.claude', 'usage-data', 'records');
    fs.mkdirSync(d2, { recursive: true });
    for (let i = 0; i < 5; i++) { let x2 = ''; for (let k = 0; k < 9000; k++) x2 += turn('z' + i + '-' + k, i < 3 ? 'claude-opus-9' : 'claude-haiku-4-5', '2026-11-10T00:00:00Z', { input_tokens: 1000000 }); fs.writeFileSync(path.join(d2, '9999999' + i + '-1111-4111-8111-111111111111.jsonl'), x2); }
    const kill = spawnSync(process.execPath, ['-e', "const fs=require('fs'),o=fs.appendFileSync;let n=0;fs.appendFileSync=function(f,...a){const r=o.call(fs,f,...a);if(/ids\\.txt$/.test(f)&&++n===" + 1 + ")process.exit(9);return r;};require(" + JSON.stringify(LIB) + ").collect()"], { env: e2 });
    const go = () => spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(' + JSON.stringify(LIB) + ').collect()))'], { env: e2, encoding: 'utf8' });
    go(); const m2 = () => JSON.parse(fs.readFileSync(path.join(R2, 'meta.json'), 'utf8')), rows = () => fs.readFileSync(path.join(R2, '2026-11', P + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let q = rows(); check(kill.status === 9 && q.length === 45000 && new Set(q.map((y) => y.id)).size === 45000 && m2().records === 45000 && m2().modelIds['claude-opus-9'] === 'opus-9' && m2().prices['haiku-4-5'], 'ended in between: mended', [kill.status, q.length, m2().records]);
    fs.writeFileSync(path.join(H2, '.claude', 'usage-data', 'cc-statusline-prices.json'), JSON.stringify({ prices: { 'opus-9': { in: 100, out: 1, cw: 1, cw1h: 1, cr: 1 } } }));
    // a reader holds the file just then (Windows: it cannot be replaced): the old price stays and is put right next time
    const held = spawnSync(process.execPath, ['-e', "const fs=require('fs'),o=fs.renameSync;fs.renameSync=function(a,b){if(/2026-11/.test(b)){const e=new Error('busy');e.code='EPERM';throw e;}return o.call(fs,a,b);};console.log(JSON.stringify(require(" + JSON.stringify(LIB) + ").collect()))"], { env: e2, encoding: 'utf8' });
    check(/"stale":\["opus-9"\]/.test(held.stdout) && rows().every((y) => y.key !== 'opus-9' || y.cost === 4), 'a file that cannot be replaced is told', held.stdout + held.stderr);
    go(); check(rows().filter((y) => y.key === 'opus-9').every((y) => y.cost === 100 && y.flag === undefined), 'and priced next time', rows()[0]);
    // the lock taken over while it worked: nothing is written any more
    const n2 = rows().length; fs.appendFileSync(path.join(d2, '99999990-1111-4111-8111-111111111111.jsonl'), turn('late', 'claude-haiku-4-5', '2026-11-10T00:00:00Z', { input_tokens: 1 }));
    const lost = spawnSync(process.execPath, ['-e', "const fs=require('fs'),o=fs.openSync;let n=0;fs.openSync=function(f,...a){if(/99999990/.test(String(f))&&!n++)fs.writeFileSync(" + JSON.stringify(path.join(R2, '.own', 'lock')) + ",'1');return o.call(fs,f,...a);};try{require(" + JSON.stringify(LIB) + ").collect();console.log('wrote')}catch(e){console.log('stopped')}"], { env: e2, encoding: 'utf8' });
    check(/stopped/.test(lost.stdout) && rows().length === n2, 'a lock that was taken over', lost.stdout + lost.stderr);
    fs.rmSync(H2, { recursive: true, force: true });
  }
  // a copy, and a run that ends after part of it was written: what only the copy has is there afterwards; an original that cannot be read just then keeps what is its own
  {
    const H3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rec3-')), e3 = Object.assign({}, process.env, { USERPROFILE: H3, HOME: H3 }), d3 = path.join(H3, '.claude', 'projects', P), R3 = path.join(H3, '.claude', 'usage-data', 'records'), hb = { input_tokens: 1 };
    const O = '77777777-1111-4111-8111-111111111111', C = '88888888-1111-4111-8111-111111111111', go = (pre) => spawnSync(process.execPath, ['-e', (pre || '') + 'try{console.log(JSON.stringify(require(' + JSON.stringify(LIB) + ').collect()))}catch(e){console.log(e.message)}'], { env: e3, encoding: 'utf8' });
    const k = (i, sid, req) => turn(i, 'claude-haiku-4-5', '2026-11-08T00:00:00Z', hb, Object.assign({ sessionId: sid }, req ? { requestSessionId: req } : {}));
    const rows = () => { try { return fs.readFileSync(path.join(R3, '2026-11', P + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }, of = (i) => rows().filter((y) => y.id === i).map((y) => y.sid.slice(0, 2)).join();
    fs.mkdirSync(d3, { recursive: true });
    fs.writeFileSync(path.join(d3, O + '.jsonl'), k('k1', O)); fs.writeFileSync(path.join(d3, C + '.jsonl'), k('k1', C, O) + k('k2', C, O) + k('k3', C, C));
    { const f = path.join(d3, '99999999-1111-4111-8111-111111111111.jsonl'); let x3 = ''; for (let i = 0; i < 21000; i++) x3 += turn('m' + i, 'claude-haiku-4-5', '2026-11-08T00:00:00Z', hb); fs.writeFileSync(f, x3); const later = new Date(Date.now() + 5000); fs.utimesSync(f, later, later); }
    const cut = go("const fs=require('fs'),o=fs.unlinkSync;let n=0;fs.unlinkSync=function(f){const r=o.call(fs,f);if(/dirty$/.test(f)&&!n++)process.exit(9);return r;};");
    check(cut.status === 9 && of('k2') === '' && of('k1') === '77', 'ended after the first part was written', [cut.status, of('k1'), of('k2'), cut.stdout]);
    go(); check(of('k2') === '88' && of('k1') === '77' && of('k3') === '88' && rows().length === 21003, 'what only the copy has is not lost', [of('k1'), of('k2'), of('k3'), rows().length]);
    const O2 = '55555555-1111-4111-8111-111111111111', C2 = '66666666-1111-4111-8111-111111111111'; fs.writeFileSync(path.join(d3, O2 + '.jsonl'), k('q1', O2)); fs.writeFileSync(path.join(d3, C2 + '.jsonl'), k('q1', C2, O2) + k('q2', C2, O2));
    go("const fs=require('fs'),o=fs.openSync;fs.openSync=function(f,...a){if(String(f).includes('" + O2 + "'))throw Object.assign(new Error('busy'),{code:'EBUSY'});return o.call(fs,f,...a);};");
    check(of('q1') === '' && of('q2') === '', 'an original that cannot be read just then: not settled', [of('q1'), of('q2')]);
    go(); check(of('q1') === '55' && of('q2') === '66', 'settled when it can', [of('q1'), of('q2')]);
    // meta.json gone: made again
    fs.unlinkSync(path.join(R3, 'meta.json')); go(); { const m3 = JSON.parse(fs.readFileSync(path.join(R3, 'meta.json'), 'utf8')); check(m3.records === rows().length && m3.modelIds['claude-haiku-4-5'] === 'haiku-4-5' && m3.prices['haiku-4-5'] && m3.at > 0, 'meta.json made again', m3); }
    fs.rmSync(H3, { recursive: true, force: true });
  }
  // two at once: nothing lost, nothing twice
  const n1 = all().length;
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(D, '3333333' + (i % 10) + '-' + (1000 + i) + '-4111-8111-111111111111.jsonl'), turn('p' + i, 'claude-haiku-4-5', '2026-11-07T00:00:00Z', { input_tokens: 1 }).repeat(50));
  const two = spawnSync(process.execPath, ['-e', 'const {spawn}=require("child_process");let d=0;for(let i=0;i<6;i++)spawn(process.execPath,["-e","require(process.env.L).collect()"],{env:Object.assign({},process.env,{L:' + JSON.stringify(LIB) + '}),stdio:"ignore"}).on("exit",()=>{if(++d===6)process.exit(0)});'], { env, encoding: 'utf8', timeout: 60000 });
  run(); x = all(); check(two.status === 0 && x.filter((y) => /^p\d/.test(y.id || '')).length === 30 && x.length === n1 + 30 && !x.some((y) => y.bad), 'six at once', [x.length, n1]);
  check(!fs.readdirSync(path.join(REC, '.own')).some((f) => /\.tmp$|^lock$/.test(f)), 'nothing left behind', fs.readdirSync(path.join(REC, '.own')));
  // not under the projects folder
  const out = path.join(H, 'x.jsonl'); fs.writeFileSync(out, turn('z', 'claude-haiku-4-5', '2026-11-07T00:00:00Z', { input_tokens: 1 })); r = run({ transcript: out }); check(r && r.added === 0, 'a transcript elsewhere is not ours', r);
} finally { try { fs.rmSync(H, { recursive: true, force: true }); } catch (e) {} }
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
