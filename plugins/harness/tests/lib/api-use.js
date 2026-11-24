#!/usr/bin/env node
// /harness:review 的「專案有沒有呼叫 Claude API」腳本（skills/review/scripts/api-use.js）回歸測試。夾具全是合成的。
//
// 用法：node plugins/harness/tests/lib/api-use.js   → 每項印一行 `PASS|FAIL <項目>｜<證據>`，有 FAIL 時 exit 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'skills', 'review', 'scripts', 'api-use.js');
let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}｜${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'api-use-'));
let n = 0;
// files: {相對路徑: 內容} → {code, out, json}
function scan(files, o = {}) {
  const d = path.join(W, 'p' + (++n)); fs.mkdirSync(d);
  for (const [f, t] of Object.entries(files)) { const p = path.join(d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }
  if (o.git) { spawnSync('git', ['init', '-q'], { cwd: d }); }
  const j = path.join(W, 'o' + n + '.json'), r = spawnSync(process.execPath, [SCRIPT, d, '--out', j], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, json: fs.existsSync(j) ? JSON.parse(fs.readFileSync(j, 'utf8')) : null };
}
try {
  // 每一種真的呼叫都認得，出處指到那一行
  const YES = [
    ['a.ts', "import Anthropic from '@anthropic-ai/sdk';"], ['a.js', "const { query } = require(\"@anthropic-ai/claude-agent-sdk\");"], ['a.mjs', "const m = await import('@anthropic-ai/bedrock-sdk');"],
    ['a.py', 'import anthropic'], ['b.py', 'from anthropic import Anthropic'], ['c.py', '    from anthropic.types import Message'], ['d.py', 'from claude_agent_sdk import query'],
    ['n.ipynb', '   "import anthropic\\n",'], ['A.cs', 'using Anthropic.Models.Messages;'], ['A.java', 'import com.anthropic.client.AnthropicClient;'], ['a.go', '\t"github.com/anthropics/anthropic-sdk-go"'],
    ['a.rb', "require 'anthropic'"], ['a.php', 'use Anthropic\\Client;'], ['e.py', 'from langchain_anthropic import ChatAnthropic'], ['b.ts', "import { anthropic } from '@ai-sdk/anthropic';"],
    ['B.cs', 'var url = "https://api.anthropic.com/v1/messages";'], ['a.sh', 'curl https://api.anthropic.com/v1/messages -d @x'], ['f.py', 'MODEL = "us.anthropic.claude-opus-5-5-v1:0"'], ['g.py', 'p = f"publishers/anthropic/models/{m}:rawPredict"'],
  ];
  for (const [f, line] of YES) { const r = scan({ [f]: 'x\n' + line + '\n' }); check(r.code === 0 && r.json.uses && r.json.calls[0].at === f + ':2', '認得 ' + f, line); }
  // 只寫主機名、同一行多個 import、把長提示詞寫在一行
  const MORE = [['h.js', "https.request({ hostname: 'api.anthropic.com', path: '/v1/messages' })"], ['h.py', 'c = http.client.HTTPSConnection("api.anthropic.com")'], ['k.ts', "const HOST = 'https://api.anthropic.com';"], ['k2.ts', 'const BASE = "https://api.anthropic.com/v1";'], ['i.py', 'import os, anthropic'], ['t.py', 'try: import anthropic'], ['s.py', 'from claude_agent_sdk.types import X'], ['s2.py', 'import anthropic as a'], ['v.vb', 'Imports Anthropic.Models'], ['p.php', 'use Anthropic;'], ['p2.php', '$c = \\Anthropic::client($k);'], ['one.ipynb', '{"cells":[{"source":["# x\\n","import anthropic\\n"]}]}']];
  MORE.push(['vx.py', 'MODEL = "claude-opus-5@20260101"'], ['ll.py', 'litellm.completion(model="vertex_ai/claude-sonnet-5@20260101")'], ['ll2.py', 'm = "bedrock/us.anthropic.claude-opus-5-5-v1:0"'], ['or.ts', "const m = 'openrouter/anthropic/claude-opus-5';"]);
  for (const [f, line] of MORE) { const r = scan({ [f]: 'x\n' + line + '\n' }); check(r.code === 0 && r.json.uses && r.json.calls[0].at === f + ':2', '認得 ' + f, line); }
  { const r = scan({ 'long.py': 'import anthropic\nP = "' + '提示詞'.repeat(900) + '"\n' }); check(r.json.uses && r.json.skipped === 0, '提示詞寫在一行不會整檔跳過', r.json.notes); }
  { const r = scan({ 'u16.cs': '' }); const d = fs.mkdtempSync(path.join(W, 'u')); fs.writeFileSync(path.join(d, 'a.cs'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('using Anthropic;\n', 'utf16le')])); const z = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' }); check(r.code === 0 && /有，1 處/.test(z.stdout), 'UTF-16 的檔', z.stdout.trim().split('\n')[0]); }
  // 沒看的檔要講出來，不能當成沒有呼叫
  { const r = scan({ 'huge.js': "require('@anthropic-ai/sdk')\n" + 'a;\n'.repeat(400000), 'bundle.js': ("require('@anthropic-ai/sdk');" + 'a'.repeat(3000) + '\n').repeat(10) }); check(!r.json.uses && r.json.skipped === 2 && /沒看的檔 2 個.*huge\.js（超過 1 MB）/.test(r.json.notes.join()), '太大、壓縮過的列在 notes', r.json.notes); }
  { const d = fs.mkdtempSync(path.join(W, 'o')), z = spawnSync(process.execPath, [SCRIPT, d, '--out', path.join(d, 'a', 'b', 'c.json')], { encoding: 'utf8' }); check(z.status === 0 && fs.existsSync(path.join(d, 'a', 'b', 'c.json')), '--out 的上層目錄自己建', z.status); }
  // 不是呼叫的都不算
  const NO = [
    ['README.md', 'import anthropic'], ['a.py', '# import anthropic'], ['a.js', "// import x from '@anthropic-ai/sdk'"], ['b.js', "/**\n * https://api.anthropic.com/v1/messages\n */"], ['lib.min.js', "require('@anthropic-ai/sdk')"], ['u.js', "fetch('https://api.anthropic.com/api/oauth/usage')"], ['c.vue', "<!--\n https://api.anthropic.com/v1/messages\n-->"], ['m.js', "spawn('claude', ['-p', '--model', 'claude-opus-5-5'])"], ['bc.js', "/*\n require('@anthropic-ai/sdk')\n*/"], ['ds.py', '"""\nimport anthropic\n"""'], ['ds1.py', '"""import anthropic"""'],
    ['node_modules/x/i.js', "require('@anthropic-ai/sdk')"], ['.claude/hooks/h.js', "require('@anthropic-ai/sdk')"], ['vendor/a.php', 'use Anthropic\\Client;'], ['c.py', 'text = "we use anthropic and claude"'], ['d.py', 'import anthropic_utils_of_mine'],
    ['e.sh', 'claude -p "做這件事"'], ['C.cs', 'using AnthropicWrapper;'], ['v.js', "const s = 'anthropic';"], ['g.js', "fetch('https://api.openai.com/v1/messages')"], ['n.ipynb', '   "# import anthropic\\n",'],
  ];
  for (const [f, line] of NO) { const r = scan({ [f]: line + '\n', 'ok.py': 'print(1)\n' }); check(r.code === 0 && r.json.uses === false && !r.json.declaredOnly, '不算 ' + f, line.slice(0, 60)); }
  // 提示詞常數（三引號開在行中、結尾在行首）後面的程式照常看；字串裡面寫到的不算
  { const P = 'SYSTEM = """\n你是助手。\nimport anthropic\n"""\n', f2 = "def f():\n    import anthropic\n"; const r = scan({ 'p.py': P + f2 }); check(r.json.callsTotal === 1 && r.json.calls[0].at === 'p.py:6', '三引號常數之後的程式照常看、裡面的不算', r.json.calls);
    const r2 = scan({ 'q.py': 'x = f"""a""" + "b"\nimport anthropic\n' }); check(r2.json.callsTotal === 1 && r2.json.calls[0].at === 'q.py:2', '同一行開又關', r2.json.calls);
    const r3 = scan({ 'q.py': 's = "it\'s # not"\nimport anthropic  # """ in a comment\nrequests.post("https://api.anthropic.com/v1/messages")\n' }); check(r3.json.callsTotal === 2, '註解與單引號字串裡的三引號不算開始', r3.json.calls);
    const r4 = scan({ 'q.py': 'class A:\n    """doc\n    import anthropic\n    """\n    def f(self): pass\n' }); check(!r4.json.uses, 'docstring 裡面不算', r4.json.calls); }
  { const r = scan({ 'c.js': "/* a */ import A from '@anthropic-ai/sdk'\n" }); check(r.json.uses, '行首註解後面的程式照常看', r.json.calls); }
  // 註解在哪裡都不算、字串裡的註解樣子不是註解
  for (const [f, text, n] of [
    ['m.js', "const a = 1; /* import x from '@anthropic-ai/sdk'\n fetch('https://api.anthropic.com/v1/messages') */ const b = 2;\n", 0],
    ['m2.js', "const a = 1; // fetch('https://api.anthropic.com/v1/messages')\n", 0],
    ['p.php', "<?php\n/* use Anthropic\\Client; */\n# use Anthropic\\Client;\n// use Anthropic\\Client;\n$x = 1; /*\nuse Anthropic\\Client;\n*/\n", 0],
    ['p2.php', "<?php\n#[Attr]\nuse Anthropic\\Client;\n", 1],
    ['s.ts', "const u = 'https://api.anthropic.com/v1/messages'; // x\nconst g = \"a /* b\"; import A from '@anthropic-ai/sdk';\n", 2],
    ['t.ts', "const p = `見 // 這裡 /*`;\nimport A from '@anthropic-ai/sdk';\n", 1],
    ['r.js', "const q = /['\"]/; // it's\nimport A from '@anthropic-ai/sdk';\n", 1],
    ['c.cs', "var u = \"https://api.anthropic.com/v1/messages\"; /* using Anthropic; */\n", 1],
    ['v.vue', "<template>\n  <p>it's <!-- https://api.anthropic.com/v1/messages --> ok</p>\n</template>\n", 0],
    ['e.js', "const re = /^\\/*$/, r2 = /[/*]/, r3 = /x\\//; import('@anthropic-ai/sdk');\n", 1],
    ['.js', "import A from '@anthropic-ai/sdk';\n", 1],
    ['x.js', "const re = /[^/*]+/;\nimport A from '@anthropic-ai/sdk';\n/** doc */\n", 1],
    ['x.vue', "<input accept=image/*>\n<script>\nimport A from '@anthropic-ai/sdk';\n</script>\n<style>\n/* a */\n</style>\n", 1],
    ['x.cs', "var a = @\"C:\\a\\\"; var b = \"/*\";\nusing Anthropic;\n/* a */\n", 1],
    ['o.js', "const x = 1; /* 沒有關\nimport A from '@anthropic-ai/sdk';\n", 1],
    ['q.js', "/* a */ /* import A from '@anthropic-ai/sdk' */\n/*\n*/ import A from '@anthropic-ai/sdk';\n", 1],
    ['d.py', 'X = """\nuse \\""" to quote\nimport anthropic\n"""\nimport anthropic\n', 1],
    ['l.py', 'X = """沒有關\nimport anthropic\n', 1],
    ['w.ts', "const a = `x ${b} https://a/*`; // '`\nimport A from '@anthropic-ai/sdk'; // */\n", 1],
    ['g.go', "import (\n\t\"github.com/anthropics/anthropic-sdk-go\" // sdk\n)\n", 1],
  ]) { const r = scan({ [f]: text }); check(r.json.callsTotal === n, '註解與字串 ' + f, r.json.calls); }
  // 裡面另有 git repo（沒追蹤的、submodule）的也要看
  { const d = path.join(W, 'nest'); fs.mkdirSync(path.join(d, 'svc', 'in'), { recursive: true }); fs.writeFileSync(path.join(d, 'ok.js'), '1\n'); fs.writeFileSync(path.join(d, 'svc', 'a.py'), 'import anthropic\n'); fs.writeFileSync(path.join(d, 'svc', 'in', 'b.py'), 'import anthropic\n'); for (const x of [d, path.join(d, 'svc'), path.join(d, 'svc', 'in')]) spawnSync('git', ['init', '-q'], { cwd: x });
    const z = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' }); check(/有，2 處/.test(z.stdout) && /svc\/a\.py:1/.test(z.stdout) && /svc\/in\/b\.py:1/.test(z.stdout), '巢狀的 git repo', z.stdout.trim()); }
  // 每一種看的語言：行尾註解、區塊註解不算，字串裡的算（CODE 的副檔名一個都不能少）
    {
      const src = fs.readFileSync(SCRIPT, 'utf8'), exts = /const CODE = \/\\\.\(([^)]*)\)/.exec(src)[1].split('|');
      const U = 'https://api.anthropic.com/v1/messages', L = { '#': 'py rb sh bash ps1 r ex exs php', '//': 'js mjs cjs jsx ts mts cts tsx vue svelte cs java kt kts scala go rs swift dart php fs', '--': 'lua', "'": 'vb' };
      const B = { py: ['"""', '"""'], rb: ['=begin', '=end'], ps1: ['<#', '#>'], lua: ['--[[', ']]'], vue: ['<!--', '-->'], svelte: ['<!--', '-->'], php: ['/*', '*/'], fs: ['(*', '*)'] };
      check(exts.length > 25, 'CODE 清單讀得到', exts.length);
      for (const e of exts.filter((x) => x !== 'ipynb')) {
        const marks = Object.keys(L).filter((m) => L[m].split(' ').includes(e)), bl = B[e] || (marks.includes('//') ? ['/*', '*/'] : null);
        const r = scan({ ['f.' + e]: marks.map((m) => 'x = 1 ' + m + ' "' + U + '"\n').join('') + (bl ? bl[0] + '\n"' + U + '"\n' + bl[1] + '\n' : '') + 'y = "' + U + '"\n' });
        check(marks.length > 0 && r.json.callsTotal === 1, '每種語言 .' + e, [marks, r.json.calls]);
      }
      { const r = scan({ 'n.ipynb': JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1 # ' + U + '\n', 'y = "' + U + '"\n'] }] }, null, 1) }); check(r.json.callsTotal === 1, '每種語言 .ipynb', r.json.calls); }
      { const r = scan({ 'h.sh': 'curl "${u#x}" "' + U + '"\necho a#b; curl ' + U + '\n' }); check(r.json.callsTotal === 2, 'shell 的 # 在字中間不是註解', r.json.calls); }
      { const r = scan({ 'o.fs': 'let f = (*)\nlet u = "' + U + '"\n(* a *)\n' }); check(r.json.callsTotal === 1, 'F# 的 (*) 不是註解', r.json.calls); }
    }
    { const t0 = Date.now(), r = scan({ 'many.js': ' /* x\n'.repeat(120000) + "import A from '@anthropic-ai/sdk';\n" }); check(r.json.callsTotal === 1 && Date.now() - t0 < 8000, '很多沒關的區塊註解不會拖慢', Date.now() - t0); }
    { const z = spawnSync(process.execPath, [SCRIPT, W, '--out', W], { encoding: 'utf8' }); check(z.status === 2 && /寫不進/.test(z.stderr), '--out 指到資料夾', z.stderr); }
    // 連結（檔案、資料夾、Windows 的 junction）指到專案外的不讀；指到專案內、本身沒列到的檔照看；同一個檔只算一次
    {
      const d = path.join(W, 'ln'), o = path.join(W, 'outside'); fs.mkdirSync(path.join(d, 'skip'), { recursive: true }); fs.mkdirSync(o);
      fs.writeFileSync(path.join(o, 'x.py'), 'import anthropic\n'); fs.writeFileSync(path.join(d, 'skip', 'y.py'), 'import anthropic\n'); fs.writeFileSync(path.join(d, 'a.py'), 'import anthropic\n'); fs.writeFileSync(path.join(d, '.gitignore'), 'skip/\n');
      fs.symlinkSync(o, path.join(d, 'junc'), 'junction');
      let files = true; try { fs.symlinkSync(path.join(o, 'x.py'), path.join(d, 'out.py')); fs.symlinkSync(path.join(d, 'skip', 'y.py'), path.join(d, 'in.py')); fs.symlinkSync(path.join(d, 'a.py'), path.join(d, 'twice.py')); } catch { files = false; console.log('略過｜這台不能建檔案連結，只測資料夾連結'); }
      spawnSync('git', ['init', '-q'], { cwd: d });
      let z = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' }); check(new RegExp('有，' + (files ? 2 : 1) + ' 處').test(z.stdout), '連結：git 專案', z.stdout.trim());
      fs.rmSync(path.join(d, '.git'), { recursive: true, force: true });
      z = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' }); check(/有，2 處/.test(z.stdout) && !/junc|out\.py/.test(z.stdout), '連結：不是 git 的專案', z.stdout.trim());
      fs.rmSync(path.join(d, 'junc'), { recursive: false, force: true });
    }
    {
      const d = path.join(W, 'ln2'); for (const x of ['src', 'e2e', '.claude/skills/s', '.agents']) fs.mkdirSync(path.join(d, x), { recursive: true });
      fs.writeFileSync(path.join(d, 'src', 'client.py'), 'import anthropic\n'); fs.writeFileSync(path.join(d, '.claude', 'skills', 's', 'x.py'), 'import anthropic\n');
      fs.symlinkSync(path.join(d, 'src'), path.join(d, 'e2e', 'tests'), 'junction'); fs.symlinkSync(path.join(d, '.claude', 'skills'), path.join(d, '.agents', 'skills'), 'junction');
      spawnSync('git', ['init', '-q'], { cwd: d });
      const z = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' }); check(/有，1 處/.test(z.stdout), '連結到的程式看實際位置（不當成測試、.claude/ 照樣不看）', z.stdout.trim());
      for (const x of ['e2e/tests', '.agents/skills']) fs.rmSync(path.join(d, x), { recursive: false, force: true });
    }
    // 太深的 git repo、讀不到的目錄：寫進注意事項，不當掉
    { let d = path.join(W, 'deep'); const top = d; fs.mkdirSync(d); spawnSync('git', ['init', '-q'], { cwd: d }); for (let i = 0; i < 7; i++) { d = path.join(d, 'n'); fs.mkdirSync(d); spawnSync('git', ['init', '-q'], { cwd: d }); fs.writeFileSync(path.join(d, 'a.py'), 'import anthropic\n'); }
      const z = spawnSync(process.execPath, [SCRIPT, top], { encoding: 'utf8' }); check(z.status === 0 && /有，5 處/.test(z.stdout) && /太深的 git repo 沒有看/.test(z.stdout), '太深的 git repo', z.stderr.slice(0, 200) + z.stdout.trim()); }
    { const d = path.join(W, 'noread'), x = path.join(d, 'x'); fs.mkdirSync(x, { recursive: true }); fs.writeFileSync(path.join(d, 'a.py'), 'import anthropic\n');
      const pre = path.join(W, 'pre.js'); fs.writeFileSync(pre, "const fs = require('fs'), o = fs.readdirSync; fs.readdirSync = (p, ...a) => { if (String(p).endsWith(require('path').sep + 'x')) throw Object.assign(new Error('no'), { code: 'EACCES' }); return o(p, ...a); };");
      const z = spawnSync(process.execPath, ['-r', pre, SCRIPT, d], { encoding: 'utf8' }); check(z.status === 0 && /有，1 處/.test(z.stdout) && /讀不到目錄：x/.test(z.stdout), '讀不到的目錄', z.stderr.slice(0, 200) + z.stdout.trim()); }
    // 各語言的引用寫法，一種一個檔
    for (const [e, text] of [
      ['py', 'import anthropic.types'], ['py', 'import anthropic.types as t'], ['py', 'import anthropic as a'], ['py', 'from anthropic.types import X'], ['py', 'import os, anthropic'], ['py', 'import os, anthropic.types'],
      ['py', '    import anthropic'], ['py', 'import os; import anthropic'], ['py', 'if x: import anthropic'], ['py', 'from anthropic import ('], ['py', "a = importlib.import_module('anthropic')"], ['py', "a = __import__('anthropic')"], ['py', 'from anthropic import AsyncAnthropic, Anthropic'], ['py', 'import claude_agent_sdk'], ['py', 'from langchain_anthropic import ChatAnthropic'], ['py', 'import langchain_anthropic'], ['py', 'from llama_index.llms.anthropic import Anthropic'], ['py', 'from pydantic_ai.models.anthropic import AnthropicModel'],
      ['ts', "import A from '@anthropic-ai/sdk'"], ['ts', "import type { M } from '@anthropic-ai/sdk/resources'"], ['ts', "export * from '@anthropic-ai/sdk'"], ['ts', "const a = await import('@anthropic-ai/sdk')"], ['ts', 'const a = await import(`@anthropic-ai/sdk`)'], ['ts', "import A = require('@anthropic-ai/sdk')"], ['js', "require ('@anthropic-ai/sdk')"], ['ts', "} from '@anthropic-ai/sdk';"], ['ts', "import '@anthropic-ai/sdk/shims/node'"], ['ts', "import { createAnthropic } from '@ai-sdk/anthropic'"], ['ts', "import { x } from '@langchain/anthropic'"], ['ts', "import A from'@anthropic-ai/sdk'"], 
      ['cs', 'using Anthropic;'], ['cs', 'using Anthropic.Models;'], ['cs', 'global using Anthropic;'], ['cs', 'using A = Anthropic.AnthropicClient;'], ['cs', 'var c = new Anthropic.AnthropicClient();'], ['cs', 'using Anthropic.SDK;'],
      ['java', 'import com.anthropic.client.AnthropicClient;'], ['java', 'import static com.anthropic.x.Y;'], ['kt', 'import com.anthropic.client.okhttp.AnthropicOkHttpClient'], ['java', 'com.anthropic.client.X c = null;'], ['scala', 'import com.anthropic.client._'],
      ['go', '\t"github.com/anthropics/anthropic-sdk-go"'], ['go', 'import a "github.com/anthropics/anthropic-sdk-go/option"'],
      ['rb', 'require "anthropic"'], ['rb', "require 'anthropic'"], ['rb', 'client = Anthropic::Client.new'],
      ['php', 'use Anthropic\\Client;'], ['php', 'use Anthropic;'], ['php', '$c = new \\Anthropic\\Client();'], ['php', '$c = Anthropic::client($k);'], ['php', 'use Anthropic\\{Client, X};'],
      ['vb', 'Imports Anthropic'], ['vb', 'Imports Anthropic.Models'], ['fs', 'open Anthropic'], ['rs', 'use anthropic_sdk::Client;'], ['rs', 'use anthropic::client::Client;'], ['dart', "import 'package:anthropic_sdk_dart/anthropic_sdk_dart.dart';"], ['swift', 'import SwiftAnthropic'], ['ex', 'alias Anthropix'], ['r', 'library(anthropic)'],
        ]) { const r = scan({ ['f.' + e]: text + '\n' }); check(r.json.callsTotal === 1, '引用寫法 .' + e + ' ' + text, r.json.calls); }
    for (const [e, text] of [['ts', "jest.mock('@anthropic-ai/sdk')"], ['py', "x = 'import anthropic'"], ['py', 'import anthropic_helper'], ['cs', 'var x = new Anthropical.Foo();'], ['java', '// com.anthropic.x'], ['java', 'String s = "com.anthropic.x";'], ['rb', 'MyAnthropic::Client.new'], ['php', 'use MyAnthropic\\Client;'], ['rs', 'use anthropical::x;'], ['ts', "const s = \"from the team\""]]) { const r = scan({ ['f.' + e]: text + '\n' }); check(r.json.callsTotal === 0, '不是引用 .' + e + ' ' + text, r.json.calls); }
    { const r = scan({ 'bin/cli.js': "require('@anthropic-ai/sdk')\n" }), z = scan({ 'bin/x.cs': 'using Anthropic;\n', 'a.csproj': '<Project/>' }); check(r.json.callsTotal === 1 && z.json.callsTotal === 0, '不是 git 的專案：bin/ 是程式，.NET 的 bin/ 是產物', [r.json.calls, z.json.calls]); }
    check(!JSON.stringify(scan({ 'a.py': 'import anthropic\n' }).json).includes(path.basename(W)), '輸出不含絕對路徑', '');
    // 沒初始化的 submodule（空目錄、git 列成 ./）：照一般目錄走，不遞迴、不報太深
    { const d = path.join(W, 'sub'); fs.mkdirSync(path.join(d, 'libs', 'sub'), { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: d });
      const g = spawnSync('git', ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,libs/sub'], { cwd: d, encoding: 'utf8' });
      fs.writeFileSync(path.join(d, 'libs', 'sub', 'z.py'), 'import anthropic\n');
      const z = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' }); check(g.status === 0 && /有，1 處/.test(z.stdout) && /libs\/sub\/z\.py:1/.test(z.stdout) && !/太深/.test(z.stdout), '沒初始化的 submodule', g.stderr + z.stdout.trim()); }
    // 只有宣告：另列，不算有呼叫；有引用時就是有
  for (const [f, t] of [['package.json', '{\n "dependencies": {\n  "@anthropic-ai/sdk": "^1"\n }\n}'], ['requirements.txt', 'flask\nanthropic>=0.40\n'], ['pyproject.toml', 'dependencies = [\n "anthropic",\n]'], ['x.csproj', '<PackageReference Include="Anthropic" Version="1.0" />'], ['go.mod', 'require github.com/anthropics/anthropic-sdk-go v1.0.0']]) { const r = scan({ [f]: t }); check(r.json.uses === false && r.json.declaredOnly && /只有宣告/.test(r.out), '只有宣告 ' + f, r.json.declared); }
  { const r = scan({ 'requirements.txt': 'anthropic-helper-of-mine\nmisanthropic\n# anthropic\n' }); check(!r.json.declaredOnly, '名字像的套件、註解不算宣告', r.json.declared); }
  { const r = scan({ 'package.json': '{"dependencies":{"@anthropic-ai/sdk":"1"}}', 'src/a.js': "import A from '@anthropic-ai/sdk'\n" }); check(r.json.uses && !r.json.declaredOnly, '宣告又引用＝有呼叫', r.json.calls); }
  for (const f of ['MyApp.Tests/ClientTests.cs', 'src/ClientTests.cs', 'a/FooTest.java']) { const r = scan({ [f]: f.endsWith('cs') ? 'using Anthropic;\n' : 'import com.anthropic.client.X;\n' }); check(!r.json.uses && r.json.testsOnly, '只有測試裡用到 ' + f, r.json.testsTotal); }
  { const r = scan({ 'src/Latest.cs': 'using Anthropic;\n' }); check(r.json.uses, '名字剛好以 test 結尾的不是測試', r.json.calls); }
  for (const f of ['tests/a.py', 'src/__tests__/a.ts', 'a.spec.ts', 'test_a.py']) { const r = scan({ [f]: f.endsWith('py') ? 'import anthropic\n' : "import A from '@anthropic-ai/sdk'\n" }); check(!r.json.uses && r.json.testsOnly && /只有測試/.test(r.out), '只有測試裡用到 ' + f, r.json.testsTotal); }
  { const r = scan({ 'packages/api/a.ts': "import A from '@anthropic-ai/sdk'\n", 'bin/b.js': "require('@anthropic-ai/sdk')\n" }, { git: true }), z = scan({ 'packages/api/a.ts': "import A from '@anthropic-ai/sdk'\n", 'bin/b.js': "require('@anthropic-ai/sdk')\n" }); check(r.json.callsTotal === 2 && z.json.callsTotal === 2, 'packages/、bin/ 是程式', [r.json.callsTotal, z.json.callsTotal]); }
  // git 專案：被忽略的不看，還沒加入的要看；列不完的寫明還有幾處；輸出不含程式原文
  { const r = scan({ '.gitignore': 'skip/\n', 'skip/a.py': 'import anthropic\n', 'b.py': 'import anthropic  # secret-text\n' }, { git: true }); check(r.json.callsTotal === 1 && r.json.calls[0].at === 'b.py:1' && !/secret-text/.test(r.out + JSON.stringify(r.json)), 'git 忽略的不看、還沒加入的要看、不抄原文', r.json.calls); }
  { const r = scan({ 'a.py': 'import anthropic\n'.repeat(40) }); check(r.json.callsTotal === 40 && r.json.calls.length === 30 && /還有 10 處沒列/.test(r.out), '超過 30 處寫明還有幾處', r.json.callsTotal); }
  { const r = scan({ 'sub/中文 名.py': 'import anthropic\r\n' }, { git: true }); check(r.json.uses && r.json.calls[0].at === 'sub/中文 名.py:1', '中文與空白檔名', r.json.calls); }
  { const r = scan({}); check(r.code === 0 && r.json.uses === false, '空專案', r.out.trim()); }
  { const r = spawnSync(process.execPath, [SCRIPT, path.join(W, 'none')], { encoding: 'utf8' }), z = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }); check(r.status === 2 && z.status === 2, '目錄不存在、沒給目錄：exit 2', [r.status, z.status]); }
} finally { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* 留著不影響 */ } }
console.log(`合計 PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
