#!/usr/bin/env node
/**
 * 禁用規則載入完整性測試
 *
 * 由來：loadBanned() 自 0.10.0 起只讀 patterns，subgroups 寫法的組會整組靜默漏載。
 * 當時套用在 docx 的組剛好都用 patterns，所以結果全對、測試全綠，潛伏一個月；
 * 直到要讓 docx 也套 AI 規則時才會發作。所有既有測試都用同一個讀取函式驗證，看不見它的盲區。
 *
 * 這組測試守兩件事：
 *   1. 目前的規則檔：套用在文件的規則全部載入（ruleCoverage 用不同算法數）
 *   2. 讀法的覆蓋面：patterns、subgroups、兩者混用、巢狀陣列都讀得到——用臨時規則檔實測，
 *      並確認「故意漏讀」時 ruleCoverage 會報不一致（驗證器本身擋得住）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'readability-scan.core.js');
let pass = 0, fail = 0;
const check = (desc, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + (detail ? '：' + detail : '')); }
};

// 1. 目前的規則檔
const core = require(LIB);
const cov = core.ruleCoverage();
check(`目前規則檔全部載入（${cov.loaded}/${cov.expected}）`, cov.ok, cov.reason);
check('AI 工具名稱組有載入', core.BANNED.groups.some((g) => g.key === 'ai_tool_names' && !g.harvested));
check('docx 掃描擋得到 Codex', core.scanText(['本段由 Codex 協助審查。'], null).bad.some((b) => b.includes('Codex')));

// 2. 用臨時規則檔測各種寫法：把 core 複製到臨時目錄，搭一個假的 references/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banned-load-'));
fs.mkdirSync(path.join(tmp, 'hooks', 'lib'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'references'));
const src = fs.readFileSync(LIB, 'utf8');
fs.writeFileSync(path.join(tmp, 'hooks', 'lib', 'core.js'), src);
const rules = {
  a: { applies_to: ['docx'], patterns: ['甲甲'] },
  b: { applies_to: ['docx'], subgroups: { x: ['乙乙', '丙丙'], y: ['丁丁'] } },
  c: { applies_to: ['docx'], patterns: ['戊戊'], subgroups: { z: ['己己'] } },
  d: { applies_to: ['daily'], patterns: ['不該載入'] },
  revision_history: { applies_to: ['docx'], literals: ['本次查核'] },
};
fs.writeFileSync(path.join(tmp, 'references', 'banned-patterns.json'), JSON.stringify(rules));
const t = require(path.join(tmp, 'hooks', 'lib', 'core.js'));
const c2 = t.ruleCoverage();
check(`patterns／subgroups／混用都載入（${c2.loaded}/${c2.expected}，應為 6/6）`, c2.ok && c2.expected === 6, c2.reason);
const hitAll = ['甲甲', '乙乙', '丙丙', '丁丁', '戊戊', '己己'].every((w) => t.scanText([w], null).bad.length > 0);
check('六條規則各自都擋得到', hitAll);
check('只套日報的規則沒有載入文件閘', t.scanText(['不該載入'], null).bad.length === 0);

// 3. 驗證器本身：故意改成只讀 patterns，ruleCoverage 必須報不一致
const broken = src.replace('for (const pats of Object.values(g.subgroups || {})) srcs.push(...pats);', '');
if (broken === src) { fail++; console.log('  ✗ 找不到要破壞的那一行（讀取程式改過，請同步更新本測試）'); }
else {
  fs.writeFileSync(path.join(tmp, 'hooks', 'lib', 'broken.js'), broken);
  const b = require(path.join(tmp, 'hooks', 'lib', 'broken.js'));
  const c3 = b.ruleCoverage();
  check(`故意漏讀 subgroups 時會被抓到（載入 ${c3.loaded}/${c3.expected}）`, !c3.ok);
}
// 4. 文件屬性的預設值組（generator_defaults）：applies_to 只寫 metadata，不算進文件規則數；
//    誤加 docx 時 loadBanned 讀不到它的 defaults（是物件不是正則），ruleCoverage 必須報不一致
check('generator_defaults 有載入（至少 8 條）', core.loadGeneratorDefaults().length >= 8, String(core.loadGeneratorDefaults().length));
const metaRules = { ...rules, m: { applies_to: ['metadata'], defaults: [{ source: 'x', fields: ['title'], value: '預設標題' }] } };
fs.writeFileSync(path.join(tmp, 'references', 'banned-patterns.json'), JSON.stringify(metaRules));
fs.writeFileSync(path.join(tmp, 'hooks', 'lib', 'core-meta.js'), src);
const c4 = require(path.join(tmp, 'hooks', 'lib', 'core-meta.js')).ruleCoverage();
check(`只套 metadata 的組不影響文件規則數（${c4.loaded}/${c4.expected}）`, c4.ok && c4.expected === 6, c4.reason);
metaRules.m.applies_to = ['docx', 'metadata'];
fs.writeFileSync(path.join(tmp, 'references', 'banned-patterns.json'), JSON.stringify(metaRules));
fs.writeFileSync(path.join(tmp, 'hooks', 'lib', 'core-meta2.js'), src);
const c5 = require(path.join(tmp, 'hooks', 'lib', 'core-meta2.js')).ruleCoverage();
check(`預設值組誤加 docx 時會被抓到（載入 ${c5.loaded}/${c5.expected}）`, !c5.ok);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
