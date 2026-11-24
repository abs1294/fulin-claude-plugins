'use strict';
// node --test plugins/session-board/tests
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sessions');

// Every temp dir made here is removed when the run ends; nothing else is touched.
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-test-')); made.push(d); return d; };
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });
const SID = '11111111-2222-3333-4444-555555555555';
const title = (type, prop, v) => JSON.stringify({ type, [prop]: v, sessionId: SID });

test('sidKey and encodeCwd follow cc-statusline and Claude Code naming', () => {
  assert.strictEqual(S.sidKey('1b93d84e-600b-4f00-82b4-ac7abc3a7e52'), '1b93d84e600b4f0082b4ac7a');
  assert.strictEqual(S.encodeCwd('C:\\Users\\User\\Claude\\fulin-claude-plugins'), 'C--Users-User-Claude-fulin-claude-plugins');
  assert.strictEqual(S.encodeCwd('C:\\Users\\User\\Claude\\文件'), 'C--Users-User-Claude---');
});

test('lastTitles returns the LAST entry of each kind', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, [
    title('ai-title', 'aiTitle', '舊標題'),
    '{"type":"user","message":"x"}',
    title('custom-title', 'customTitle', '自訂標題'),
    title('ai-title', 'aiTitle', '新標題'),
    '{"type":"assistant","message":"y"}',
  ].join('\n') + '\n');
  const r = S.lastTitles(f);
  assert.strictEqual(r.ai, '新標題');
  assert.strictEqual(r.custom, '自訂標題');
});

test('lastTitles ignores the marker when it is quoted inside another entry', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, [
    title('ai-title', 'aiTitle', '真標題'),
    JSON.stringify({ type: 'user', message: '{"type":"ai-title","aiTitle":"假標題"}' }),
  ].join('\n') + '\n');
  assert.strictEqual(S.lastTitles(f).ai, '真標題');
});

test('lastTitles finds a title line that straddles a chunk boundary, at every offset', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  const line = title('ai-title', 'aiTitle', '跨塊邊界的標題');
  const lineBytes = Buffer.byteLength(line) + 1;
  // Slide the title line across the boundary one byte at a time by varying
  // the amount of filler after it; chunk=64 with overlap larger than the line.
  for (let pad = 0; pad < 64 + lineBytes; pad++) {
    fs.writeFileSync(f, '{"type":"user"}\n' + line + '\n' + 'x'.repeat(pad) + '\n');
    const r = S.lastTitles(f, { chunk: 64, overlap: lineBytes + 8 });
    assert.strictEqual(r.ai, '跨塊邊界的標題', 'pad=' + pad);
  }
});

test('lastTitles stops at the cap instead of reading a huge file to the start', () => {
  const d = tmp();
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, title('ai-title', 'aiTitle', '太前面') + '\n' + ('{"type":"user"}\n').repeat(4000));
  const r = S.lastTitles(f, { chunk: 1024, overlap: 256, cap: 4096 });
  assert.strictEqual(r.ai, null);
  assert.ok(r.scanned <= 4096 + 1024, 'scanned=' + r.scanned);
});

test('a fixed name the board gave (--name) is written down as a title too: the title before it is used, and a terminal window is found by it', () => {
  const d = tmp();
  const o = { sessionsDir: path.join(d, 's'), projectsDir: path.join(d, 'p'), stateDir: path.join(d, 'st'), legacyStateDir: path.join(d, 'l'), pidAlive: () => true };
  for (const k of ['sessionsDir', 'projectsDir', 'stateDir', 'legacyStateDir']) fs.mkdirSync(o[k], { recursive: true });
  const cwd = '/Users/x/work', pdir = path.join(o.projectsDir, S.encodeCwd(cwd)); fs.mkdirSync(pdir, { recursive: true });
  const f = path.join(pdir, SID + '.jsonl');
  fs.writeFileSync(f, [title('ai-title', 'aiTitle', 'AI 標題'), title('custom-title', 'customTitle', '談什麼'), title('custom-title', 'customTitle', 'S7-work')].join('\n') + '\n');
  fs.writeFileSync(path.join(o.sessionsDir, '1.json'), JSON.stringify({ pid: 1, sessionId: SID, cwd, kind: 'interactive', entrypoint: 'cli', status: 'idle', name: 'S7-work' }));
  try {
    assert.strictEqual(S.buildSessions(o, Date.now())[0].title, 'S7-work', 'not known as a fixed name');
    S.setCodes(['S7-work']);
    const s = S.buildSessions(o, Date.now())[0];
    assert.deepStrictEqual([s.title, s.titleCandidates, s.addr], ['談什麼', ['談什麼', 'AI 標題', 'S7-work'], 'S7-work']);
    fs.writeFileSync(f, title('ai-title', 'aiTitle', '只有 AI 標題') + '\n' + title('custom-title', 'customTitle', 'S7-work') + '\n');
    assert.strictEqual(S.buildSessions(o, Date.now())[0].title, '只有 AI 標題');
  } finally { S.setCodes([]); }
});

test('lastTitles on a missing file returns nulls', () => {
  assert.deepStrictEqual(S.lastTitles(path.join(tmp(), 'nope.jsonl')), { custom: null, ai: null, scanned: 0 });
});

test('groupOf: who has the ball', () => {
  assert.strictEqual(S.groupOf('waiting', 0), 'yours');
  assert.strictEqual(S.groupOf('waiting', S.STALE_MS * 5), 'yours');     // still needs an answer however old
  assert.strictEqual(S.groupOf('idle', 60000), 'yours');
  assert.strictEqual(S.groupOf('idle', S.STALE_MS + 1), 'stale');
  assert.strictEqual(S.groupOf('busy', S.STALE_MS * 5), 'running');
  assert.strictEqual(S.groupOf(undefined, 0), 'running');
});

test('a terminal session with no status in its registry entry: its transcript tells (not green forever)', () => {
  assert.strictEqual(S.groupUnknown(5000), 'running', 'written to a moment ago: working');
  assert.strictEqual(S.groupUnknown(S.WRITING_MS + 1), 'quiet', 'still since: idle, not "waiting for you"');
  assert.strictEqual(S.groupUnknown(S.STALE_MS + 1), 'stale');
});

test('gitBranch reads a repo, a worktree, and returns empty for a plain folder', () => {
  const d = tmp();
  const repo = path.join(d, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  assert.strictEqual(S.gitBranch(repo), 'feature/x');

  const wtGit = path.join(repo, '.git', 'worktrees', 'w1');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/dev_out\n');
  const wt = path.join(d, 'w1');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + wtGit + '\n');
  assert.strictEqual(S.gitBranch(wt), 'dev_out');

  fs.mkdirSync(path.join(d, 'plain'));
  assert.strictEqual(S.gitBranch(path.join(d, 'plain')), '');
});

test('a window parked on a background job and the job are one row, not two', () => {
  const d = tmp();
  const o = { sessionsDir: path.join(d, 's'), projectsDir: path.join(d, 'p'), stateDir: path.join(d, 'st'), legacyStateDir: path.join(d, 'l'), pidAlive: (pid) => pid !== 9 };
  for (const k of ['sessionsDir', 'projectsDir', 'stateDir', 'legacyStateDir']) fs.mkdirSync(o[k], { recursive: true });
  const now = 1_800_000_000_000;
  const cwd = 'C:\\w\\repo';
  const WIN = '1b93d84e-0000-0000-0000-000000000001', JOB = 'fcddb7be-0000-0000-0000-000000000002';
  const ORPHAN = '99999999-0000-0000-0000-000000000003', LONE = '77777777-0000-0000-0000-000000000004';
  const put = (pid, o2) => fs.writeFileSync(path.join(o.sessionsDir, pid + '.json'), JSON.stringify(Object.assign({ pid, cwd, entrypoint: 'cli' }, o2)));
  put(1, { sessionId: WIN, kind: 'interactive', status: 'idle', statusUpdatedAt: now - 4 * 3600000, name: 'repo-e5', parkedJobId: 'fcddb7be' });
  put(2, { sessionId: JOB, kind: 'bg', status: 'busy', statusUpdatedAt: now - 1000, name: '背景裡的對話', jobId: 'fcddb7be' });
  // A window parked on a job that is gone is still a session of its own.
  put(3, { sessionId: ORPHAN, kind: 'interactive', status: 'idle', statusUpdatedAt: now - 1000, name: 'orphan', parkedJobId: 'deadbeef' });
  put(9, { sessionId: '88888888-0000-0000-0000-000000000009', kind: 'bg', status: 'busy', name: 'dead job', jobId: 'deadbeef' });
  // A background job nobody is watching has no window.
  put(4, { sessionId: LONE, kind: 'bg', status: 'busy', statusUpdatedAt: now - 1000, name: 'lone job', jobId: '77777777' });
  const pdir = path.join(o.projectsDir, S.encodeCwd(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  for (const s of [JOB, LONE]) fs.writeFileSync(path.join(pdir, s + '.jsonl'), title('ai-title', 'aiTitle', '標題 ' + s.slice(0, 4)) + '\n');

  const list = S.buildSessions(o, now);
  assert.deepStrictEqual(list.map((s) => s.sessionId).sort(), [JOB, LONE, ORPHAN].sort());
  const job = list.find((s) => s.sessionId === JOB), lone = list.find((s) => s.sessionId === LONE), orphan = list.find((s) => s.sessionId === ORPHAN);
  assert.deepStrictEqual([job.parked, job.headless, job.status, job.group], [true, false, 'busy', 'running']);   // has a window to switch to
  assert.deepStrictEqual([lone.parked, lone.headless], [false, true]);
  assert.deepStrictEqual([orphan.parked, orphan.headless], [false, false]);
});

test('buildSessions: a terminal session with no status is green only while its transcript is being written', () => {
  const d = tmp();
  const o = { sessionsDir: path.join(d, 's'), projectsDir: path.join(d, 'p'), stateDir: path.join(d, 'st'), legacyStateDir: path.join(d, 'l'), pidAlive: () => true };
  for (const k of ['sessionsDir', 'projectsDir', 'stateDir', 'legacyStateDir']) fs.mkdirSync(o[k], { recursive: true });
  const now = 1_800_000_000_000, cwd = '/Users/x/work';
  const BUSY = 'cdcdcdcd-0000-0000-0000-000000000001', STILL = 'cdcdcdcd-0000-0000-0000-000000000002', NOFILE = 'cdcdcdcd-0000-0000-0000-000000000003';
  let pid = 1;
  for (const sid of [BUSY, STILL, NOFILE]) fs.writeFileSync(path.join(o.sessionsDir, (pid++) + '.json'), JSON.stringify({ pid: pid - 1, sessionId: sid, cwd, kind: 'interactive', entrypoint: 'cli', startedAt: now - 7200000 }));   // no status field
  const pdir = path.join(o.projectsDir, S.encodeCwd(cwd)); fs.mkdirSync(pdir, { recursive: true });
  const at = (sid, ms) => { const f = path.join(pdir, sid + '.jsonl'); fs.writeFileSync(f, title('ai-title', 'aiTitle', sid.slice(-1)) + '\n'); fs.utimesSync(f, (now - ms) / 1000, (now - ms) / 1000); };
  at(BUSY, 10 * 1000); at(STILL, 3600 * 1000);
  const list = S.buildSessions(o, now);
  const g = (sid) => { const s = list.find((x) => x.sessionId === sid); return s && [s.status, s.group]; };
  assert.deepStrictEqual(g(BUSY), ['unknown', 'running'], 'written 10 s ago');
  assert.deepStrictEqual(g(STILL), ['unknown', 'quiet'], 'written an hour ago: idle, the same as the top of the conversation says');
  assert.deepStrictEqual(g(NOFILE), ['unknown', 'running'], 'no transcript to tell by: as before');
});

test('buildSessions tolerates registry fields of the wrong type', () => {
  const d = tmp();
  const o = { sessionsDir: path.join(d, 's'), projectsDir: path.join(d, 'p'), stateDir: path.join(d, 'st'), legacyStateDir: path.join(d, 'l'), pidAlive: () => true };
  for (const k of ['sessionsDir', 'projectsDir', 'stateDir', 'legacyStateDir']) fs.mkdirSync(o[k], { recursive: true });
  const now = 1_800_000_000_000;
  fs.writeFileSync(path.join(o.sessionsDir, '1.json'), JSON.stringify({
    pid: 1, sessionId: 'abababab-0000-0000-0000-000000000001', cwd: 42, name: { x: 1 },
    status: 7, statusUpdatedAt: 'yesterday', updatedAt: null, startedAt: 'x', kind: 'interactive',
    bridgeSessionId: 'session_x"><script>' }));
  fs.writeFileSync(path.join(o.sessionsDir, '2.json'), JSON.stringify({
    pid: 2, sessionId: 'abababab-0000-0000-0000-000000000002', kind: 'interactive', status: 'busy',
    statusUpdatedAt: now - 1000, bridgeSessionId: 'session_019QKgTPb4LXuNp3T6gockPw' }));
  const list = S.buildSessions(o, now);
  const s = list.find((x) => x.sessionId.endsWith('1'));
  assert.strictEqual(s.chatUrl, '');   // not the expected shape: no link at all
  assert.strictEqual(list.find((x) => x.sessionId.endsWith('2')).chatUrl, 'https://claude.ai/code/session_019QKgTPb4LXuNp3T6gockPw');
  assert.strictEqual(s.since, now);
  assert.strictEqual(s.name, '');
  assert.strictEqual(s.title, 'session abababab');
  assert.strictEqual(s.status, 'unknown');
  assert.strictEqual(s.cwd, '');
  assert.strictEqual(s.startedAt, 0);
});

test('buildSessions: drops dead pids, picks the title by trust, sorts by lane', () => {
  const d = tmp();
  const o = {
    sessionsDir: path.join(d, 'sessions'), projectsDir: path.join(d, 'projects'),
    stateDir: path.join(d, 'state'), legacyStateDir: path.join(d, 'legacy'),
    pidAlive: (pid) => pid !== 999,
  };
  for (const k of Object.keys(o)) if (k !== 'pidAlive') fs.mkdirSync(o[k], { recursive: true });
  const now = 1_800_000_000_000;
  const cwd = 'C:\\work\\proj';
  const reg = (pid, sid, status, ago, name) => fs.writeFileSync(path.join(o.sessionsDir, pid + '.json'),
    JSON.stringify({ pid, sessionId: sid, cwd, name, status, statusUpdatedAt: now - ago, startedAt: now - 9e7, kind: 'interactive' }));
  const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const C = 'cccccccc-0000-0000-0000-000000000003', D = 'dddddddd-0000-0000-0000-000000000004';
  const E = 'eeeeeeee-0000-0000-0000-000000000005';
  reg(1, A, 'busy', 5 * 60000, 'proj-a');
  reg(2, B, 'idle', 2 * 60000, 'proj-b');
  reg(3, C, 'waiting', 30 * 60000, 'proj-c');
  reg(4, D, 'idle', S.STALE_MS + 60000, 'proj-d');
  reg(999, E, 'busy', 0, 'proj-dead');
  fs.writeFileSync(path.join(o.sessionsDir, 'broken.json'), '{not json');
  // A background entry with no transcript and no title is not listed...
  fs.writeFileSync(path.join(o.sessionsDir, '6.json'), JSON.stringify({ pid: 6, sessionId: 'ffffffff-0000-0000-0000-000000000006', cwd, name: 'ffffffff', status: 'idle', statusUpdatedAt: now, kind: 'bg' }));
  // ...but an interactive one with nothing known yet (C below) still is.

  // A: summary file wins over the transcript title.
  fs.writeFileSync(path.join(o.stateDir, `claude-summary-${S.sidKey(A)}.txt`), '摘要標題 A\n');
  const pdir = path.join(o.projectsDir, S.encodeCwd(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, A + '.jsonl'), title('ai-title', 'aiTitle', 'AI 標題 A') + '\n');
  // B: no summary -> ai-title from the transcript.
  fs.writeFileSync(path.join(pdir, B + '.jsonl'), title('ai-title', 'aiTitle', 'AI 標題 B') + '\n');
  // B: last messages.
  fs.writeFileSync(path.join(o.stateDir, `claude-msgs-${S.sidKey(B)}.json`),
    JSON.stringify([{ r: 'u', t: '第一問' }, { r: 'a', t: '**第一答**' }, { r: 'u', t: '第二問' }, { r: 'a', t: '第二答\n```js\ncode\n```' }]));

  const list = S.buildSessions(o, now);
  assert.deepStrictEqual(list.map((s) => s.name), ['proj-c', 'proj-b', 'proj-a', 'proj-d']);
  assert.deepStrictEqual(list.map((s) => s.group), ['yours', 'yours', 'running', 'stale']);
  const a = list.find((s) => s.sessionId === A), b = list.find((s) => s.sessionId === B), c = list.find((s) => s.sessionId === C);
  assert.strictEqual(a.title, '摘要標題 A');
  assert.strictEqual(a.titleSource, 'summary');
  assert.deepStrictEqual(a.titleCandidates, ['摘要標題 A', 'AI 標題 A']);
  assert.strictEqual(b.title, 'AI 標題 B');
  assert.strictEqual(b.titleSource, 'ai-title');
  assert.strictEqual(b.lastUser, '第二問');
  assert.strictEqual(b.lastAssistant, '第二答 [code]');
  assert.strictEqual(c.title, 'proj-c');           // nothing better known: registry name
  assert.strictEqual(c.titleSource, 'name');
  assert.deepStrictEqual(c.titleCandidates, []);
  assert.strictEqual(b.folder, 'proj');
});
