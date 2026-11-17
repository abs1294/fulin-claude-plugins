'use strict';
// A question on the side: answered with everything the conversation holds, and not written into it.
//
// What /btw is in a terminal session. Claude Code does not have it when it runs without a terminal - sent there it
// answers "/btw isn't available in this environment." (measured 2026-11-16, 2.1.325) - so the board does the same
// thing in its own way: Claude Code is started once more as a copy of the conversation that is not saved anywhere,
//
//     claude -p --resume <id> --fork-session --no-session-persistence --tools "" --strict-mcp-config --output-format json
//
// asked the one question, and ended. Measured the same day: it answers from what was said in the conversation; the
// conversation's own file is not changed by a byte; no new transcript is left behind. No tools: it can only answer
// (with --tools "" alone the connected services' tools were still there - hence --strict-mcp-config).
//
// It works for any session that has a transcript, also one running in a terminal window and one that is busy: only
// its file is read. It costs what reading the whole conversation once costs.
const { spawn } = require('child_process');

const TIME_LIMIT_MS = 180000;
const QUESTION_MAX = 4000;

const argsFor = (sid) => ['-p', '--resume', sid, '--fork-session', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--output-format', 'json'];

// -> {ok, answer, cost, ms} or {ok: false, error, ms}
function ask(sid, cwd, question, o = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let p, out = '', err = '', done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ ms: Date.now() - started }, r)); };
    try { p = (o.spawn || spawn)(o.bin || 'claude', argsFor(sid), { cwd, env: o.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return end({ ok: false, error: '啟動不了 Claude Code：' + String(e.message || e).slice(0, 200) }); }
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} end({ ok: false, error: '等了 ' + Math.round((o.timeLimit || TIME_LIMIT_MS) / 1000) + ' 秒還沒有回答，已經停掉' }); }, o.timeLimit || TIME_LIMIT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => end({ ok: false, error: e && e.code === 'ENOENT' ? '找不到 claude 這個程式' : String((e && e.message) || e).slice(0, 200) }));
    p.on('close', () => {
      let j = null;
      try { j = JSON.parse(out); } catch (e) { const line = out.trim().split('\n').filter(Boolean).pop() || ''; try { j = JSON.parse(line); } catch (x) {} }
      if (!j || typeof j !== 'object') return end({ ok: false, error: (err.trim() || out.trim() || 'Claude Code 沒有回答').slice(-300) });
      const text = typeof j.result === 'string' ? j.result : '';
      if (j.is_error || !text) return end({ ok: false, error: (text || err.trim() || 'Claude Code 回報了錯誤').slice(0, 400) });
      end({ ok: true, answer: text, cost: Number(j.total_cost_usd) || 0 });
    });
    p.stdin.on('error', () => {});
    try { p.stdin.write(question); p.stdin.end(); } catch (e) {}
  });
}

module.exports = { ask, argsFor, TIME_LIMIT_MS, QUESTION_MAX };
