'use strict';
// A question on the side: answered with everything the conversation holds, and not written into it.
//
// What /btw is in a terminal session. Claude Code does not have it when it runs without a terminal - sent there it
// answers "/btw isn't available in this environment." (measured 2026-11-16, 2.1.325) - so the board does the same
// thing in its own way: Claude Code is started once more as a copy of the conversation that is not saved anywhere,
//
//     claude -p --resume <id> --fork-session --no-session-persistence --tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --output-format json
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

// No settings either (--setting-sources ''): without it the hooks of your settings, your plugins and the folder ran in
// this side copy too (measured 2026-11-20: "Registered 30 hooks from 9 plugins", a SessionStart hook run; with it,
// 0 hooks - and --resume, --fork-session and Read work as before).
const NO_SETTINGS = ['--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands'];
const argsFor = (sid) => ['-p', '--resume', sid, '--fork-session', '--no-session-persistence', '--tools', ''].concat(NO_SETTINGS, ['--output-format', 'json']);
// A question about a folder, in no conversation at all: nothing resumed, nothing saved (so no session of yours gains
// one, and the board lists none), and it may only read - to look at the file a suggestion is about - never change.
const explainArgs = () => ['-p', '--no-session-persistence', '--tools', 'Read,Grep,Glob'].concat(NO_SETTINGS, ['--output-format', 'json']);

// -> {ok, answer, cost, ms} or {ok: false, error, ms}
function ask(sid, cwd, question, o = {}) { return run(argsFor(sid), cwd, question, o); }
function explain(cwd, prompt, o = {}) { return run(explainArgs(), cwd, prompt, o); }
function run(args, cwd, question, o) {
  const started = Date.now();
  return new Promise((resolve) => {
    let p, out = '', err = '', done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ ms: Date.now() - started }, r)); };
    try { p = (o.spawn || spawn)(o.bin || 'claude', args, { cwd, env: o.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
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

// The 說明 button of a harness suggestion: what to ask, in the manner of /wtf (plain words, one fact a sentence, a table
// where things line up, explained and not done). /wtf itself is not called: it is made for a terminal (it asks the
// window's width first, and draws in a browser), and this answer is shown in a card on the board.
// before: the explanations already given for it (pressed again = still not understood): this one has to be another way.
function explainPrompt(x, before) {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const old = (Array.isArray(before) ? before : []).filter((b) => typeof b === 'string' && b.trim()).slice(-3);
  const again = !old.length ? [] : [
    '',
    '使用者已經看過下面 ' + old.length + ' 個版本的說明，還是看不懂，又按了一次「說明」。這代表之前的講法失敗了，不是使用者沒讀。',
    '這次必須換一種完全不同的講法：換切入點（例如從「現在每次會發生什麼麻煩」講起）、換一個生活中的比喻、或舉一個具體的例子走一遍；用更淺的字、更短的篇幅。',
    '禁止重貼或只改幾個字；前面版本用過的比喻和結構不要再用。開頭不要說「換個方式說」之類的話，直接講。',
  ].concat(old.map((b, i) => '--- 第 ' + (i + 1) + ' 版（看不懂）---\n' + s(b, 3000)));
  return [
    '你在一個專案資料夾裡。harness（這個專案的工作規則學習系統）提了一條建議，等使用者決定「核可」或「駁回」。使用者看不懂這條，按了「說明」。',
    '請用白話把它講清楚，照這些規則：',
    '- 第一句講這條建議一句話是什麼。',
    '- 接著講：它要改哪個檔、改了之後實際行為有什麼不同；為什麼會提（它在解決什麼問題）。',
    '- 用一張表對照「核可會怎樣／駁回會怎樣」。',
    '- 最後給一句你的建議（核可或駁回）和理由；沒把握就說沒把握。',
    '- 一句話一件事，用使用者看得懂的字，術語第一次出現就解釋。不寫鋪陳、不重複。',
    '- 需要的話可以讀它提到的檔案來確認，但只讀不改；你只負責解釋，不做任何改動。',
    '- 用繁體中文，Markdown 格式，不要標題以外的花俏排版。',
    '',
    '建議內容：',
    '編號：' + s(x.id, 80),
    '等級：' + (x.level === 'red' ? '紅區（核可後會實際改規則或程式）' : x.level === 'green' ? '綠區' : s(x.level, 20)),
    '類型／動作／對象：' + [x.kind, x.action, x.target].map((v) => s(v, 200)).filter(Boolean).join(' · '),
    '摘要：' + s(x.summary, 1500),
    x.content ? '完整建議：\n' + s(x.content, 6000) : '',
  ].filter((l) => l !== '').concat(again).join('\n');
}

// The same run with the arguments given (lib/skillwish.js: the 找外掛 search, with its own tools)
function runWith(args, cwd, prompt, o = {}) { return run(args, cwd, prompt, o); }

module.exports = { ask, explain, runWith, explainPrompt, argsFor, explainArgs, TIME_LIMIT_MS, QUESTION_MAX };
