#!/usr/bin/env node
/**
 * guard-command-rules — qa-webwright 的 PreToolUse(Bash|PowerShell) hook：參數化的指令守門。
 *
 * 為什麼：測試環境裡有些指令「寫錯一個參數」代價極高，而且當下看不出來——
 *   · 用高權限帳號連測試 DB、憑印象試密碼 → 觸發登入失敗鎖定，整台 DB 一段時間不能用；
 *   · 服務啟動少帶環境名 → 靜默跑成正式環境設定，照常 LISTEN、照常回 200，直到開畫面才出事。
 * 正解早就寫在文件裡，但文件擋不住「憑印象」；把「什麼情況下、什麼寫法不准」寫成規則交給本閘。
 *
 * 啟動條件：專案 tests/e2e/qa-webwright.json 有 command_guards（陣列）且至少一條規則；否則完全靜默。
 * 每條規則：{name, when_regex, deny_regex[], require_regex[], require_env[], message, enabled?}
 *   指令符合 when_regex 時才檢查：命中任一 deny_regex、缺任一 require_regex、或 require_env 沒設 → 擋。
 *   require_env 認：inline 前綴（X=v cmd）、同指令 export X=／set X=／$env:X=、以及目前 process env。
 *   比對對象＝去掉 heredoc 本文與註解後的指令（引號內容保留：連線字串常寫在引號裡）。
 * 擋下：permissionDecision=deny，一次列完所有規則的所有未過項，附規則自帶的 message（寫正解）。
 * FAIL-OPEN：hook 自身錯誤、規則型別壞、regex 編不起來 → 該條（或整支）放行。
 */
'use strict';

const G = require('./lib/qa-gate-common.js');

function main() {
  const input = G.readInput();
  if (!input) return;
  const ti = G.isObj(input.tool_input) ? input.tool_input : {};
  if (typeof ti.command !== 'string' || !ti.command) return;
  const got = G.loadSection(input, 'command_guards', (s) => Array.isArray(s));
  if (!got || !got.sec.length) return;

  const sh = G.scanShell(ti.command, G.shellOpts(input));
  const text = sh.code;
  const problems = [];
  for (const rule of got.sec) {
    if (!G.isObj(rule) || rule.enabled === false) continue;
    // 欄位型別錯（regex 清單寫成字串、message 不是字串）＝規則壞 → 整條略過（fail-open），不得只套一半
    if ((rule.deny_regex !== undefined && !G.strList(rule.deny_regex))
      || (rule.require_regex !== undefined && !G.strList(rule.require_regex))
      || (rule.require_env !== undefined && !G.strList(rule.require_env))
      || (rule.message !== undefined && typeof rule.message !== 'string')) continue;
    const when = G.re(rule.when_regex);
    if (!when || !when.test(text)) continue;
    const deny = G.strList(rule.deny_regex) ? rule.deny_regex : [];
    const req = G.strList(rule.require_regex) ? rule.require_regex : [];
    const env = G.strList(rule.require_env) ? rule.require_env : [];
    const compiled = deny.concat(req).map((s) => G.re(s));
    if (compiled.some((x) => x === null)) continue; // regex 壞 → 該條 fail-open
    const miss = [];
    deny.forEach((s, i) => {
      if (compiled[i].test(text)) miss.push('命中禁止寫法：' + s);
    });
    req.forEach((s, i) => {
      if (!compiled[deny.length + i].test(text)) miss.push('缺必要寫法：' + s);
    });
    // 值的來源與 pretest 同一套：inline／export／source 的檔（以 source 當下的目錄解析）／process env；
    // 值引用別的變數（X="$Y"）先展開，展開後是空字串＝沒設
    const cwd = input.cwd || got.loc.root;
    const dirAt = (i) => {
      const d = G.cdChain(sh, i, cwd);
      return typeof d === 'string' ? d : null;
    };
    for (const name of env) {
      const v = G.resolvedEnv(sh, name, { bases: [cwd], dirAt, cwd });
      if (v && v.value === null) continue; // 值未知（source 路徑展開不了、引用未設的變數）→ 不擋（無從判斷）
      if (!v || v.value === '') {
        miss.push('未設環境變數 ' + name + '（同一條指令用 ' + name + '=值 前綴、export ' + name + '=值、'
          + '$env:' + name + '="值" 或 set ' + name + '=值 皆可）');
      }
    }
    if (miss.length) {
      problems.push('[' + (rule.name || rule.when_regex) + '] ' + miss.join('；')
        + (typeof rule.message === 'string' && rule.message ? '\n     正解：' + rule.message : ''));
    }
  }
  if (!problems.length) return;
  G.deny(G.listMessage('[command-guard] 這條指令', problems,
    '照正解改寫後重發。規則來源：專案 tests/e2e/qa-webwright.json 的 command_guards；'
    + '若確有例外需求，先向使用者確認（不要自己換寫法繞過或試密碼）。'));
}

try {
  main();
} catch (_) {
  process.exitCode = 0; // FAIL-OPEN
}
