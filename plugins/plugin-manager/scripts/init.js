#!/usr/bin/env node
/**
 * init.js — 首次使用 plugin-manager 的一鍵初始化。
 *
 * 為什麼需要：plugin-manager 所有腳本（adopt、bump-version、publish-status、
 *   publish-finalize、register-external、upgrade-check）都靠家目錄
 *   ~/.claude/plugin-manager/config.json 定位 monorepo。
 *   新人剛 clone 你的 repo 時這個 config 還不存在，所有指令會 die('找不到 config.json')。
 *   本腳本把 config（+ registry）建好，讓新人能開始用。
 *
 * 做法（純檔案操作）：
 *   1. 算出 monorepo 路徑：優先用參數，否則從本腳本位置回推（scripts → plugin-manager
 *      → plugins → monorepo，上三層）。
 *   2. 把 config.template.json 複製到 ~/.claude/plugin-manager/config.json，填入 owner/monorepo/repo。
 *   3. 確保 ~/.claude/plugin-manager/registry.json 存在（不存在則用 registry.template 建空的）。
 *   4. 確保 monorepo 內 recommends.json 存在（不存在則用 recommends.template 建空的）。
 *   5. 已存在的檔「不覆蓋」（避免洗掉既有狀態），改為提示。
 *
 * 用法：node init.js <owner> <repo> [monorepoPath]
 *   owner        : 你的 owner 名（會寫進 plugin author 等）
 *   repo         : GitHub repo，格式 owner/name（如 abs1294/fulin-claude-plugins）
 *   monorepoPath : （可選）monorepo 絕對路徑；省略則自動偵測（本腳本所在的 repo）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const owner = process.argv[2];
const repo = process.argv[3];
let mono = process.argv[4];

if (!owner || !repo) die('用法：node init.js <owner> <repo> [monorepoPath]（如 node init.js fulin abs1294/fulin-claude-plugins）');

// monorepo 路徑：參數優先，否則從本腳本位置回推（__dirname = .../plugins/plugin-manager/scripts）。
if (!mono) {
  mono = path.resolve(__dirname, '..', '..', '..'); // scripts → plugin-manager → plugins → monorepo 根
}
if (!fs.existsSync(path.join(mono, '.claude-plugin', 'marketplace.json'))) {
  die('推定的 monorepo 路徑看起來不對（找不到 .claude-plugin/marketplace.json）：' + mono +
      '\n  請用第三個參數明確指定 monorepo 絕對路徑。');
}

const PM_DIR = path.join(os.homedir(), '.claude', 'plugin-manager');
fs.mkdirSync(PM_DIR, { recursive: true });

const configPath = path.join(PM_DIR, 'config.json');
const registryPath = path.join(PM_DIR, 'registry.json');
const recommendsPath = path.join(mono, 'plugins', 'plugin-manager', 'recommends.json');

console.log('== plugin-manager init ==');
console.log('  owner    : ' + owner);
console.log('  repo     : ' + repo);
console.log('  monorepo : ' + mono);
console.log('');

// 1. config.json（已存在不覆蓋）
if (fs.existsSync(configPath)) {
  console.log('• config.json 已存在，跳過（不覆蓋既有設定）：' + configPath);
} else {
  const config = { owner: owner, monorepo: mono, repo: repo, defaultBranch: 'main' };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('✓ 已建 config.json：' + configPath);
}

// 2. registry.json（已存在不覆蓋；不存在建空的）
if (fs.existsSync(registryPath)) {
  console.log('• registry.json 已存在，跳過（保留既有 selfMade 狀態）。');
} else {
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, selfMade: {} }, null, 2) + '\n');
  console.log('✓ 已建空 registry.json（你的個人本機狀態，不進 git）。');
}

// 3. recommends.json（在 monorepo 內；不存在建空的）
if (fs.existsSync(recommendsPath)) {
  console.log('• recommends.json 已存在，跳過。');
} else {
  fs.writeFileSync(recommendsPath, JSON.stringify({ schemaVersion: 1, recommends: {} }, null, 2) + '\n');
  console.log('✓ 已建空 recommends.json（外部 plugin 推薦清單，在 plugin 內、會推廣）。');
}

console.log('\n✅ 初始化完成。現在可以用 /plugin-manager:adopt、:update、:publish、/setup-plugins 了。');
