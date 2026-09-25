/**
 * test-gate-pretool.mjs — 六支 PreToolUse 閘的回歸案例（由 test-gate.mjs 匯入執行；開發期，不進 plugin 執行路徑）。
 *
 * 每支閘都涵蓋：無參數檔完全靜默、規則段未設靜默、違規被擋（訊息斷言）、合規放行、fail-open。
 * 全部在 os.tmpdir() 底下建假專案，跑完整批刪除；子程序環境拿掉 CLAUDE_PROJECT_DIR，避免找到真專案的參數檔。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD = path.join(HERE, '..', 'skills', 'browser-qa', 'SKILL.md');

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  delete env.CLAUDE_PROJECT_DIR;
  for (const k of ['APP_TENANT', 'I18N_DIR', 'FRONT_ROOT', 'ASPNETCORE_ENVIRONMENT', 'QA_APP_ENV', 'QA_WEBWRIGHT_NAV_STATE']) delete env[k];
  return Object.assign(env, extra || {});
}

function runHook(file, payload, env) {
  const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync('node', [path.join(HERE, file)], { input: stdin, encoding: 'utf8', env: cleanEnv(env), timeout: 60000 });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  if (r.status === 0 && out === '' && err === '') return { tag: 'ALLOW', msg: '' };
  if (r.status === 0 && out !== '') {
    try {
      const j = JSON.parse(out);
      const h = j.hookSpecificOutput || {};
      if (h.permissionDecision === 'deny') return { tag: 'DENY', msg: String(h.permissionDecisionReason || '') };
      return { tag: 'OTHER', msg: out };
    } catch (_) {
      return { tag: 'BADJSON', msg: out };
    }
  }
  return { tag: 'EXIT' + r.status, msg: err || out };
}

function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 1));
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失敗：' + r.stderr);
}

function extractBlock(md, name) {
  const m = new RegExp('<!-- ' + name + ':begin -->\\s*```text\\r?\\n([\\s\\S]*?)```\\s*<!-- ' + name + ':end -->').exec(md);
  return m ? m[1].replace(/\r\n/g, '\n') : null;
}

export function runPreToolCases(TMP) {
  const root = fs.mkdtempSync(path.join(TMP, 'pretool-'));
  let n = 0;
  const mkProj = (cfg) => {
    const dir = path.join(root, 'p' + (n++));
    fs.mkdirSync(path.join(dir, 'tests', 'e2e'), { recursive: true });
    if (cfg !== undefined) {
      const f = path.join(dir, 'tests', 'e2e', 'qa-webwright.json');
      if (typeof cfg === 'string') fs.writeFileSync(f, cfg);
      else writeJson(f, cfg);
    }
    return dir;
  };
  const cases = []; // [名稱, hook, payload, 期望, 斷言?, env?]
  const add = (name, hook, payload, expected, check, env) => cases.push([name, hook, payload, expected, check, env]);

  // =====================================================================
  // 1. guard-qa-dispatch.js
  // =====================================================================
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const TEMPLATE = extractBlock(md, 'qa-dispatch-template');
  const EXAMPLE = extractBlock(md, 'qa-dispatch-example');
  const tags = (s) => (String(s).match(/【[^】]+】/g) || []).join('');
  const QD = 'guard-qa-dispatch.js';
  const dp = mkProj({ dispatch_gate: {} });
  const dpRead = mkProj({ dispatch_gate: { required_reading: ['tests/Project_Detail/PROJECT.md', 'docs/never-exists.md'] } });
  fs.mkdirSync(path.join(dpRead, 'tests', 'Project_Detail'), { recursive: true });
  fs.writeFileSync(path.join(dpRead, 'tests', 'Project_Detail', 'PROJECT.md'), '# x\n');
  const dpNoCfg = mkProj();
  const dpNoSec = mkProj({ hook: { enabled: true } });
  const dpOff = mkProj({ dispatch_gate: { enabled: false } });
  const dpHookOff = mkProj({ dispatch_gate: {}, hook: { enabled: false } });
  const dpBroken = mkProj('{ not json');
  const dpCustom = mkProj({ dispatch_gate: { checks: ['no_relay'], custom_checks: [{ label: '回報兩次', regex: '回報主對話[\\s\\S]*回報主對話', message: '回報指示頭尾各寫一次' }] } });
  const dpAlign = mkProj({ dispatch_gate: { checks: ['alignment', 'scope_expansion'] } });
  const dpUp = mkProj({ dispatch_gate: { params: { data_source: {
    option_words: { A: '走|真實', B: '例外|自種', C: '依賴|字典' }, reason_required_for: ['B', 'C'] } } } });
  const dpOldReason = mkProj({ dispatch_gate: { params: { data_source: { reason_regex: '字典' } } } });
  const dpKw = mkProj({ dispatch_gate: {}, external_system_keywords: { vendor_callback: ['ACME 回傳'] } });
  const disp = (cwd, prompt, type) => ({ cwd, tool_name: 'Agent', tool_input: { subagent_type: type || 'qa-webwright:qa-engineer', prompt } });
  const ex = (from, to) => String(EXAMPLE).replace(from, to);
  const DS_LINE = /【測試資料來源】[^\n]*/;

  add('dispatch 範本與範例的格子一致（照範本填＝範例）', null, null, 'CHECK', () => TEMPLATE && EXAMPLE && tags(TEMPLATE) === tags(EXAMPLE) && tags(TEMPLATE).length > 0);
  add('dispatch 無參數檔→靜默', QD, disp(dpNoCfg, 'hi'), 'ALLOW');
  add('dispatch 參數檔沒有 dispatch_gate 段→靜默', QD, disp(dpNoSec, 'hi'), 'ALLOW');
  add('dispatch 非 qa-engineer→靜默', QD, disp(dp, 'hi', 'general-purpose'), 'ALLOW');
  add('dispatch 缺多項→一次全列 8 項', QD, disp(dp, '請測購物車'), 'DENY',
    (m) => /8 項未過/.test(m) && ['[增量分流]', '[目標環境]', '[測試資料來源]', '[範圍外發現必報]', '[親自執行]',
      '[開工前對齊]', '[範圍展開]', '[欄位級驗證]'].every((t) => m.includes(t)) && /完整清單/.test(m));
  add('dispatch 照 SKILL 範例填的派工單→放行', QD, disp(dp, EXAMPLE), 'ALLOW');
  add('dispatch 照 SKILL 範本原樣（未填）→擋且列出未明選／空白', QD, disp(dp, TEMPLATE), 'DENY',
    (m) => /增量分流·未明選/.test(m) && /目標環境·空白/.test(m) && /測試資料來源·未明選/.test(m));
  add('dispatch a/b/c 照抄選單→未明選', QD, disp(dp, ex(DS_LINE, '【測試資料來源】三選一：a 走真實業務流程／b 自種自清／c 依賴既有資料')), 'DENY',
    (m) => /測試資料來源·未明選/.test(m) && /1 項未過/.test(m));
  add('dispatch 英文句子裡的冠詞 a 不算明選', QD, disp(dp, ex(DS_LINE, '【測試資料來源】This is a test using existing rows.')), 'DENY',
    (m) => /測試資料來源·未明選/.test(m));
  // b＝封閉例外：只認「點名外部系統類別＋附產品端證據（檔名:行號）」，不判推託詞（白名單）
  for (const t of ['選 b', '選 b，理由：產品沒有入口', '選 b，理由：真流程成本過高', '選 b，理由：走真實流程要跑三個畫面，太麻煩',
    '選 b，理由：直接 INSERT mock 資料比較快', '選 b，理由：callback 寫起來省事',
    '選 b，理由：<哪一類外部系統邊界>，證據：<檔名:行號>',
    '選 b，理由：<哪一類（外部簽核回呼／上游推送）<舉例>>']) {
    add('dispatch b 「' + t + '」→非例外', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'DENY', (m) => /測試資料來源·非例外/.test(m));
  }
  for (const t of ['選 b，理由：外部簽核回呼寫入，產品端沒有入口', '選 b，理由：上游推送 webhook 產生（見 api/Webhook.cs）',
    '選 b，理由：目錄服務，證據：http://ldap.example.com:389']) {
    add('dispatch b 「' + t + '」→缺證據', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'DENY', (m) => /測試資料來源·缺證據/.test(m));
  }
  for (const t of ['選 b，理由：外部簽核回呼寫入，證據：src/Approval/CallbackHandler.cs:200',
    '選 b。理由：訂單由上游系統推送，證據：api/OrderWebhookController.cs:45',
    '選 b，理由：這三種資料只由外部簽核回呼寫入，證據：src/Approval/CallbackHandler.cs:200',
    '選 b，理由：只能走例外，上游推送 webhook 產生，證據：sync/push_handler.py:12',
    '選 b，理由：目錄服務，不管多麻煩都走不到，證據：src/directory/sync.ts:88',
    '選 b，理由：外部簽核回呼；a 雖然不論成本仍走不到，證據：src/Approval/CallbackHandler.cs:200',
    '選 b，理由：不能用 a，該狀態只由外部簽核回呼產生，證據：src/Approval/CallbackHandler.cs:200']) {
    add('dispatch b 「' + t + '」→放行', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'ALLOW');
  }
  add('dispatch b 已知取捨：點名類別＋證據後不再判推託詞（推託講法無限多，黑名單會誤擋）', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：外部主檔 mock，而且比較快，證據：src/Master/MockMaster.cs:30')), 'ALLOW');
  add('dispatch 選 b，理由命中參數檔 external_system_keywords 的專案詞＋證據→放行', QD,
    disp(dpKw, ex(DS_LINE, '【測試資料來源】選 b，理由：前置狀態只由 ACME 回傳產生，證據：src/acme/receiver.js:17')), 'ALLOW');
  add('dispatch 選 c 沒附理由→缺理由', QD, disp(dp, ex(DS_LINE, '【測試資料來源】選 c')), 'DENY', (m) => /測試資料來源·缺理由/.test(m) && !/未明選/.test(m));
  // 第十輪：選項由「第一個子句」決定，理由裡提到的其他字母不看——否定詞清單永遠補不完（沒辦法／不太能／改選…）
  for (const [t, want] of [
    ['選 b，理由：沒辦法用 a，外部簽核回呼產生，證據：src/Approval/CallbackHandler.cs:200', 'ALLOW'],
    ['選 a，沒辦法選 b', 'ALLOW'],
    ['選 c，理由：國別字典，沒辦法用 b', 'ALLOW'],
    ['選 b，理由：不太能用 a，外部簽核回呼產生，證據：src/Approval/CallbackHandler.cs:200', 'ALLOW'],
    ['選 b，理由：原本想走 a、改成 b，外部簽核回呼，證據：src/Approval/CallbackHandler.cs:200', 'ALLOW'],
    ['選擇：a', 'ALLOW'],
    ['選 b，理由：外部簽核回呼，證據：src/Approval/CallbackHandler.cs：200', 'ALLOW'],
    ['選 b，理由：外部簽核回呼，證據：src/Approval/CallbackHandler.cs#L200', 'ALLOW'],
    ['選 b，理由：外部簽核回呼，證據：簽核/回呼處理.cs:12', 'ALLOW'],
    ['照 a 案處理', 'DENY'],
  ]) {
    add('dispatch R10 「' + t + '」→' + want, QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), want,
      want === 'DENY' ? (m) => /測試資料來源·未明選/.test(m) : null);
  }
  // 第十二輪：理由與證據只看「作答段」（第一行起到空行，或到 a./b./c.／（／⛔ 開頭的說明行為止）——
  // 專案範本在同一格下方附了 a/b/c 說明與禁止清單，裡面有外部系統字眼與「檔名:行號」，不得拿來頂替作答
  const DEFS = '\na. **走真實業務流程長出來**（首選）：從實際入口操作產生資料\nb. **封閉例外**：只限外部系統邊界，例如外部簽核回呼的核決結果（src/Approval/CallbackHandler.cs:200）\nc. **依賴既有資料**：僅限字典／設定類\n⛔ **絕對禁止**：硬編業務資料列的數字 Id（src/Legacy/SeedLoader.cs:286）';
  add('dispatch R12 範本說明段不得頂替作答：選 b，理由：比較快＋下方說明段→非例外', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：比較快' + DEFS)), 'DENY', (m) => /測試資料來源·非例外/.test(m));
  add('dispatch R12 範本說明段不得頂替作答：選 b，理由：<…> 未填＋說明段→非例外', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：<…>' + DEFS)), 'DENY', (m) => /測試資料來源·非例外/.test(m));
  add('dispatch R12 範本說明段不得頂替作答：選 c，理由：<…> 未填＋說明段→缺理由', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 c，理由：<…>' + DEFS)), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  add('dispatch R12 選 c，理由：（空白）→缺理由', QD, disp(dp, ex(DS_LINE, '【測試資料來源】選 c，理由：')), 'DENY',
    (m) => /測試資料來源·缺理由/.test(m));
  add('dispatch R12 作答段可多行：證據另起一行→放行', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：外部簽核回呼\n證據：src/Approval/CallbackHandler.cs:200' + DEFS)), 'ALLOW');
  add('dispatch R12 作答後接範本說明段、作答本身合格→放行', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：外部簽核回呼，證據：src/Approval/CallbackHandler.cs:200' + DEFS)), 'ALLOW');
  for (const t of ['1. 選 a', '：選 a，理由：UI 能造', '1) 選 a']) {
    add('dispatch R12 「' + t + '」→放行（編號與標籤後冒號不算作答內容）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'ALLOW');
  }
  // 第十三輪：說明行帶 Markdown 前綴（- a.／> ⛔）也要截斷；待補類佔位不算理由；全形數字編號也剝
  add('dispatch R13 說明行帶「- 」前綴也截斷：選 b，理由：比較快＋「- a. 外部簽核回呼…證據」→非例外', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：比較快\n- a. 外部簽核回呼的核決結果（src/Approval/CallbackHandler.cs:200）')), 'DENY',
    (m) => /測試資料來源·非例外/.test(m));
  add('dispatch R13 說明行帶「> 」前綴也截斷：選 c＋「> ⛔ …字典」→缺理由', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 c\n> ⛔ 業務資料不得走字典類')), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  for (const t of ['選 c，理由：待補', '選 c，理由：…', '選 c，理由：（待補）']) {
    add('dispatch R13 「' + t + '」→缺理由', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  }
  add('dispatch R13 全形數字編號「１. 選 a」→放行', QD, disp(dp, ex(DS_LINE, '【測試資料來源】１. 選 a')), 'ALLOW');
  add('dispatch R13 缺證據時訊息講明「只讀作答段」', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：外部簽核回呼\n\n證據：src/x.cs:12')), 'DENY', (m) => /缺證據/.test(m) && /作答段/.test(m));
  // 第十四輪：c 的理由只排除「整段只剩佔位」；證據檔名 a.cs 不算說明行；截斷剝前綴含冒號
  for (const t of ['選 c，理由：（國別只讀參照）', '選 c，理由：(國別只讀參照)', '選 c，理由：…國別只讀', '選 c，理由：待補充：國別只讀']) {
    add('dispatch R14 「' + t + '」→放行（有真內容）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'ALLOW');
  }
  for (const t of ['選 c，理由：TBD，之後補', '選 c，理由：tbd', '選 c，理由：（…）']) {
    add('dispatch R14 「' + t + '」→缺理由（只剩佔位）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  }
  add('dispatch R14 證據續行是 a.cs:12 這種單字母檔名→不當說明行截斷', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：外部簽核回呼\n`a.cs:12` 是寫入點')), 'ALLOW');
  add('dispatch R14 說明行以冒號開頭（：a. …證據）也截斷', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：比較快\n：a. 外部簽核回呼（src/Approval/CallbackHandler.cs:200）')), 'DENY',
    (m) => /測試資料來源·非例外/.test(m));
  // 第十五輪：c 的理由改計數判準——刪掉佔位字詞與全部空白標點後，剩下至少 2 個字才算有內容
  for (const t of ["選 c，理由：待補充","選 c，理由：待補充。","選 c，理由：待補中","選 c，理由：待補上","選 c，理由：待補齊","選 c，理由：（待補充）","選 c，理由：TBD 之後補","選 c，理由：TBD 待補","選 c，理由：TBDTBD","選 c，理由：待補 待補","選 c，理由：待補 之後","選 c，理由：… 待補","選 c，理由：（待補）（待補）","選 c，理由：TODO","選 c，理由：待確認","選 c，理由：N/A","選 c，理由：-","選 c，理由：—","選 c，理由：？","選 c，理由：??","選 c，理由：「」","選 c，理由：『待補』"]) {
    add('dispatch R15 「' + t + '」→缺理由（只剩佔位）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  }
  for (const t of ["選 c，理由：（國別）","選 c，理由：待補 國別","選 c，理由：TBD：國別只讀","選 c，理由：（國別只讀參照）","選 c，理由：待補充：國別只讀","選 c，理由：…國別只讀","選 c，理由：國別；待補證據"]) {
    add('dispatch R15 「' + t + '」→放行（有真內容）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'ALLOW');
  }
  add('dispatch R15 說明行字母緊貼英文（b.Upstream …）也截斷，不得頂替作答', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：比較快\nb.Upstream 外部簽核回呼 src/Approval/CallbackHandler.cs:200')), 'DENY',
    (m) => /測試資料來源·非例外/.test(m));
  // 第十六輪：多點檔名續行不是說明行；舊參數檔只設 reason_regex 時維持舊語意；更多佔位字詞與英文 reason 標記
  for (const f of ["c.Handler.cs:12","a.spec.ts:12","b.test.js#L5","a.razor.cs:12","c.config.json:3"]) {
    add('dispatch R16 證據續行「' + f + '」不當說明行截斷', QD,
      disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：外部簽核回呼\n' + f)), 'ALLOW');
  }
  for (const t of ['選 c，理由：OK', '選 c，理由：NA', '選 c，理由：none', '選 c，理由：同上', '選 c，理由：沒有']) {
    add('dispatch R16 「' + t + '」→缺理由', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  }
  add('dispatch R16 英文 reason 標記：選 c，reason: lookup table→放行', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 c，reason: lookup table')), 'ALLOW');
  add('dispatch R16 舊參數檔只設 reason_regex=字典：理由沒提字典→缺理由（維持舊語意）', QD,
    disp(dpOldReason, ex(DS_LINE, '【測試資料來源】選 c，理由：國別只讀')), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  add('dispatch R16 舊參數檔只設 reason_regex=字典：理由提到字典→放行', QD,
    disp(dpOldReason, ex(DS_LINE, '【測試資料來源】選 c，理由：字典表')), 'ALLOW');
  // 第十七輪 Minor：檔名含 [ ] @ + ~、.c／.h 副檔名算證據；英文佔位字詞要有字界；標記 reason 要有字界
  for (const t of ['選 b，理由：外部簽核回呼，證據：a.[id].vue:3', '選 b，理由：外部簽核回呼\nb.@scope.ts:12',
    '選 b，理由：外部簽核回呼，證據：src/pages/[slug]+page.ts:8', '選 b，理由：外部簽核回呼，證據：native/b.c:1',
    '選 b，理由：外部簽核回呼，證據：include/hook.h:20']) {
    add('dispatch R17 「' + t + '」→放行（證據格式）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'ALLOW');
  }
  for (const t of ['選 c，理由：NAS', '選 c，理由：Nav', '選 c，理由：Nana', '選 c，理由：OKR 表']) {
    add('dispatch R17 「' + t + '」→放行（英文佔位字詞要有字界）', QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), 'ALLOW');
  }
  add('dispatch R17 「選 c，reasonable」→缺理由（reason 標記要有字界）', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 c，reasonable')), 'DENY', (m) => /測試資料來源·缺理由/.test(m));
  add('dispatch R12 參數檔選項鍵用大寫：選 B 仍要過例外與證據檢查', QD,
    disp(dpUp, ex(DS_LINE, '【測試資料來源】選 B，理由：比較快')), 'DENY', (m) => /測試資料來源·非例外/.test(m));
  // 第十一輪：固定格式——第一行開頭必須是「選 X」；其餘寫法一律未明選（訊息給正確寫法）
  for (const [t, want] of [
    ['不用 a，選 b，理由：直接 INSERT 比較快', 'DENY'],
    ['沒辦法用 a，所以選 b，理由：callback 比較快', 'DENY'],
    ['本案前置可從畫面造出，選 a', 'DENY'],
    ['說明：選 a', 'DENY'],
    ['a 走真實業務流程 / b 封閉例外 / c 依賴既有', 'DENY'],
    ['a 或 b 都可以', 'DENY'],
    ['選 a 或 c', 'DENY'],
    ['選 a 和 c', 'DENY'],
    ['選 a\n選 b', 'DENY'],
    ['Option a: real business flow', 'DENY'],
    ['選a，理由：UI 能造', 'ALLOW'],
    ['選 a（走真實業務流程）', 'ALLOW'],
    ['選用 c，理由：國別字典', 'ALLOW'],
    ['- 選 a，理由：UI 能造', 'ALLOW'],
    ['\n選 a，理由：UI 能造（選項寫在下一行也可以，只要是第一個非空行）', 'ALLOW'],
  ]) {
    add('dispatch R10 「' + t + '」→' + want, QD, disp(dp, ex(DS_LINE, '【測試資料來源】' + t)), want,
      want === 'DENY' ? (m) => /測試資料來源·未明選/.test(m) : null);
  }
  add('dispatch R10 十一層巢狀佔位也剝乾淨（不能靠深層佔位湊出類別與證據）', QD,
    disp(dp, ex(DS_LINE, '【測試資料來源】選 b，理由：' + '<'.repeat(11) + '外部簽核回呼，證據：src/a.cs:1' + '>'.repeat(11))), 'DENY',
    (m) => /測試資料來源·非例外/.test(m));
  add('dispatch 範圍展開缺「狀態序列」「共用元件」→缺格', QD,
    disp(dp, ex(/【範圍展開】[^\n]*/, '【範圍展開】1 正向：加入商品；2 反向：移除最後一件')), 'DENY',
    (m) => /範圍展開·缺格/.test(m) && m.includes('狀態序列') && m.includes('共用元件'));
  add('dispatch 欄位級驗證沒寫要對什麼實值→沒對 DB', QD,
    disp(dp, ex(/【欄位級驗證】[^\n]*/, '【欄位級驗證】四個欄位都看畫面有顯示')), 'DENY', (m) => /欄位級驗證·沒對 DB/.test(m));
  add('dispatch 欄位級驗證寫到 DB 讀回→放行', QD,
    disp(dp, ex(/【欄位級驗證】[^\n]*/, '【欄位級驗證】6 個欄位送出後逐欄讀回 DB 比對')), 'ALLOW');
  add('dispatch 增量分流 reuse 沒路徑→缺路徑', QD, disp(dp, ex(/【增量分流】[^\n]*/, '【增量分流】reuse：改既有購物車案例')), 'DENY', (m) => /增量分流·缺路徑/.test(m));
  add('dispatch 增量分流 reuse＋路徑→放行', QD, disp(dp, ex(/【增量分流】[^\n]*/, '【增量分流】reuse：tests/e2e/cart/test_cart.py 加 assert')), 'ALLOW');
  add('dispatch 增量分流 新TC 沒理由→缺理由', QD, disp(dp, ex(/【增量分流】[^\n]*/, '【增量分流】新TC')), 'DENY', (m) => /增量分流·缺理由/.test(m));
  add('dispatch 必讀清單：存在的檔沒提到→擋；不存在的檔不要求', QD, disp(dpRead, ex('tests/Project_Detail/PROJECT.md', '（無）')), 'DENY',
    (m) => /必讀清單/.test(m) && m.includes('tests/Project_Detail/PROJECT.md') && !m.includes('never-exists'));
  add('dispatch 必讀清單：反斜線絕對路徑也認得', QD, disp(dpRead, ex('tests/Project_Detail/PROJECT.md', 'C:\\proj\\tests\\Project_Detail\\PROJECT.md')), 'ALLOW'); // portable-ok: 派工單內容字串（驗斜線正規化），非執行路徑
  add('dispatch dispatch_gate.enabled=false→靜默', QD, disp(dpOff, 'hi'), 'ALLOW');
  add('dispatch hook.enabled=false→靜默', QD, disp(dpHookOff, 'hi'), 'ALLOW');
  add('dispatch 參數檔壞掉→fail-open', QD, disp(dpBroken, 'hi'), 'ALLOW');
  add('dispatch stdin 非 JSON→fail-open', QD, 'not json', 'ALLOW');
  add('dispatch custom_checks 生效', QD, disp(dpCustom, '本任務由你親自執行。完成後回報主對話。'), 'DENY', (m) => /\[回報兩次\]/.test(m));
  add('dispatch 加開 alignment/scope_expansion', QD, disp(dpAlign, '【開工前對齊】無分岔：需求單一\n【範圍展開】<…>'), 'DENY',
    (m) => /\[範圍展開\]/.test(m) && !/\[開工前對齊\]/.test(m));

  // =====================================================================
  // 2. guard-qa-before-commit.js
  // =====================================================================
  const QC = 'guard-qa-before-commit.js';
  const mkRepo = (cfg, files) => {
    const dir = mkProj(cfg);
    git(dir, ['init', '-q', '.']);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    git(dir, ['add', '--'].concat(Object.keys(files)));
    return dir;
  };
  const CG = { commit_gate: { enabled: true } };
  const cBeh = mkRepo(CG, { 'src/app.js': 'x\n', 'README.md': 'x\n' });
  const cDocs = mkRepo(CG, { 'tests/e2e/cart/test_cart.py': 'x\n', 'README.md': 'x\n', 'config/app.json': '{}\n' });
  const cNoCfg = mkRepo(undefined, { 'src/app.js': 'x\n' });
  const cOff = mkRepo({ commit_gate: {} }, { 'src/app.js': 'x\n' });
  const cSed = mkRepo({ commit_gate: { enabled: true, require_sediment: true } }, { 'src/app.js': 'x\n' });
  const cExtra = mkRepo({ commit_gate: { enabled: true, extra_commands: [{ name: 'review-record', regex: 'flow\\.sh["\']?\\s+review-record\\s+("[^"]*"|\'[^\']*\'|[^\\s;&|]+)', repo_group: 1 }] } }, { 'src/app.js': 'x\n' });
  const cSub = mkRepo(CG, { 'README.md': 'x\n' });
  fs.mkdirSync(path.join(cSub, 'docs'), { recursive: true });
  const sh = (cwd, command) => ({ cwd, tool_name: 'Bash', tool_input: { command } });
  add('commit 無參數檔→靜默', QC, sh(cNoCfg, 'git commit -m "fix"'), 'ALLOW');
  add('commit commit_gate 沒設 enabled（預設關閉）→靜默', QC, sh(cOff, 'git commit -m "fix"'), 'ALLOW');
  add('commit 含行為類檔無表態→擋並列出檔名', QC, sh(cBeh, 'git commit -m "fix: 購物車"'), 'DENY',
    (m) => m.includes('src/app.js') && !m.includes('README.md') && /已QA：/.test(m));
  add('commit 訊息帶「已QA：…」→放行', QC, sh(cBeh, 'git commit -m "fix: 購物車" -m "已QA：tests/e2e/cart/test_cart.py 3 passed"'), 'ALLOW');
  add('commit 指令後綴 --qa "分流例外：…"→放行', QC, sh(cBeh, 'git commit -m "style" --qa "分流例外：只改縮排"'), 'ALLOW');
  add('commit 只有測試與文件／設定→放行', QC, sh(cDocs, 'git commit -m "test: 購物車"'), 'ALLOW');
  add('commit heredoc 本文提到 git commit 不算', QC, sh(cBeh, "cat > notes.md <<'EOF'\n下一步：git commit -m fix\nEOF"), 'ALLOW');
  add('commit echo／註解提到 git commit 不算', QC, sh(cBeh, 'echo "git commit -m fix"  # 之後再 git commit'), 'ALLOW');
  add('commit -m "$(cat <<EOF … 已QA … EOF)" 的表態算數', QC, sh(cBeh, 'git commit -m "$(cat <<\'EOF\'\nfix: 購物車\n\n已QA：tests/e2e/cart/test_cart.py 3 passed\nEOF\n)"'), 'ALLOW');
  add('commit -F - <<EOF 本文裡的表態算數', QC, sh(cBeh, "git commit -F - <<'EOF'\nfix\n已QA：pytest 3 passed\nEOF"), 'ALLOW');
  add('commit 訊息引號裡的「; git commit」不算第二次呼叫', QC, sh(cBeh, 'git commit -m "已QA：3 passed; git commit 前記得跑回歸"'), 'ALLOW');
  add('commit 同指令兩次 commit 只有一次表態→擋', QC, sh(cBeh, 'git commit -m "a 已QA：x 1 passed" && git commit --allow-empty -m "b"'), 'DENY', (m) => /1 項未過/.test(m));
  add('commit require_sediment：只有 QA 表態→擋「新 QA 坑」', QC, sh(cSed, 'git commit -m "fix" -m "已QA：3 passed"'), 'DENY',
    (m) => /新 QA 坑/.test(m) && !/缺QA 表態/.test(m));
  add('commit require_sediment：QA＋新 QA 坑都表態→放行', QC, sh(cSed, 'git commit -m "fix" -m "已QA：3 passed" -m "新 QA 坑：無"'), 'ALLOW');
  add('commit Skill git-commit 無 args→擋', QC, { cwd: cBeh, tool_name: 'Skill', tool_input: { skill: 'git-commit', args: '' } }, 'DENY', (m) => m.includes('src/app.js') && /args/.test(m));
  add('commit Skill plugin:git-commit 帶 --qa→放行', QC, { cwd: cBeh, tool_name: 'Skill', tool_input: { skill: 'git-commit:git-commit', args: '--qa "已QA：3 passed"' } }, 'ALLOW');
  add('commit 其他 Skill→靜默', QC, { cwd: cBeh, tool_name: 'Skill', tool_input: { skill: 'deliver-report', args: '' } }, 'ALLOW');
  add('commit extra_commands：flow.sh review-record 無表態→擋', QC, sh(cExtra, 'bash "/x/flow.sh" review-record .'), 'DENY', (m) => /review-record/.test(m));
  add('commit extra_commands：帶 --qa→放行', QC, sh(cExtra, 'bash "/x/flow.sh" review-record . --qa "已QA：3 passed"'), 'ALLOW');
  add('commit extra_commands：引號裡提到→不算', QC, sh(cExtra, 'echo "flow.sh review-record ."'), 'ALLOW');
  add('commit git -C 到只有文件的 repo→放行', QC, sh(cBeh, 'git -C "' + cSub + '" commit -m "docs"'), 'ALLOW');
  add('commit repo 指向變數（無法判斷）→要求表態', QC, sh(cBeh, 'git -C "$REPO" commit -m "x"'), 'DENY', (m) => /無法判斷/.test(m));

  // =====================================================================
  // 3+4. guard-pretest-env.js
  // =====================================================================
  const PT = 'guard-pretest-env.js';
  const align = [
    { env: 'APP_TENANT', equals_file: 'backend/app.cfg', regex: 'tenant\\s*=\\s*(\\w+)' },
    { env: 'I18N_DIR', must_be_under: 'FRONT_ROOT' },
  ];
  const pA = mkProj({ pretest: { alignment: align } });
  fs.mkdirSync(path.join(pA, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(pA, 'backend', 'app.cfg'), '# 設定\ntenant = acme\n');
  fs.writeFileSync(path.join(pA, 'env.good.sh'), 'export APP_TENANT=acme\n');
  fs.writeFileSync(path.join(pA, 'env.bad.sh'), '# 別套環境的檔\nexport APP_TENANT="globex"\n');
  const pReq = mkProj({ pretest: { alignment: [{ env: 'QA_APP_ENV', required: true, message: '先 source 自己的環境檔' }] } });
  const guard = (extra) => Object.assign({ name: 'mail-recipients', file: 'src/Mail.cs', require_regex: ['MailTo\\s*=\\s*"qa@example\\.com"'], forbid_regex: ['\\.Concat\\('], message: '收件人必須收斂到測試信箱' }, extra || {});
  const mkSide = (body, g, extraPretest) => {
    const d = mkProj({ pretest: Object.assign({ side_effect_guards: [g || guard()] }, extraPretest || {}) });
    if (body !== null) {
      fs.mkdirSync(path.join(d, 'src'), { recursive: true });
      fs.writeFileSync(path.join(d, 'src', 'Mail.cs'), body);
    }
    return d;
  };
  const GOOD = 'if (!prod) {\n  MailTo = "qa@example.com";\n}\n';
  const sOk = mkSide(GOOD);
  const sMiss = mkSide('if (!prod) {\n  MailTo = team;\n}\n');
  const sForbid = mkSide('if (!prod) {\n  MailTo = "qa@example.com";\n  x = list.Concat(y);\n}\n');
  const sNoFile = mkSide(null);
  const blockG = guard({ block_regex: 'if \\(!prod\\) \\{[\\s\\S]*?\\n\\}' });
  const sBlockOk = mkSide('var all = a.Concat(b);\nif (!prod) {\n  MailTo = "qa@example.com";\n}\n', blockG);
  const sBlockBad = mkSide('if (!prod) {\n  MailTo = "qa@example.com";\n  x = a.Concat(b);\n}\n', blockG);
  const sDotnet = mkSide('MailTo = team;\n', guard(), { test_command_regex: ['\\bdotnet\\s+test\\b'] });
  const pBoth = mkProj({ pretest: { alignment: [{ env: 'QA_APP_ENV', required: true }], side_effect_guards: [guard()] } });
  add('pretest 無參數檔→靜默', PT, sh(mkProj(), 'python -m pytest tests/e2e'), 'ALLOW');
  add('pretest 沒有規則→靜默', PT, sh(mkProj({ pretest: {} }), 'python -m pytest tests/e2e'), 'ALLOW');
  add('pretest inline 值與對照檔不符→擋', PT, sh(pA, 'APP_TENANT=globex python -m pytest tests/e2e'), 'DENY',
    (m) => /APP_TENANT=\*\*\*（長度 6）/.test(m) && /對照值（\*\*\*（長度 4））/.test(m) && !/globex|acme/.test(m));
  add('pretest source 檔的值不符→擋', PT, sh(pA, 'source ./env.bad.sh && python -m pytest tests/e2e'), 'DENY',
    (m) => !/globex/.test(m) && /source env\.bad\.sh/.test(m)); // 來源只標檔名（K1-08：不帶出本機路徑）
  add('pretest source 檔值相符→放行', PT, sh(pA, 'source ./env.good.sh && python -m pytest tests/e2e'), 'ALLOW');
  add('pretest inline 值相符→放行', PT, sh(pA, 'APP_TENANT=acme pytest -q tests/e2e'), 'ALLOW');
  add('pretest 未設且對照檔有值→擋', PT, sh(pA, 'python -m pytest tests/e2e'), 'DENY', (m) => /未設 APP_TENANT/.test(m));
  add('pretest process env 值相符→放行', PT, sh(pA, 'python -m pytest tests/e2e'), 'ALLOW', null, { APP_TENANT: 'acme' });
  add('pretest --collect-only→放行', PT, sh(pA, 'APP_TENANT=globex python -m pytest --collect-only -q'), 'ALLOW');
  add('pretest --fixtures／-h→放行', PT, sh(pA, 'pytest --fixtures; pytest -h'), 'ALLOW');
  add('pretest heredoc 本文提到 pytest→放行', PT, sh(pA, "cat > progress.md <<'EOF'\npython -m pytest tests/e2e\nEOF"), 'ALLOW');
  add('pretest echo／grep 提及 pytest→放行', PT, sh(pA, 'grep -n testpaths pytest.ini; echo "python -m pytest"'), 'ALLOW');
  add('pretest must_be_under：不在底下→擋', PT, sh(pA, 'APP_TENANT=acme FRONT_ROOT=/srv/front-a I18N_DIR=/srv/front-b/i18n python -m pytest'), 'DENY',
    (m) => /I18N_DIR/.test(m) && /FRONT_ROOT/.test(m));
  add('pretest must_be_under：在底下→放行', PT, sh(pA, 'APP_TENANT=acme FRONT_ROOT=/srv/front-a I18N_DIR=/srv/front-a/i18n python -m pytest'), 'ALLOW');
  add('pretest required 沒設→擋', PT, sh(pReq, 'python -m pytest'), 'DENY', (m) => /未設 QA_APP_ENV/.test(m) && /先 source/.test(m));
  add('pretest required：$env: 賦值算數→放行', PT, { cwd: pReq, tool_name: 'PowerShell', tool_input: { command: '$env:QA_APP_ENV="local"; python -m pytest' } }, 'ALLOW'); // portable-ok: 合成 payload 的工具名稱字串，非呼叫系統指令
  add('pretest 副作用防線合格→放行', PT, sh(sOk, 'python -m pytest'), 'ALLOW');
  add('pretest 副作用：缺 require→擋', PT, sh(sMiss, 'python -m pytest'), 'DENY', (m) => /缺：MailTo/.test(m) && /收件人必須收斂/.test(m));
  add('pretest 副作用：命中 forbid→擋', PT, sh(sForbid, 'python -m pytest'), 'DENY', (m) => /命中禁止樣式/.test(m));
  add('pretest 副作用：檔案讀不到→擋', PT, sh(sNoFile, 'python -m pytest'), 'DENY', (m) => /讀不到 src\/Mail\.cs/.test(m));
  add('pretest 副作用 block_regex：區塊外的 forbid 不算→放行', PT, sh(sBlockOk, 'python -m pytest'), 'ALLOW');
  add('pretest 副作用 block_regex：區塊內命中→擋', PT, sh(sBlockBad, 'python -m pytest'), 'DENY', (m) => /檢查區塊/.test(m));
  add('pretest qa-flow.sh run 也算跑測試', PT, sh(sMiss, 'CLAUDE_PROJECT_DIR=/p bash "/x/skills/browser-qa/qa-flow.sh" run cart tests/e2e/cart/test_cart.py'), 'DENY');
  add('pretest test_command_regex 擴充 dotnet test→擋', PT, sh(sDotnet, 'dotnet test src/App.Tests'), 'DENY');
  add('pretest 沒擴充時 dotnet test 不算→放行', PT, sh(sMiss, 'dotnet test src/App.Tests'), 'ALLOW');
  add('pretest 對齊與副作用問題一次全列', PT, sh(pBoth, 'python -m pytest'), 'DENY',
    (m) => /2 項未過/.test(m) && /\[環境對齊\]/.test(m) && /\[副作用防護\]/.test(m));
  add('pretest 規則 regex 壞掉→該條 fail-open', PT, sh(mkProj({ pretest: { side_effect_guards: [guard({ forbid_regex: ['(unclosed'] })] } }), 'python -m pytest'), 'ALLOW');

  // =====================================================================
  // 5. guard-command-rules.js
  // =====================================================================
  const CR = 'guard-command-rules.js';
  const rules = [
    { name: 'db-superuser', when_regex: '\\b(sqlcmd|psql|mysql)\\b', deny_regex: ['(^|\\s)-U\\s*(sa|root|postgres)\\b', '(user\\s*id|uid)\\s*=\\s*(sa|root)\\b'], message: 'sqlcmd -U qa_app -P <測試帳號密碼>' },
    { name: 'service-env', when_regex: '\\bdotnet\\s+run\\b', deny_regex: ['--no-launch-profile\\b'], require_env: ['ASPNETCORE_ENVIRONMENT'], message: 'ASPNETCORE_ENVIRONMENT=Local dotnet run --project src/App.Api' },
    { name: 'npm-e2e', when_regex: '\\bnpm\\s+run\\s+e2e\\b', require_regex: ['--config\\s+\\S+'], message: 'npm run e2e -- --config e2e.local.json' },
    { name: 'off', enabled: false, when_regex: '.', deny_regex: ['.'] },
  ];
  const cr = mkProj({ command_guards: rules });
  add('command 無參數檔→靜默', CR, sh(mkProj(), 'sqlcmd -U sa -P x'), 'ALLOW');
  add('command 不符 when→放行', CR, sh(cr, 'ls -la && git status'), 'ALLOW');
  add('command deny 命中→擋', CR, sh(cr, 'sqlcmd -S db,1433 -U sa -P secret -Q "select 1"'), 'DENY', (m) => /db-superuser/.test(m) && /正解：sqlcmd -U qa_app/.test(m));
  add('command 連線字串在引號裡也認得→擋', CR, sh(cr, 'python -c "import pyodbc" && sqlcmd -Q "x" "Server=db;User Id=sa"'), 'DENY');
  add('command 正確帳號→放行', CR, sh(cr, 'sqlcmd -S db,1433 -U qa_app -P secret -Q "select 1"'), 'ALLOW');
  add('command require_regex 缺→擋', CR, sh(cr, 'npm run e2e'), 'DENY', (m) => /缺必要寫法/.test(m));
  add('command require_env 缺→擋', CR, sh(cr, 'dotnet run --project src/App.Api'), 'DENY', (m) => /未設環境變數 ASPNETCORE_ENVIRONMENT/.test(m));
  add('command require_env：inline 前綴→放行', CR, sh(cr, 'ASPNETCORE_ENVIRONMENT=Local dotnet run --project src/App.Api'), 'ALLOW');
  add('command require_env：export→放行', CR, sh(cr, 'export ASPNETCORE_ENVIRONMENT=Local && dotnet run --project src/App.Api'), 'ALLOW');
  add('command require_env：$env:→放行', CR, { cwd: cr, tool_name: 'PowerShell', tool_input: { command: '$env:ASPNETCORE_ENVIRONMENT = "Local"; dotnet run --project src/App.Api' } }, 'ALLOW'); // portable-ok: 合成 payload 的工具名稱字串，非呼叫系統指令
  add('command require_env：set→放行', CR, sh(cr, 'set ASPNETCORE_ENVIRONMENT=Local&& dotnet run --project src/App.Api'), 'ALLOW');
  add('command 兩條規則都違反→一次全列', CR, sh(cr, 'dotnet run --no-launch-profile; npm run e2e'), 'DENY',
    (m) => /2 項未過/.test(m) && /service-env/.test(m) && /npm-e2e/.test(m) && /--no-launch-profile/.test(m));
  add('command heredoc 本文提到→放行', CR, sh(cr, "cat > n.md <<'EOF'\nsqlcmd -U sa\nEOF"), 'ALLOW');

  // =====================================================================
  // 6. guard-report-output.js
  // =====================================================================
  const RO = 'guard-report-output.js';
  const ro = mkProj({ report_hygiene: { roots: ['tests/reports'] } });
  const roWide = mkProj({ report_hygiene: { roots: ['tests/reports', 'reports'], work_dir: '_work' } });
  const w = (cwd, rel, tool) => ({ cwd, tool_name: tool || 'Write', tool_input: { file_path: path.join(cwd, ...rel.split('/')) } });
  add('report 無參數檔→靜默', RO, w(mkProj(), 'tests/reports/a.xml'), 'ALLOW');
  add('report 交付根層直接寫檔→擋', RO, w(ro, 'tests/reports/summary.docx'), 'DENY', (m) => /根層禁止直接放檔/.test(m));
  add('report 交付資料夾內過程檔不在 _work→擋', RO, w(ro, 'tests/reports/cart_20260924/junit.xml'), 'DENY', (m) => /_work/.test(m));
  add('report 過程檔在 _work→放行', RO, w(ro, 'tests/reports/cart_20260924/_work/junit.xml'), 'ALLOW');
  add('report 非過程格式交付檔→放行', RO, w(ro, 'tests/reports/cart_20260924/購物車測試報告.docx'), 'ALLOW');
  add('report Read 工具→放行', RO, w(ro, 'tests/reports/a.xml', 'Read'), 'ALLOW');
  add('report bash 純讀取→放行', RO, sh(ro, 'cat tests/reports/cart_20260924/junit.xml | head'), 'ALLOW');
  add('report bash --junitxml 寫到交付資料夾→擋', RO, sh(ro, 'python -m pytest --junitxml=tests/reports/cart_20260924/r.xml'), 'DENY');
  add('report bash 重導寫到交付根層→擋', RO, sh(ro, 'echo x > tests/reports/log.txt'), 'DENY');
  add('report mv 只驗目的地→放行', RO, sh(ro, 'mv tests/reports/r.xml tests/reports/cart_20260924/_work/r.xml'), 'ALLOW');
  add('report qa-flow.sh run 的 junit 落點（Write）不被擋', RO, w(roWide, 'tests/e2e/reports/cart-2026-09-24.xml'), 'ALLOW');
  add('report qa-flow.sh run 的 junit 落點（--junitxml）不被擋', RO, sh(roWide, 'python -m pytest tests/e2e/cart/test_cart.py --junitxml=tests/e2e/reports/cart-2026-09-24.xml'), 'ALLOW');
  add('report roots 為空→靜默', RO, w(mkProj({ report_hygiene: { roots: [] } }), 'tests/reports/a.xml'), 'ALLOW');

  // =====================================================================
  // 7. guard-browser-nav.js
  // =====================================================================
  const BN = 'guard-browser-nav.js';
  const bn = mkProj({ browser_guard: { deny_hosts_regex: '(^|\\.)prod\\.example\\.com$', rate_limits: [{ host_regex: 'shop\\.example\\.test$', max: 2, window_s: 1 }] } });
  const bnAll = mkProj({ browser_guard: { deny_hosts_regex: '.*' } });
  const state = path.join(root, 'nav-state.json');
  const nenv = { QA_WEBWRIGHT_NAV_STATE: state };
  const nav = (cwd, url, tool) => ({ cwd, tool_name: tool || 'mcp__playwright__browser_navigate', tool_input: { url } });
  add('nav 無參數檔→靜默', BN, nav(mkProj(), 'https://prod.example.com/'), 'ALLOW', null, nenv);
  add('nav 正式站→擋', BN, nav(bn, 'https://www.prod.example.com/admin'), 'DENY', (m) => /禁止導向 www\.prod\.example\.com/.test(m), nenv);
  add('nav 限速第 1 次→放行', BN, nav(bn, 'https://shop.example.test/'), 'ALLOW', null, nenv);
  add('nav 限速第 2 次（tabs_create）→放行', BN, nav(bn, 'https://shop.example.test/cart', 'mcp__claude-in-chrome__tabs_create_mcp'), 'ALLOW', null, nenv);
  add('nav 限速第 3 次（N+1）→擋', BN, nav(bn, 'https://shop.example.test/inventory'), 'DENY', (m) => /達上限 2 次/.test(m), nenv);
  add('nav 視窗過後→放行', BN, nav(bn, 'https://shop.example.test/'), 'ALLOW', null, Object.assign({ SLEEP_BEFORE_MS: '1300' }, nenv));
  add('nav 其他 host 不受限速→放行', BN, nav(bn, 'https://docs.example.test/'), 'ALLOW', null, nenv);
  add('nav localhost 永遠放行（即使 deny 全部）', BN, nav(bnAll, 'http://localhost:5173/'), 'ALLOW', null, nenv);
  add('nav 127.0.0.1 永遠放行', BN, nav(bnAll, 'http://127.0.0.1:8080/x'), 'ALLOW', null, nenv);
  add('nav 沒有網址（列分頁）→放行', BN, { cwd: bnAll, tool_name: 'mcp__playwright__browser_tabs', tool_input: { action: 'list' } }, 'ALLOW', null, nenv);
  add('nav browser_guard 沒設規則→靜默', BN, nav(mkProj({ browser_guard: {} }), 'https://prod.example.com/'), 'ALLOW', null, nenv);

  // ---- pretest：對照「port 上此刻在跑的 process」實際讀的檔（起一個真的本機服務來驗）----
  const PP = createRequire(import.meta.url)('./lib/port-process.js');
  const liveRoot = path.join(root, 'live');
  const liveSvc = path.join(liveRoot, 'svcA', 'app');
  fs.mkdirSync(path.join(liveSvc, 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(liveRoot, 'svcA', 'app.local.json'), '{ "TenantId": "T-REAL" }\n');
  fs.writeFileSync(path.join(liveSvc, 'package.json'), '{}\n');
  const livePort = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(liveSvc, 'server.js'),
    "require('http').createServer((q, s) => s.end('ok')).listen(" + livePort + ");\n");
  const liveSrv = spawn(process.execPath, [path.join(liveSvc, 'server.js')], { stdio: 'ignore' });
  let livePid = null;
  for (let i = 0; i < 20 && !livePid; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    PP.reset();
    livePid = PP.pidOfPort(livePort);
  }
  // 第七輪 B 軌重現：前端由 node_modules/.bin 的工具啟動（vite 形狀），專案根不得判成 node_modules/vite
  const viteFront = path.join(root, 'live2', 'vfront');
  fs.mkdirSync(path.join(viteFront, 'node_modules', 'vite', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(viteFront, 'src', 'locales'), { recursive: true });
  fs.writeFileSync(path.join(viteFront, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(viteFront, 'node_modules', 'vite', 'package.json'), '{}\n');
  const vitePort = livePort + 1;
  fs.writeFileSync(path.join(viteFront, 'node_modules', 'vite', 'bin', 'vite.js'),
    "require('http').createServer((q, s) => s.end('ok')).listen(" + vitePort + ");\n");
  const viteSrv = spawn(process.execPath, [path.join(viteFront, 'node_modules', 'vite', 'bin', 'vite.js')], { stdio: 'ignore' });
  let vitePid = null;
  for (let i = 0; i < 20 && !vitePid; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    PP.reset();
    vitePid = PP.pidOfPort(vitePort);
  }
  if (process.platform === 'win32') {
    const dRoot = PP.candidateDirs({ cwd: null, exe: null, cmd: 'node "' + path.join(path.parse(root).root, 'node_modules', 'zz-never-exists.js') + '"' });
    const e = PP.expandDir ? PP.expandDir(path.join(path.parse(root).root, 'node_modules', 'x', 'bin')) : ['(no expandDir)'];
    add('port-process R8：磁碟根目錄下的 node_modules → 取磁碟根（C:\\），不是「C:」', null, null, 'CHECK',
      () => e.length === 1 && e[0] === path.parse(root).root && Array.isArray(dRoot));
  }
  {
    const nb = path.join(root, 'cand', 'api');
    const dll = path.join(nb, 'bin', 'Debug', 'net8.0', 'Api.dll');
    fs.mkdirSync(path.dirname(dll), { recursive: true });
    fs.writeFileSync(dll, '');
    const dBin = PP.candidateDirs({ cwd: null, exe: null, cmd: 'dotnet "' + dll + '"' });
    add('port-process：.NET 建置輸出（bin 內）先試 bin 的上一層＝專案目錄', null, null, 'CHECK',
      () => dBin.length === 2 && path.resolve(dBin[0]) === path.resolve(nb) && path.resolve(dBin[1]) === path.resolve(path.dirname(dll)));
    const dNm = PP.candidateDirs({ cwd: null, exe: null, cmd: 'node "' + path.join(viteFront, 'node_modules', 'vite', 'bin', 'vite.js') + '"' });
    add('port-process：node_modules 內的執行檔改取 node_modules 外那層', null, null, 'CHECK',
      () => dNm.length === 1 && path.resolve(dNm[0]) === path.resolve(viteFront));
  }
  const pLive = mkProj({ pretest: { alignment: [
    { env: 'QA_TENANT', port_env: 'QA_API_URL', equals_process_file: 'app.local.json', regex: '"TenantId"\\s*:\\s*"([^"]+)"' },
    { env: 'QA_I18N_DIR', port_env: 'QA_API_URL', under_process_root: 'package.json' },
  ] } });
  const posix = (p) => p.replace(/\\/g, '/');
  const liveUrl = 'QA_API_URL=http://localhost:' + livePort;
  if (livePid) {
    add('pretest process：值與「port 上在跑的服務實際讀的檔」不一致→擋', PT,
      sh(pLive, liveUrl + ' QA_TENANT=T-WRONG QA_I18N_DIR=' + posix(liveSvc) + '/i18n python -m pytest'), 'DENY',
      (m) => /實際讀的/.test(m) && m.includes('app.local.json') && !m.includes('T-REAL'));
    add('pretest process：值一致、目錄在該服務專案根底下→放行', PT,
      sh(pLive, liveUrl + ' QA_TENANT=T-REAL QA_I18N_DIR=' + posix(liveSvc) + '/i18n python -m pytest'), 'ALLOW');
    add('pretest process：目錄指到別套服務→擋', PT,
      sh(pLive, liveUrl + ' QA_TENANT=T-REAL QA_I18N_DIR=' + posix(liveRoot) + '/other/i18n python -m pytest'), 'DENY',
      (m) => /專案根/.test(m));
    if (vitePid) {
      const pVite = mkProj({ pretest: { alignment: [{ env: 'QA_I18N_DIR', port_env: 'QA_WEB_URL', under_process_root: 'package.json' }] } });
      add('pretest process R7：前端由 node_modules 內的工具啟動→專案根取 node_modules 外那層，正確目錄放行', PT,
        sh(pVite, 'QA_WEB_URL=http://localhost:' + vitePort + ' QA_I18N_DIR=' + posix(viteFront) + '/src/locales python -m pytest'), 'ALLOW');
      add('pretest process R7：同上，指到別處→擋（對照）', PT,
        sh(pVite, 'QA_WEB_URL=http://localhost:' + vitePort + ' QA_I18N_DIR=' + posix(liveRoot) + '/other python -m pytest'), 'DENY');
    }
  } else {
    console.log('  - pretest process 三案略過：本機查不到 LISTEN 的 pid（netstat／lsof 不可用），不是閘的問題');
  }
  if (livePid && !vitePid) {
    add('pretest process R7：vite 形狀的測試服務應查得到（同一台機器上另一個服務查得到）', null, null, 'CHECK', () => false);
  }
  add('pretest process：port 上沒有服務→無從判斷、放行', PT,
    sh(pLive, 'QA_API_URL=http://localhost:1 QA_TENANT=T-WRONG python -m pytest'), 'ALLOW');
  add('pretest process：規則型別錯（port 是字串）→整條 fail-open', PT,
    sh(mkProj({ pretest: { alignment: [{ env: 'QA_TENANT', port: '8080', equals_process_file: 'a.json', regex: '(x)' }] } }),
      'QA_TENANT=zz python -m pytest'), 'ALLOW');

  // ---- execute ----
  let pass = 0;
  let fail = 0;
  for (const [name, hook, payload, expected, check, env] of cases) {
    let r;
    if (expected === 'CHECK') {
      r = { tag: check() ? 'CHECK' : 'CHECK-FAILED', msg: '' };
      if (r.tag === 'CHECK') {
        pass++;
        console.log('  ✓ ' + name);
      } else {
        fail++;
        console.log('  ✗ ' + name);
      }
      continue;
    }
    if (env && env.SLEEP_BEFORE_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.SLEEP_BEFORE_MS));
    r = runHook(hook, payload, env);
    const extraOk = check ? check(r.msg) : true;
    if (r.tag === expected && extraOk) {
      pass++;
      console.log('  ✓ ' + name + ' → ' + r.tag);
    } else {
      fail++;
      console.log('  ✗ ' + name + ' → 期望 ' + expected + (check ? '＋訊息斷言' : '') + '，實際 ' + r.tag + (extraOk ? '' : '（訊息斷言不符）'));
      console.log('     ' + String(r.msg).split('\n').slice(0, 14).join('\n     '));
    }
  }
  try {
    viteSrv.kill();
  } catch (_) {
    /* 已結束 */
  }
  try {
    liveSrv.kill();
  } catch (_) {
    /* 已結束 */
  }
  return { pass, fail };
}
