// goal2 共用模組：讀 ~/.claude/goal2/config.json（引擎與兩個 skill 的設定）。
// 放家目錄的理由：plugin 以 /plugin install 安裝時檔案在 cache 目錄，重裝會被清掉；家目錄不會。
//
// 結構（所有欄位選填，沒寫的用預設）：
//   {
//     "engine":     { "permissionMode": "bypassPermissions", "stopHookBlockCap": 0, "model": null, "autocompact": "auto" },
//     "goal":       { "confirmTimeoutMinutes": 0 },
//     "delaylocal": { "confirmTimeoutMinutes": 10, "bufferSeconds": 900 }
//   }
//   engine.permissionMode            子程序 claude -p 的 --permission-mode（無人值守建議 bypassPermissions）
//   engine.stopHookBlockCap          CLAUDE_CODE_STOP_HOOK_BLOCK_CAP：/goal 引擎本質是 Stop hook，連續 N 次擋停後
//                                    Claude Code 會強制結束回合（預設 8）；0 = 不設上限，做到達成為止
//   engine.model                     子程序用的模型（null = 沿用預設）
//   engine.autocompact               子程序的 --autocompact：'auto' 或 100000–1000000（tokens）的整數。
//                                    長任務想讓壓縮晚一點發生就調大；壓縮後的錨定另有 anchor.md / progress.md / hook 三層
//   goal.confirmTimeoutMinutes       propose 後等使用者確認的分鐘數；0（預設）= 不等，propose 完直接啟動引擎（隨時可 --stop）；
//                                    ≥1 = 排確認 timer，逾時自動採納啟動
//   delaylocal.confirmTimeoutMinutes propose 後等使用者確認的逾時分鐘數；逾時後自動採納並排任務
//   delaylocal.bufferSeconds         quota 重置時間之後再等幾秒才 fire（CLI 裸數字可覆蓋）
//
// 檔案不存在 → 全用預設。存在但 JSON 壞掉 / 型別錯 / 未知欄位 → throw（呼叫端 fail()），
// 刻意不靜默退回預設：打錯字沒人發現比報錯更糟。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const GOAL2_HOME = path.join(os.homedir(), '.claude', 'goal2');
const CONFIG_PATH = path.join(GOAL2_HOME, 'config.json');
const RUNS_DIR = path.join(GOAL2_HOME, 'runs');
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'];

const DEFAULTS = {
  engine: { permissionMode: 'bypassPermissions', stopHookBlockCap: 0, model: null, autocompact: 'auto' },
  goal: { confirmTimeoutMinutes: 0 },
  delaylocal: { confirmTimeoutMinutes: 10, bufferSeconds: 900 }
};

// 每個欄位的驗證器：回 null 表示合法，否則回錯誤描述
const VALIDATORS = {
  'engine.permissionMode': (v) => (PERMISSION_MODES.includes(v) ? null : `需為 ${PERMISSION_MODES.join(' | ')} 其中之一`),
  'engine.stopHookBlockCap': (v) => (Number.isInteger(v) && v >= 0 ? null : '需為 ≥0 的整數（0 = 不設上限）'),
  'engine.model': (v) => (v === null || (typeof v === 'string' && v.trim()) ? null : '需為模型名稱字串或 null'),
  'engine.autocompact': (v) => (v === 'auto' || (Number.isInteger(v) && v >= 100000 && v <= 1000000) ? null : "需為 'auto' 或 100000–1000000 的整數（tokens）"),
  'goal.confirmTimeoutMinutes': (v) => (Number.isInteger(v) && v >= 0 ? null : '需為 ≥0 的整數（0 = 不等確認，propose 後直接啟動）'),
  'delaylocal.confirmTimeoutMinutes': (v) => (Number.isInteger(v) && v >= 1 ? null : '需為 ≥1 的整數'),
  'delaylocal.bufferSeconds': (v) => (Number.isInteger(v) && v >= 1 ? null : '需為 ≥1 的整數')
};

function clone() {
  return {
    engine: { ...DEFAULTS.engine },
    goal: { ...DEFAULTS.goal },
    delaylocal: { ...DEFAULTS.delaylocal }
  };
}

/** @returns {{ config: ReturnType<typeof clone>, loaded: boolean, path: string }} */
function loadConfig() {
  const config = clone();
  if (!fs.existsSync(CONFIG_PATH)) return { config, loaded: false, path: CONFIG_PATH };

  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { throw new Error(`設定檔 ${CONFIG_PATH} 不是合法 JSON：${e.message}。修好或刪掉它（刪掉即全用預設）。`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`設定檔 ${CONFIG_PATH} 頂層必須是物件。`);

  const unknownTop = Object.keys(raw).filter((k) => !(k in DEFAULTS) && k !== '_comment');
  if (unknownTop.length) throw new Error(`設定檔 ${CONFIG_PATH} 有未知頂層欄位：${unknownTop.join(', ')}（可用：${Object.keys(DEFAULTS).join(', ')}）。`);

  for (const section of Object.keys(DEFAULTS)) {
    if (raw[section] === undefined) continue;
    const sec = raw[section];
    if (sec === null || typeof sec !== 'object' || Array.isArray(sec)) throw new Error(`設定檔 ${CONFIG_PATH} 的 ${section} 必須是物件。`);
    const unknown = Object.keys(sec).filter((k) => !(k in DEFAULTS[section]) && k !== '_comment');
    if (unknown.length) throw new Error(`設定檔 ${CONFIG_PATH} 的 ${section} 有未知欄位：${unknown.join(', ')}（可用：${Object.keys(DEFAULTS[section]).join(', ')}）。`);
    for (const k of Object.keys(DEFAULTS[section])) {
      if (sec[k] === undefined) continue;
      const err = VALIDATORS[`${section}.${k}`](sec[k]);
      if (err) throw new Error(`設定檔 ${CONFIG_PATH} 的 ${section}.${k} ${err}（收到：${JSON.stringify(sec[k])}）。`);
      config[section][k] = sec[k];
    }
  }
  return { config, loaded: true, path: CONFIG_PATH };
}

module.exports = { loadConfig, CONFIG_PATH, GOAL2_HOME, RUNS_DIR, DEFAULTS, PERMISSION_MODES };
