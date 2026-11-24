// 額度重置時間：delaylocal 算「quota 重置後幾點跑」用。
//
// 資料來源只有一個：cc-statusline（>= 1.9.0）在背景向 Claude Code 查到的帳號額度，
// 存在 ~/.claude/cc-statusline/state/account-limits.json：{ at, five_hour, seven_day, tried, none }
//   at          毫秒，Claude Code 回答這組數字的時間
//   five_hour／seven_day  { used_percentage, resets_at（秒） } 或 null（帳號沒有這個視窗）
//   none        true：帳號完全沒有額度限制（例如 API key）
//   v           介面版本（1.9.0 起；沒有 v＝太舊）。視窗的 resets_at 固定是「秒的數字或 null」：
//               視窗為 null＝帳號沒有這個額度；resets_at 為 null＝有這個額度、目前沒在計時
// 不再讀 ~/.claude/rate-limit-snapshots.json：那是「各終端機 session 最後一次被告知的數字」，
// 會每 30 秒用新的時間重寫舊數字（2026-11-24 實例：顯示 3%，官網 34%），沒有終端機的對話根本不寫。
//
// 使用者裁定（2026-11-24，看板合作 #1）：
//   1. 帳號沒有 5 小時視窗（five_hour 為 null）→ 改等 7 天額度的重置時間。
//   2. 沒裝 cc-statusline（或版本太舊）→ 擋下並提示安裝，不退回直接讀 rate-limit-snapshots.json。
// 裁定沒講到的兩種情況照「擋下並說明」處理：帳號沒有額度限制（none）、兩個視窗都查不到。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_INTERFACE = 1;     // account-limits.json 的介面版本 v（cc-statusline 1.9.0 起有；欄位只加不改，所以 v 更大也認）
const STALE_WARN_MIN = 60;   // 額度資料超過這麼多分鐘沒更新就附警告（resets_at 是絕對時間，仍可用，只是更可能已變動）

const stateFile = (home) => path.join(home, '.claude', 'cc-statusline', 'state', 'account-limits.json');

const INSTALL_HINT = '需要 cc-statusline 1.9.0 以上（額度檔帶 v 欄的版本）：\n'
  + '  沒裝：claude plugin install cc-statusline@fulin-plugins --scope user\n'
  + '  已裝舊版：claude plugin update cc-statusline@fulin-plugins --scope user，然後重開 Claude Code\n'
  + '  裝好後在對話裡送一則訊息（它在每次回答結束時查一次額度，5 分鐘內不重複，約 2 秒、不花 token），再重跑本指令。';

const block = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });

// 視窗現在的狀態：none（帳號沒有這個額度）、idle（有、沒在計時）、running、over（時間已過）、''（不認得，含超過 8 天以後的）
function stateOf(w, now) {
  if (w === null || w === undefined) return 'none';
  if (typeof w !== 'object' || typeof w.used_percentage !== 'number') return '';
  if (w.resets_at === null) return 'idle';
  if (typeof w.resets_at !== 'number' || w.resets_at - now > 8 * 86400) return '';
  return w.resets_at > now ? 'running' : 'over';
}

// → { ok:true, base, window, limits_at, limits_age_minutes, warning?, source } | { ok:false, code, message }
function resolveQuota(opts) {
  const home = (opts && opts.home) || os.homedir();
  const now = (opts && opts.now) || Math.floor(Date.now() / 1000);
  const file = stateFile(home);

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    const why = e && e.code === 'ENOENT'
      ? '找不到額度檔：這台沒有裝 cc-statusline、版本太舊，或已裝但還沒查過額度'
      : `讀不了額度檔（${e && e.message}）`;
    return block('cc-statusline-missing', `${why}。\n${INSTALL_HINT}`, { source_file: file });
  }
  let s;
  try { s = JSON.parse(raw); } catch (e) { return block('limits-unreadable', `額度檔不是合法 JSON（${e.message}）：${file}\n${INSTALL_HINT}`, { source_file: file }); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return block('limits-unreadable', `額度檔格式不認得：${file}\n${INSTALL_HINT}`, { source_file: file });

  // 版本看檔案自己的 v（介面版本）：沒有 v＝舊版或開發時手動跑出來的殘留。舊版不會更新這個檔，檔案在也不能信
  if (!(Number.isFinite(s.v) && s.v >= MIN_INTERFACE)) return block('cc-statusline-too-old', `額度檔沒有介面版本 v（舊版 cc-statusline 或殘留的舊檔），不能信。\n${INSTALL_HINT}`, { source_file: file });

  if (s.none === true) return block('no-limits', '這個帳號沒有額度限制（例如 API key），沒有「額度重置」可等。要現在就做，改用 goal skill（/goal2:goal）。剛登入的話，cc-statusline 最多一小時後才會重新查到。', { source_file: file });

  const at = Number.isFinite(s.at) && s.at > 0 && s.at <= now * 1000 + 60000 ? s.at : null;
  if (at === null) return block('limits-not-answered', 'cc-statusline 還沒有查到額度（額度檔裡沒有查詢時間）。在對話裡送一則訊息讓它查一次；剛查失敗過的話要等 5 分鐘它才會再查。', { source_file: file });
  const info = { source_file: file, limits_at: new Date(at).toISOString() };

  // 兩個視窗各是什麼狀態（跟 cc-statusline 的 account-limits.js stateOf 同一套）
  const five = stateOf(s.five_hour, now), seven = stateOf(s.seven_day, now);
  if (!five || !seven) return block('limits-unreadable', `額度檔裡的視窗格式不認得：${file}\n${INSTALL_HINT}`, info);
  const ageMin = Math.max(0, Math.round((now * 1000 - at) / 60000));
  const warnings = [];
  const W = { five_hour: { w: s.five_hour, st: five, word: '5 小時' }, seven_day: { w: s.seven_day, st: seven, word: '7 天' } };
  const says = (x) => x.st === 'running' || x.st === 'idle', full = (x) => says(x) && x.w.used_percentage >= 100;
  if (five === 'none' && seven === 'none') return block('no-window', '查到了額度，但 5 小時與 7 天兩個視窗都沒有，算不出重置時間。可能是 Claude Code 版本不回這個欄位；稍後再試。', info);

  // 看哪一個：7 天用完了看 7 天（5 小時重置了也跑不動）；否則有 5 小時看 5 小時，沒有就看 7 天（裁定 1）
  let win = full(W.seven_day) || five === 'none' ? 'seven_day' : 'five_hour';
  const it = W[win], other = W[win === 'seven_day' ? 'five_hour' : 'seven_day'];
  if (win === 'seven_day' && full(it)) warnings.push('7 天額度已經用完，等它重置才跑得動（可能是好幾天後）。');
  // 它的狀態：在計時→等到重置；用完卻不知何時重置→擋；沒在計時、或時間剛過→不用等，但要是一天內查的（更舊的不知道現在如何）→否則擋
  let base = now, idle = false;
  if (it.st === 'running') {
    base = it.w.resets_at;
    if (win === 'seven_day' && full(it) && other.st === 'running' && other.w.resets_at > base) { base = other.w.resets_at; win = 'five_hour'; warnings[0] = '7 天額度已經用完，不過它比 5 小時額度先重置，等 5 小時的。'; }
    else if (win === 'seven_day' && !full(it)) warnings.push('這個帳號目前沒有 5 小時額度視窗，已改等 7 天額度的重置時間（可能是好幾天後才會跑）。');
  } else if (full(it)) return block('no-window', `${it.word}額度已用完，但查不到何時重置，算不出重置時間。稍後再試。`, info);
  else if (ageMin < 24 * 60) {
    idle = true;
    warnings.push(`這個帳號的 ${it.word}額度目前沒有在計時（沒用到，或已經重置了），不用等，會在緩衝時間之後就跑。`);
  } else return block('limits-stale', `額度資料是 ${ageMin} 分鐘前查的，太舊了，不知道現在的額度。cc-statusline 在每次回答結束時才查：這一輪回答完再重跑一次就有；還是這樣的話是它沒在更新（停用或移除了？）。\n${INSTALL_HINT}`, info);
  if (ageMin > STALE_WARN_MIN) warnings.push(`額度資料是 ${ageMin} 分鐘前查的` + (idle ? '，現在的情況可能不同。' : '；重置時間是絕對時間通常仍可信，但可能已變動。'));
  return { ok: true, base, window: win, idle, limits_at: info.limits_at, limits_age_minutes: ageMin, warning: warnings.length ? warnings.join(' ') : null, source: file };
}

module.exports = { resolveQuota, stateOf, MIN_INTERFACE, stateFile, INSTALL_HINT };
