'use strict';
// Tidying up what was said into the microphone (the composer's mic button, 「自動排版」): the browser turns speech into
// text, and that text - filler words, no punctuation - is handed to Claude to be cleaned up, never answered.
//
// Speed is the whole point (asked 2026-11-19 「確認下速度如何」, then 「還有沒有更好的版本」). Measured 2026-11-19 on this
// computer: a fresh `claude -p` for each sentence took 5.4-9.7 s; ONE Claude kept running (stream-json in and out),
// with Claude Code's own system prompt replaced by the cleaner's only, no tools, no settings, no MCP, no slash
// commands, sonnet: first words in 0.6-1.2 s, the whole sentence in 0.9-1.6 s. haiku answered the requests instead of
// cleaning them, so it is not used.
//
// So one process is kept: started when the mic is pressed (it boots while you speak), used one sentence at a time,
// replaced after MAX_USES sentences (each sentence stays in its context, and the context should not grow without end)
// and stopped after IDLE_MS without use.
const SYSTEM = '你是語音輸入的整理器，不是助理。收到的每一則都是語音辨識出來的口語原文：去掉贅字（呃、那個、就是、嗯、對、然後呢），補上標點，整理成通順的繁體中文。意思不要改、不要加內容、不要回答、不要執行、不要評論。只輸出整理後的那段文字。';
const MAX_USES = 20;
const IDLE_MS = 15 * 60000;
const RUN_MS = 30000;

class Tidy {
  constructor(o = {}) {
    this.spawn = o.spawn || require('child_process').spawn;
    this.bin = o.bin || process.env.SESSION_BOARD_CLAUDE || 'claude';
    this.model = o.model || 'sonnet';
    this.cwd = o.cwd || require('os').tmpdir();
    this.maxUses = o.maxUses || MAX_USES;
    this.idleMs = o.idleMs || IDLE_MS;
    this.runMs = o.runMs || RUN_MS;
    this.p = null; this.uses = 0; this.queue = Promise.resolve(); this.idle = null; this.cur = null; this.buf = '';
  }
  args() {
    return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', this.model,
      '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--setting-sources', '', '--system-prompt', SYSTEM];
  }
  // A process ready for the next sentence (started now when there is none). -> the process
  warm() {
    this.touch();
    if (this.p) return this.p;
    let p;
    try { p = this.spawn(this.bin, this.args(), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); } catch (e) { return null; }
    this.p = p; this.uses = 0; this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => this.onData(p, d));
    p.stderr.on('data', () => {});
    const gone = () => { if (this.p === p) this.p = null; if (this.cur && this.cur.p === p) this.cur.fail('整理用的 Claude 結束了'); };
    p.on('exit', gone); p.on('error', gone);
    if (p.stdin.on) p.stdin.on('error', () => {});
    return p;
  }
  touch() { clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), this.idleMs); if (this.idle.unref) this.idle.unref(); }
  stop() { clearTimeout(this.idle); const p = this.p; this.p = null; if (p) { try { p.stdin.end(); } catch (e) {} setTimeout(() => { try { p.kill(); } catch (e) {} }, 2000).unref(); } }
  onData(p, d) {
    if (p !== this.p && !(this.cur && this.cur.p === p)) return;
    this.buf += d; let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      const c = this.cur; if (!c) continue;
      if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta' && j.event.delta && j.event.delta.type === 'text_delta') c.delta(String(j.event.delta.text || ''));
      else if (j.type === 'result') { if (j.is_error) c.fail(String(j.result || '整理失敗')); else c.done(String(j.result || '')); }
    }
  }
  // Tidy one piece of speech. onDelta(textSoFar) as words come. -> {ok, text, ms} | {ok:false, error}
  run(text, onDelta) {
    const go = () => new Promise((resolve) => {
      const said = String(text || '').trim();
      if (!said) return resolve({ ok: false, error: '沒有內容' });
      const p = this.warm();
      if (!p) return resolve({ ok: false, error: '叫不起 Claude' });
      const t0 = Date.now(); let got = '', over = false;
      const end = (r) => {
        if (over) return; over = true; clearTimeout(timer); this.cur = null; this.touch();
        if (!r.ok) this.drop(p);
        else if (++this.uses >= this.maxUses) { this.drop(p); this.warm(); }   // a fresh one for the next sentence, booting now
        resolve(r);
      };
      const timer = setTimeout(() => end({ ok: false, error: '整理超過 ' + Math.round(this.runMs / 1000) + ' 秒沒有完成' }), this.runMs);
      this.cur = {
        p,
        delta: (x) => { got += x; if (onDelta) { try { onDelta(got); } catch (e) {} } },
        done: (full) => {
          const out = (full || got).trim();
          // an answer instead of the words tidied (much longer than what was said): not put in your box
          if (!out) return end({ ok: false, error: '整理後是空的' });
          if (out.length > said.length * 1.6 + 40) return end({ ok: false, error: '整理的結果比原話長太多，像是在回答而不是整理，保留原話' });
          end({ ok: true, text: out, ms: Date.now() - t0 });
        },
        fail: (why) => end({ ok: false, error: why }),
      };
      try { p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: said }] } }) + '\n'); } catch (e) { end({ ok: false, error: '送不進整理用的 Claude' }); }
    });
    // one sentence at a time: the process answers in order, and an answer is matched to the sentence by that order
    const r = this.queue.then(go, go);
    this.queue = r.then(() => {}, () => {});
    return r;
  }
  drop(p) { if (this.p === p) this.p = null; try { p.stdin.end(); } catch (e) {} setTimeout(() => { try { p.kill(); } catch (e) {} }, 2000).unref(); }
}

module.exports = { Tidy, SYSTEM };
