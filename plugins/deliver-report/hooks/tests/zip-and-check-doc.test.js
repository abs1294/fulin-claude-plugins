#!/usr/bin/env node
/**
 * readability-scan.core.js 的 zip 讀取（openZip／readDocXml／readPptxSlides）與 check_doc.js 視覺檢查接線的測試。
 * 測試用的 docx／pptx 由 Python 標準函式庫 zipfile 現做（不需 python-pptx），pdf 用 PyMuPDF 現做。
 * 用法：node hooks/tests/zip-and-check-doc.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const core = require(path.join(ROOT, 'hooks', 'lib', 'readability-scan.core.js'));
const CHECK = path.join(ROOT, 'skills', 'check-before', 'scripts', 'check_doc.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-zip-'));
let pass = 0, fail = 0;
function t(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  → ' + detail}`);
  ok ? pass++ : fail++;
}
function py(code, ...args) {
  for (const exe of ['python', 'python3', 'py']) {
    const r = spawnSync(exe, ['-c', code, ...args], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') continue;
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  }
  throw new Error('找不到 python');
}

// ---- 現做測試檔 ----
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const slide = (paras) => `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const pptxFiles = {
  'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Target="slides/slide2.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>',
  // 第 1 張：空段落 <a:p/> 夾在兩段中間（舊正則會把 <a:p/> 與下一段併成一段）；&amp; 要解碼
  // 空段落三種合法寫法 <a:p/>、<a:p />、<a:p algn="l"/> 都不能把下一段吞掉
  'ppt/slides/slide1.xml': slide('<a:p><a:r><a:t>第一段</a:t></a:r></a:p><a:p/><a:p><a:r><a:t>第二段 A&amp;B</a:t></a:r></a:p>' +
    '<a:p /><a:p><a:r><a:t>第三段</a:t></a:r></a:p><a:p algn="l"/><a:p><a:pPr/><a:r><a:t>第四段</a:t></a:r></a:p>'),
  'ppt/slides/slide2.xml': slide('<a:p><a:r><a:t>第二張</a:t></a:r></a:p>'),
};
const pptx = path.join(tmp, 't.pptx');
const docx16 = path.join(tmp, 'utf16.docx');
const docx8 = path.join(tmp, 'utf8bom.docx');
const docXml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文段落</w:t></w:r></w:p></w:body></w:document>';
py(`
import sys, json, zipfile
files = json.loads(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:
    for k, v in files.items(): z.writestr(k, v.encode('utf-8'))
doc = sys.argv[5]
with zipfile.ZipFile(sys.argv[3], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('word/document.xml', b'\\xff\\xfe' + doc.encode('utf-16-le'))
with zipfile.ZipFile(sys.argv[4], 'w', zipfile.ZIP_STORED) as z:
    z.writestr('word/document.xml', b'\\xef\\xbb\\xbf' + doc.encode('utf-8'))
`, JSON.stringify(pptxFiles), pptx, docx16, docx8, docXml);

// ---- core：zip 讀取 ----
const slides = core.readPptxSlides(pptx);
t('pptx 依簡報順序讀兩張（rels 順序顛倒也不影響）', slides && slides.length === 2 && slides[1].paras.join() === '第二張',
  JSON.stringify(slides));
t('空段落（<a:p/>、<a:p />、<a:p algn="l"/>）不吞下一段、實體 &amp; 解碼',
  slides && JSON.stringify(slides[0].paras) === JSON.stringify(['第一段', '', '第二段 A&B', '', '第三段', '', '第四段']),
  JSON.stringify(slides && slides[0].paras));
t('UTF-16（有 BOM）的 document.xml 讀得到', (core.readDocXml(docx16) || '').includes('中文段落'), String(core.readDocXml(docx16)).slice(0, 80));
t('UTF-8 BOM、未壓縮（stored）的 document.xml 讀得到', (core.readDocXml(docx8) || '').startsWith('<?xml'), String(core.readDocXml(docx8)).slice(0, 20));
const junk = path.join(tmp, 'junk.docx');
fs.writeFileSync(junk, Buffer.from('not a zip file at all'));
t('不是 zip → openZip 回 null、readDocXml 回 null', core.openZip(junk) === null && core.readDocXml(junk) === null, 'not null');

// ---- check_doc.js：視覺檢查接線 ----
function check(args, env) {
  const r = spawnSync('node', [CHECK, ...args], { encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
  return { code: r.status, out: r.stdout };
}
const md = path.join(tmp, 'n.md');
fs.writeFileSync(md, '# 標題\n\n一段正常的說明文字。\n');
let r = check([md, '--visual', '--json']);
t('md 加 --visual 不跑視覺檢查（沒有版面）、JSON 可解析且 visual 為 null',
  r.code === 0 && JSON.parse(r.out).visual === null, `code=${r.code} ${r.out.slice(0, 120)}`);

const pdf = path.join(tmp, 'p.pdf');
py(`
import sys, fitz
d = fitz.open(); pg = d.new_page(width=400, height=300)
pg.insert_text((40, 80), "first line of text", fontsize=14)
pg.insert_text((40, 150), "second line far below", fontsize=14)
d.save(sys.argv[1])
`, pdf);
r = check([pdf, '--json']);
t('pdf 不加 --visual 不跑視覺檢查（既有呼叫端行為不變）', r.code === 0 && JSON.parse(r.out).visual === null, `code=${r.code}`);
r = check([pdf, '--visual', '--json']);
let j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('pdf 加 --visual：JSON 有 visual.images 與 manifest、整段可 JSON.parse',
  r.code === 0 && j && j.visual && j.visual.images.length === 1 && /visual-manifest\.json$/.test(j.visual.manifest), `code=${r.code} ${r.out.slice(0, 200)}`);
r = check([pdf, '--visual', '--json'], { DR_VISUAL_PYTHON: path.join(tmp, 'no-such-python.exe') });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('要跑視覺檢查卻找不到 python → exit 2、pass=false、visual_error 有原因',
  r.code === 2 && j && j.pass === false && /Python/.test(j.visual_error || ''), `code=${r.code} ${r.out.slice(0, 200)}`);
r = check([pdf, '--visual'], { DR_VISUAL_PYTHON: path.join(tmp, 'no-such-python.exe') });
t('文字模式同樣 exit 2，並寫「視覺未驗證…不算通過」', r.code === 2 && /視覺未驗證.*不算通過/.test(r.out), `code=${r.code}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
