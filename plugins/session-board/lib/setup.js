'use strict';
// What this computer has of what the board works with, for its first page (asked 2026-11-28: "if I give it to others,
// what should they do, or how to use it to get the most out of it - typing /session-board lands on this page").
// Facts come in from the server (versions, what is installed, when the limits were last read); this only judges them
// and says, in the words of the person reading, what each gives and what is missing without it.
//
// -> {ready, groups: [{key, title, items: [{key, name, state, ok, gives, without, detail, action}]}]}
//   state: 'ok' | 'missing' | 'old' | 'stale' | 'off'
//   action: {kind: 'install', plugin} | {kind: 'update', plugin} | {kind: 'settings', at} | {kind: 'command', cmd, note} | null

const NODE_MIN = '22.5.0';
// Every one of these is worth having for anybody using the board; the second set is for some kinds of work.
const CORE = [
  { plugin: 'cc-statusline', min: '1.11.0', gives: '左下的額度、每個對話的花費與 context、壓縮次數、戰情室的每月用量', without: '這些地方全是空的：看板不自己算用量' },
  { plugin: 'plugin-manager', min: '', gives: '哪些 plugin 有新版、一鍵全部更新；/session-board 每次開也靠它把 plugin 更新到最新', without: '看不到有沒有新版，/session-board 也不會順便更新' },
  { plugin: 'goal2', min: '', gives: '交辦一件事讓它做到完成為止、排到額度回來再跑，做完把結果送回起它的對話（排程頁）', without: '排程頁沒有 goal 的紀錄，外掛頁沒有交辦' },
];
const MORE = [
  { plugin: 'harness', min: '', gives: '專案健檢、流程圖、待核可項目（辦公室房間）', without: '辦公室房間沒有 harness 狀態，外掛頁沒有健檢' },
  { plugin: 'qa-webwright', min: '', gives: '辦公室房間顯示那個專案最近幾次瀏覽器測試的結果', without: '房間裡看不到測試結果' },
  { plugin: 'cbm-guard', min: '', gives: '程式碼索引過期時提醒、一鍵重建', without: '房間裡不會提醒索引過期' },
  { plugin: 'deliver-report', min: '', gives: '工作日報、交付訊息', without: '外掛頁沒有日報' },
  { plugin: 'self-heal', min: '', gives: '工具呼叫失敗時自動接力', without: '工具呼叫失敗時要你自己叫它重來' },
];
// what only works for every conversation when it is installed for you (user), not for some projects: its hooks gather
// the figures of every conversation
const EVERYWHERE = new Set(['cc-statusline']);
const STALE_MS = 30 * 60 * 1000;   // the limits are read again at least every few minutes while a conversation runs

function vcmp(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0), pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
const ago = (ms) => (ms < 3600e3 ? Math.max(1, Math.round(ms / 60e3)) + ' 分鐘' : ms < 86400e3 ? Math.round(ms / 3600e3) + ' 小時' : Math.round(ms / 86400e3) + ' 天');

// f: {platform, node, claude (version or ''), terminal (bool), installed ({name: {newest}}), latest ({name: version} of
// the marketplace, may be empty), limitsAt (ms, 0 none), now, remote ({on, listening}), inbox ({gmail, slack, teams}),
// line (bool)}
function check(f) {
  const now = f.now || Date.now(), inst = f.installed || {}, latest = f.latest || {};
  const item = (o) => Object.assign({ detail: '', action: null, without: '' }, o, { ok: o.state === 'ok' });

  const need = [
    item({ key: 'node', name: 'Node.js', state: vcmp(f.node, NODE_MIN) >= 0 ? 'ok' : 'old', gives: '看板本身（要 ' + NODE_MIN.replace(/\.0$/, '') + ' 以上）', detail: f.node ? '目前 ' + f.node : '', without: '看板跑不起來' }),
    item({ key: 'claude', name: 'Claude Code', state: f.claude ? 'ok' : 'missing', gives: '看板裡的每個對話', detail: f.claude ? '目前 ' + f.claude : '找不到 claude 指令', without: '看板開不了對話' }),
    item({ key: 'terminal', name: f.platform === 'darwin' ? 'Terminal' : 'Windows Terminal', state: f.terminal ? 'ok' : 'missing', gives: '「移到終端機」、切到 session 的視窗', without: '對話只能在看板裡，不能移到終端機視窗' }),
  ];
  // updated through plugin-manager (all of them at once): without it there is no update button, it says so
  const pm = !!inst['plugin-manager'];
  const upd = (x) => (pm ? { kind: 'update', plugin: x.plugin } : null), viaPm = pm ? '' : '（先裝 plugin-manager 才能在這裡更新）';
  const plug = (x) => {
    const have = inst[x.plugin], newest = latest[x.plugin] || '';
    const base = { key: x.plugin, name: x.plugin, gives: x.gives, without: x.without };
    if (!have) return item(Object.assign(base, { state: 'missing', action: { kind: 'install', plugin: x.plugin } }));
    // where it is: for you (every project), or for some projects only
    const ins = Array.isArray(have.installs) ? have.installs : [], mine = ins.some((i) => i.scope === 'user'), projects = ins.filter((i) => i.project).length;
    const where = mine || !ins.length ? '' : '只裝在 ' + projects + ' 個專案';
    // where it is first: one that works for every conversation only when it is yours, not yours - installed for you, whatever
    // its version (an update would leave it where it was)
    if (where && EVERYWHERE.has(x.plugin)) return item(Object.assign(base, { state: 'stale', detail: where + '：其他專案的對話不會有這些數字', action: { kind: 'install', plugin: x.plugin } }));
    if (x.min && vcmp(have.newest, x.min) < 0) return item(Object.assign(base, { state: 'old', detail: '目前 ' + have.newest + '，要 ' + x.min + ' 以上' + viaPm, action: upd(x) }));
    if (newest && vcmp(have.newest, newest) < 0) return item(Object.assign(base, { state: 'old', detail: '目前 ' + have.newest + '，有新版 ' + newest + viaPm, action: upd(x) }));
    return item(Object.assign(base, { state: 'ok', detail: [have.newest ? '目前 ' + have.newest : '', where].filter(Boolean).join('，') }));
  };
  const core = CORE.map(plug);
  // cc-statusline there but its figures not coming in: as good as missing for what it gives
  const cs = core.find((x) => x.key === 'cc-statusline');
  if (cs && cs.state === 'ok') {
    if (!f.limitsAt) Object.assign(cs, { state: 'stale', ok: false, detail: '裝了，但還沒有額度資料：跟任何一個對話說一句話，它回完就會出現' });
    else if (now - f.limitsAt > STALE_MS) Object.assign(cs, { state: 'stale', ok: false, detail: '額度資料 ' + ago(now - f.limitsAt) + '前更新的：沒有對話在跑時不會更新；按左下的 ↻ 可以馬上重查' });
  }
  const more = MORE.map(plug);

  const r = f.remote || {}, ib = f.inbox || {};
  const connect = [
    item({ key: 'phone', name: '手機（Tailscale）', state: !r.on ? 'off' : r.listening ? 'ok' : 'stale', gives: '在手機上看對話、核准、回答，不在電腦前也能放行', detail: !r.on ? '' : r.listening ? '' : '設定已開，但 Tailscale 還沒連上（電腦要開著、Tailscale 要登入）', action: r.on && r.listening ? null : { kind: 'settings', at: 'remote' } }),
    item({ key: 'inbox', name: '收件（Gmail、Slack、Teams）', state: ib.gmail || ib.slack || ib.teams ? 'ok' : 'off', gives: '信和訊息判讀成「要你處理的」，帶著附檔派進對的專案', detail: ['Gmail', 'Slack', 'Teams'].filter((k) => ib[k.toLowerCase()]).join('、') ? '已接：' + ['Gmail', 'Slack', 'Teams'].filter((k) => ib[k.toLowerCase()]).join('、') : '', action: ib.gmail || ib.slack || ib.teams ? null : { kind: 'settings', at: 'inbox' } }),
    item({ key: 'line', name: 'LINE 小秘書', state: f.line ? 'ok' : 'off', gives: '上班日早上用 LINE 告訴你今天要做什麼、還有什麼沒做', action: f.line ? null : { kind: 'command', cmd: '/session-board:line', note: '在任何一個對話打這個指令，照它的步驟接上' } }),
  ];
  const groups = [
    { key: 'need', title: '必要', items: need },
    { key: 'core', title: '每個人都該裝的 plugin', items: core },
    { key: 'more', title: '看工作需要的 plugin', items: more },
    { key: 'connect', title: '可以接上的', items: connect },
  ];
  // ready: what everybody needs is there (the ones for some kinds of work, and the connections, are a choice)
  return { ready: need.every((x) => x.ok) && core.every((x) => x.ok), groups };
}

module.exports = { check, vcmp, CORE, MORE, NODE_MIN, STALE_MS };
