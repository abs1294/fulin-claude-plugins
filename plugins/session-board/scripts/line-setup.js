#!/usr/bin/env node
'use strict';
// Setting up the LINE secretary (lib/line.js), for /session-board:line. Every step is one command; `status` says
// which is next. Nothing secret is ever printed: the channel secret and access token are only checked for shape
// and by asking LINE whether they work.
//
//   status            what is set up and what is not, and the next step (the default)
//   edit              line.json made (if missing) with empty fields, and opened in a text editor - the secrets are
//                     typed there, never into the chat
//   claim             a six-digit code, good for 10 minutes: send it to your LINE Official Account and you are the one
//                     it answers (instead of looking up your user id)
//   funnel            Tailscale Funnel on port 8443 -> the secretary's own listener (127.0.0.1:4318) only
//   webhook           LINE's webhook address set to that, and LINE's own connection test run
//   start             the secretary started on its own, when the board did not start it (an older board)
//   off               Funnel on 8443 switched off: nothing from the internet reaches this computer any more
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const L = require('../lib/line');
const Remote = require('../lib/remote');

const FUNNEL_PORT = 8443;
const BOARD_PORT = 4317;
const cmd = process.argv[2] || 'status';
const ok = (s) => console.log('✓ ' + s), no = (s) => console.log('✗ ' + s), note = (s) => console.log('  ' + s);

const ts = (args, timeout = 30000) => new Promise((resolve) => execFile(Remote.exe(), args, { windowsHide: true, timeout, encoding: 'utf8' }, (err, out, errOut) => resolve({ code: err ? (err.code || 1) : 0, out: String(out || '') + String(errOut || '') })));
const lineApi = (token, p, method = 'GET', body) => fetch('https://api.line.me' + p, { method, headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })).catch((e) => ({ status: 0, json: { message: String(e.message || e) } }));
const listening = (port) => new Promise((resolve) => { const q = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', () => resolve(0)); q.on('timeout', () => { q.destroy(); resolve(0); }); });
const readConf = () => { try { return JSON.parse(fs.readFileSync(L.CONF, 'utf8')); } catch (e) { return null; } };
const writeConf = (c) => { fs.mkdirSync(path.dirname(L.CONF), { recursive: true }); fs.writeFileSync(L.CONF, JSON.stringify(c, null, 2) + '\n'); };
async function tsName() { const i = await Remote.info(); return i.ok ? i.name : ''; }
const hookUrl = (name) => 'https://' + name + ':' + FUNNEL_PORT + L.HOOK;

async function status() {
  let next = '';
  const want = (s) => { if (!next) next = s; };
  // 1. the settings file
  const raw = readConf(), c = L.loadConfig();
  if (!raw) { no('設定檔還沒有：' + L.CONF); want('edit'); }
  else {
    if (/^[0-9a-f]{32}$/.test(c.secret)) ok('Channel secret 已填（32 碼）'); else { no('Channel secret 沒填或格式不對（應該是 32 個 0-9a-f）'); want('edit'); }
    if (c.token.length > 100) ok('Channel access token 已填' + (raw.channelToken ? '' : '（沿用 goal2 的 LINE 通知設定）')); else { no('Channel access token 沒填'); want('edit'); }
  }
  // 2. does LINE accept the token
  let name = '';
  if (c.token.length > 100) {
    const b = await lineApi(c.token, '/v2/bot/info');
    if (b.status === 200) { ok('LINE 認得這個 token：官方帳號「' + b.json.displayName + '」' + (b.json.chatMode === 'bot' ? '' : '（chatMode 是 ' + b.json.chatMode + '，要改成 bot 才會把訊息交給 webhook）')); }
    else { no('LINE 不認得這個 token（' + b.status + ' ' + (b.json.message || '') + '）：重新複製 Channel access token (long-lived)'); want('edit'); }
  }
  // 3. who it answers (asked for last: a code sent before the rest is set up never arrives)
  let bind = '';
  if (c.userId) ok('只回這個 LINE 帳號：' + c.userId.slice(0, 5) + '…' + (raw && raw.userId ? '' : '（沿用 goal2 的設定）'));
  else if (c.claimCode && Date.now() < c.claimUntil) { no('還沒綁定你的 LINE。claim 給你的綁定碼（不再印出）有效到 ' + new Date(c.claimUntil).toLocaleTimeString('zh-TW', { hour12: false })); bind = 'send-code'; }
  else { no('還沒綁定你的 LINE'); bind = 'claim'; }
  // 4. Tailscale and Funnel
  const i = await Remote.info();
  if (!i.ok) { no('Tailscale：' + i.why); want('tailscale'); }
  else {
    name = i.name; ok('Tailscale 已登入：' + i.name);
    const fs2 = await ts(['funnel', 'status']);
    const on = new RegExp(':' + FUNNEL_PORT + ' \\(Funnel on\\)[\\s\\S]*?proxy http://127\\.0\\.0\\.1:' + L.PORT).test(fs2.out);
    if (on) ok('Funnel：' + hookUrl(i.name) + ' → 本機 ' + L.PORT + '（只有小秘書）'); else { no('Funnel 沒有開在 ' + FUNNEL_PORT + ' 埠'); want('funnel'); }
  }
  // 5. the listener and the board
  const lp = await listening(L.PORT), bp = await listening(BOARD_PORT);
  if (bp) ok('看板在跑（' + BOARD_PORT + '）'); else { no('看板沒有在跑：先打 /session-board'); want('board'); }
  if (lp === 404) ok('小秘書在聽（127.0.0.1:' + L.PORT + '）'); else { no('小秘書沒有在聽'); want(bp ? 'start' : 'board'); }
  // 6. LINE's side: the webhook address, switched on
  if (c.token.length > 100 && name) {
    const w = await lineApi(c.token, '/v2/bot/channel/webhook/endpoint');
    const url = hookUrl(name);
    if (w.status === 200 && w.json.endpoint === url) {
      ok('LINE 的 webhook 網址已設好');
      if (w.json.active) ok('LINE 的 Use webhook 已打開'); else { no('LINE 的 Use webhook 還沒打開'); want('use-webhook'); }
    } else { no('LINE 的 webhook 網址還沒設成 ' + url); want('webhook'); }
  }
  if (bind) want(bind);
  console.log('NEXT: ' + (next || 'done'));
}

async function edit() {
  if (!readConf()) { writeConf({ channelSecret: '', channelToken: '' }); console.log('建立了 ' + L.CONF); }
  else console.log('已經有 ' + L.CONF + '（打開它，沒有改內容）');
  const opener = process.platform === 'win32' ? ['notepad.exe', [L.CONF]] : process.platform === 'darwin' ? ['open', ['-t', L.CONF]] : ['xdg-open', [L.CONF]];
  try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); console.log('已用文字編輯器打開。'); } catch (e) { console.log('打不開編輯器，請自己打開這個檔案：' + L.CONF); }
}

function claim() {
  const c = readConf() || {};
  if (c.userId) { console.log('已經綁定了（' + String(c.userId).slice(0, 5) + '…）。要換人，先把 line.json 裡的 userId 刪掉再打一次。'); return; }
  c.claimCode = String(crypto.randomInt(100000, 1000000)); c.claimUntil = Date.now() + 10 * 60000;
  writeConf(c);
  console.log('CODE: ' + c.claimCode);
  console.log('有效到 ' + new Date(c.claimUntil).toLocaleTimeString('zh-TW', { hour12: false }) + '（10 分鐘）。在 LINE 把這 6 個數字傳給你的官方帳號，第一個傳的人就是小秘書之後唯一會回的人。期間傳了 5 則不是這組碼的訊息，這組碼就作廢，要再打一次 claim。');
  console.log('（小秘書要在跑、Funnel 和 webhook 要設好、Use webhook 要打開，它才收得到）');
}

async function funnel() {
  const r = await ts(['funnel', '--bg', '--https=' + FUNNEL_PORT, 'http://127.0.0.1:' + L.PORT], 20000);
  console.log(r.out.trim());
  if (/not enabled/i.test(r.out)) console.log('NEED: 打開上面那個網址、登入 Tailscale 按啟用，再打一次。');
}

async function webhook() {
  const c = L.loadConfig(), name = await tsName();
  if (!name) return console.log('Tailscale 沒有登入，不知道網址');
  const url = hookUrl(name);
  const s = await lineApi(c.token, '/v2/bot/channel/webhook/endpoint', 'PUT', { endpoint: url });
  console.log('設定 webhook 網址：' + (s.status === 200 ? '好了 ' + url : '失敗 ' + s.status + ' ' + (s.json.message || '')));
  // LINE's own test, a few times: a Funnel just switched on takes a little while to reach (measured 2026-11-19: about 30 s)
  for (let k = 0; k < 6; k++) {
    const t = await lineApi(c.token, '/v2/bot/channel/webhook/test', 'POST', { endpoint: url });
    if (t.json.success) { console.log('LINE 連線測試：成功（' + t.json.statusCode + '）'); break; }
    console.log('LINE 連線測試：' + (t.json.reason || t.status) + ' ' + (t.json.detail || '') + (k < 5 ? '，20 秒後再試' : ''));
    if (k < 5) await new Promise((r) => setTimeout(r, 20000));
  }
  const w = await lineApi(c.token, '/v2/bot/channel/webhook/endpoint');
  console.log('Use webhook：' + (w.json.active ? '已打開' : '還沒打開（LINE Developers → 你的 channel → Messaging API → Webhook settings → Use webhook）'));
}

async function start() {
  if (await listening(L.PORT) === 404) return console.log('小秘書已經在聽了');
  const child = spawn(process.execPath, [path.join(__dirname, 'line-bot.js')], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  await new Promise((r) => setTimeout(r, 1500));
  console.log(await listening(L.PORT) === 404 ? '小秘書啟動了（pid ' + child.pid + '）。看板下次重開時會由看板自己帶起它' : '沒有啟動成功：跑 node "' + path.join(__dirname, 'line-bot.js') + '" 看錯誤');
}

async function off() { const r = await ts(['funnel', '--https=' + FUNNEL_PORT, 'off']); console.log(r.out.trim() || 'Funnel ' + FUNNEL_PORT + ' 已關閉'); }

({ status, edit, claim, funnel, webhook, start, off }[cmd] || (() => { console.log('不認得的指令：' + cmd); process.exitCode = 2; }))();
