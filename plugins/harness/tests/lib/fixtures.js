'use strict';
// 四個最小範例專案（B6 fixtures）：每次在暫存目錄現做，不把 .git 目錄提交進 repo。
//   single-web ：單一 repo＋網頁前端（vite＋react、有測試指令、會寄信）
//   multi-repo ：多 repo 工作區（根目錄不是 repo，web／api 兩個子 repo）
//   non-git    ：非 git 專案（純 Python 資料處理，沒有前端）
//   reference  ：已有 Claude Code 設定（CLAUDE.md、自己的 agent、hook、settings）——init 的參考模式
// 用法：const { makeFixture } = require('./fixtures'); makeFixture('single-web', <空目錄>)
//       node fixtures.js <種類> <目錄>   （端到端測試手動建一份用）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content.replace(/\r\n/g, '\n'), 'utf8');
  }
}
function gitInit(dir) {
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'core.autocrlf', 'false');
  g('add', '-A');
  g('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'init', '--allow-empty');
}

const WEB_APP = {
  'package.json': JSON.stringify({
    name: 'shipping-portal', private: true, type: 'module',
    scripts: { dev: 'vite', build: 'vite build', test: 'node --test tests/' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', nodemailer: '^6.9.0' },
    devDependencies: { vite: '^5.4.0' },
  }, null, 2) + '\n',
  'README.md': '# 出貨入口網站\n\n給倉管人員建立與追蹤出貨單的內部網站。出貨單送出後會呼叫物流商 API 建單，並寄信通知收件人。\n\n- 開發：`npm run dev`\n- 測試：`npm test`\n- 建置：`npm run build`\n\n## 業務流程\n\n- S1 建立出貨單：倉管填單 → 送出 → 呼叫物流商建單\n- S2 出貨通知：建單成功後寄信給收件人\n- S3 退貨（尚未開始）\n',
  'index.html': '<!doctype html>\n<html lang="zh-Hant">\n<head><meta charset="utf-8"><title>出貨入口</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n',
  'vite.config.js': "import { defineConfig } from 'vite';\nexport default defineConfig({ server: { port: 5173 } });\n",
  'src/main.jsx': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  'src/App.jsx': "import React, { useState } from 'react';\nimport { createShipment } from './api.js';\nexport function App() {\n  const [no, setNo] = useState('');\n  return <form onSubmit={async (e) => { e.preventDefault(); setNo(await createShipment({})); }}><button>送出出貨單</button>{no && <p>單號 {no}</p>}</form>;\n}\n",
  'src/api.js': "// 物流商 API：建單（寫入對方系統）\nconst CARRIER_URL = process.env.CARRIER_URL || 'https://api.carrier.example.test/v1';\nexport async function createShipment(order) {\n  const r = await fetch(CARRIER_URL + '/shipments', { method: 'POST', body: JSON.stringify(order) });\n  return (await r.json()).shipmentNo;\n}\n",
  'src/mail.js': "// 出貨通知信\nimport nodemailer from 'nodemailer';\nexport function notify(to, no) {\n  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 587 });\n  return t.sendMail({ to, subject: '出貨通知 ' + no, text: '您的貨已出貨' });\n}\n",
  'tests/shipment.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('單號格式', () => { assert.match('SH-0001', /^SH-\\d{4}$/); });\n",
  '.env.example': 'CARRIER_URL=https://api.carrier.example.test/v1\nSMTP_HOST=localhost\n',
  '.gitignore': 'node_modules/\ndist/\n.env\n',
};

const KINDS = {
  'single-web': (root) => { write(root, WEB_APP); gitInit(root); },
  'multi-repo': (root) => {
    const web = {};
    for (const [k, v] of Object.entries(WEB_APP)) if (!k.startsWith('src/api') && !k.startsWith('src/mail')) web[k] = v;
    write(path.join(root, 'web'), web);
    write(path.join(root, 'api'), {
      'package.json': JSON.stringify({ name: 'shipping-api', private: true, scripts: { start: 'node server.js', test: 'node --test test/' }, dependencies: { express: '^4.19.0', pg: '^8.12.0' } }, null, 2) + '\n',
      'server.js': "const express = require('express');\nconst app = express();\n// 物流商狀態回呼（對方打進來）\napp.post('/webhook/carrier', (req, res) => res.sendStatus(204));\napp.listen(process.env.PORT || 3000);\n",
      'db.js': "const { Pool } = require('pg');\nmodule.exports = new Pool({ connectionString: process.env.DATABASE_URL });\n",
      'migrations/001_init.sql': 'CREATE TABLE shipment (id serial primary key, no text not null);\n',
      'test/health.test.js': "const { test } = require('node:test');\ntest('ok', () => {});\n",
      '.gitignore': 'node_modules/\n.env\n',
    });
    write(root, { 'README.md': '# 出貨系統工作區\n\n- web：倉管用的網頁\n- api：後端與資料庫\n' });
    gitInit(path.join(root, 'web'));
    gitInit(path.join(root, 'api'));
  },
  'non-git': (root) => {
    write(root, {
      'pyproject.toml': '[project]\nname = "sales-report"\nversion = "0.1.0"\ndependencies = ["pandas"]\n',
      'README.md': '# 月報產生器\n\n讀銷售明細 CSV，產出每月業績報表（Excel）。人工下載 CSV 後放進 input/。\n',
      'src/report.py': 'import pandas as pd\n\ndef build(path):\n    return pd.read_csv(path).groupby("month").sum()\n',
      'input/.keep': '',
    });
  },
  'reference': (root) => {
    write(root, WEB_APP);
    write(root, {
      'CLAUDE.md': '# 專案說明\n\n- 測試：`npm test`\n- 不准改 `vite.config.js` 的 port（前端與 QA 腳本都寫死 5173）\n- 部署前要先跑 smoke test\n- 改完直接 commit\n',
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: 程式碼審查\nmodel: sonnet\n---\n審查時要看：寄信相關改動一定要確認收件人來自設定，不能寫死。\n',
      '.claude/hooks/block-prod-db.js': "#!/usr/bin/env node\n// 擋連正式資料庫\nconst i = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');\nconst c = String((i.tool_input || {}).command || '');\nif (/prod-db\\.example\\.test/.test(c)) { console.error('不准連正式庫'); process.exit(2); }\n",
      '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/block-prod-db.js' }] }] }, permissions: { allow: ['Bash(npm test)'] } }, null, 2) + '\n',
      'CONTEXT.md': '# CONTEXT — 出貨入口\n\n## 詞彙\n\n**出貨單**\n倉管建立、送到物流商的一筆出貨。\n_避免_：訂單（客戶下的單，一張訂單可拆多張出貨單）——混了會把拆單當成重複建單\n',
    });
    gitInit(root);
  },
};

function makeFixture(kind, root) {
  if (!KINDS[kind]) throw new Error('不認得的 fixture：' + kind);
  fs.mkdirSync(root, { recursive: true });
  KINDS[kind](root);
  return root;
}

module.exports = { makeFixture, KINDS: Object.keys(KINDS) };

if (require.main === module) {
  const [kind, dir] = process.argv.slice(2);
  if (!kind || !dir) { console.error('用法：node fixtures.js <' + Object.keys(KINDS).join('|') + '> <目錄>'); process.exit(2); }
  makeFixture(kind, path.resolve(dir));
  console.log('已建立 ' + kind + '：' + path.resolve(dir));
}
