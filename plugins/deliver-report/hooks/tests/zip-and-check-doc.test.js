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
t('要跑視覺檢查卻找不到 python → 不擋（exit 0），pass=false，「這次沒檢查到的」寫明要裝 Python',
  r.code === 0 && j && j.pass === false && j.visual_error === null && j.unchecked.some((u) => u.startsWith('視覺檢查：') && /安裝 Python 3/.test(u)),
  `code=${r.code} ${r.out.slice(0, 300)}`);
r = check([pdf, '--visual'], { DR_VISUAL_PYTHON: path.join(tmp, 'no-such-python.exe') });
t('文字模式同樣不擋，並寫「視覺檢查沒有跑」與安裝方式', r.code === 0 && /視覺檢查沒有跑/.test(r.out) && /安裝 Python 3/.test(r.out), `code=${r.code} ${r.out}`);
// 缺套件：開一個不帶任何套件的 venv 當 Python（等於真的沒裝 PyMuPDF／Pillow／pypdf）
const venv = path.join(tmp, 'bare-venv');
py('import sys, venv; venv.create(sys.argv[1], with_pip=False)', venv);
const bare = fs.existsSync(path.join(venv, 'Scripts', 'python.exe')) ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
r = check([pdf, '--visual', '--json'], { DR_VISUAL_PYTHON: bare });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('視覺檢查缺 PyMuPDF／Pillow → 不擋（exit 0），pass=false，「這次沒檢查到的」寫明 pip install pymupdf pillow',
  r.code === 0 && j && j.pass === false && j.unchecked.some((u) => u.startsWith('視覺檢查：') && /PyMuPDF、Pillow/.test(u) && /pip install pymupdf pillow/.test(u)),
  `code=${r.code} ${r.out.slice(0, 300)}`);
r = check([pdf, '--json'], { DR_PYTHON: bare });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('pdf 缺 pypdf → 不擋（exit 0），pass=false，內容列進「這次沒檢查到的」並寫明 pip install pypdf',
  r.code === 0 && j && j.pass === false && j.unchecked.some((u) => u.startsWith('文件內容：') && /pip install pypdf/.test(u)),
  `code=${r.code} ${r.out.slice(0, 300)}`);
// 套件裝了但載入失敗（假 fitz 丟 DLL 載入失敗）是真正的錯誤，不能說成「沒裝」：仍 exit 2
const fakeDir = path.join(tmp, 'fake-fitz');
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'fitz.py'), "raise ImportError('DLL load failed while importing _fitz')\n");
r = check([pdf, '--visual', '--json'], { PYTHONPATH: fakeDir });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('PyMuPDF 裝了但載入失敗 → 仍 exit 2、visual_error 有原因，不當成缺套件',
  r.code === 2 && j && j.pass === false && !!j.visual_error && !j.unchecked.some((u) => u.startsWith('視覺檢查：')), `code=${r.code} ${r.out.slice(0, 300)}`);
// 印不出約定字串的「python」（這裡拿 node 冒充，等同 Store 捷徑或找不到直譯器的啟動器）＝沒有能用的 Python：提醒、不擋
r = check([pdf, '--visual', '--json'], { DR_VISUAL_PYTHON: process.execPath });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('不能用的 python（Store 捷徑這類）→ 當成沒有 Python，提醒去裝、不擋',
  r.code === 0 && j && j.pass === false && j.unchecked.some((u) => u.startsWith('視覺檢查：') && /安裝 Python 3/.test(u)), `code=${r.code} ${r.out.slice(0, 300)}`);

// 啟動設定（sitecustomize）先印一行字的 Python 仍是能用的 Python：照常讀內容、照常跑視覺檢查
const scDir = path.join(tmp, 'sitecustomize');
fs.mkdirSync(scDir, { recursive: true });
fs.writeFileSync(path.join(scDir, 'sitecustomize.py'), "print('本機環境由 Codex 設定')" + String.fromCharCode(10));
r = check([pdf, '--visual', '--json'], { PYTHONPATH: scDir });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('Python 啟動時先印別的字（含禁詞）→ 仍認得 Python，內容與視覺檢查照常跑，印的字不混進 PDF 正文',
  r.code === 0 && j && j.pass === true && j.visual && j.unchecked.every((u) => !u.startsWith('視覺檢查：') && !u.startsWith('文件內容：')),
  `code=${r.code} ${r.out.slice(0, 300)}`);

// 查不出套件裝了沒（模組查詢本身出錯）＝讀取失敗 exit 2，不可說成沒裝而放行
const LF = String.fromCharCode(10);
const boomDir = path.join(tmp, 'finder-boom');
fs.mkdirSync(boomDir, { recursive: true });
fs.writeFileSync(path.join(boomDir, 'sitecustomize.py'), [
  'import sys',
  'class Boom:',
  '    def find_spec(self, name, path=None, target=None):',
  "        if name in ('pypdf', 'fitz'): raise RuntimeError('模組查詢故障')",
  'sys.meta_path.insert(0, Boom())', ''].join(LF));
r = check([pdf, '--json'], { PYTHONPATH: boomDir });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 讀不到時腳本印的是文字 */ }
t('查不出 pypdf 裝了沒（查詢故障）→ exit 2、寫明無法確認，不當成缺套件', r.code === 2 && /無法確認套件 pypdf/.test(r.out), `code=${r.code} ${r.out.slice(0, 300)}`);
r = check([pdf, '--visual', '--json'], { PYTHONPATH: boomDir, DR_PYTHON: path.join(tmp, 'no-such-python.exe') });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('查不出 PyMuPDF 裝了沒 → 視覺檢查 exit 2、visual_error 寫明無法確認，不列成缺套件',
  r.code === 2 && j && /無法確認 PyMuPDF/.test(j.visual_error || '') && !j.unchecked.some((u) => u.startsWith('視覺檢查：')), `code=${r.code} ${r.out.slice(0, 300)}`);
// 版本太舊的 Python（這裡用 sitecustomize 把版本改成 2.7 模擬）＝不能用：提醒要裝 3.8 以上、不擋
const oldDir = path.join(tmp, 'old-python');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'sitecustomize.py'), ['import sys', 'sys.version_info = (2, 7, 18)', ''].join(LF));
r = check([pdf, '--json'], { PYTHONPATH: oldDir });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('Python 版本不到 3.8 → 當成沒有能用的 Python，提醒裝 3.8 以上、不擋',
  r.code === 0 && j && j.pass === false && j.unchecked.some((u) => u.startsWith('文件內容：') && /3\.8 以上/.test(u)), `code=${r.code} ${r.out.slice(0, 300)}`);

// 啟動設定印字不換行（print(..., end='')）：Python 輸出的每個判讀點都不能黏住，內容與屬性照常讀
const tailDir = path.join(tmp, 'no-newline');
fs.mkdirSync(tailDir, { recursive: true });
fs.writeFileSync(path.join(tailDir, 'sitecustomize.py'), "print('環境提示', end='')" + LF);
const xlsxNl = path.join(tmp, 'nl.xlsx');
py(`
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
    z.writestr('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>正常內容</t></is></c></row></sheetData></worksheet>')
    z.writestr('docProps/core.xml', '<cp:coreProperties xmlns:cp="c" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>報價</dc:title></cp:coreProperties>')
`, xlsxNl);
const nlBad = [];
for (const f of [pdf, xlsxNl]) {
  r = check([f, '--json'], { PYTHONPATH: tailDir });
  j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
  if (!(r.code === 0 && j && j.pass === true && j.metadata && j.unchecked.every((u) => !u.startsWith('文件內容：')))) nlBad.push(`${path.basename(f)} code=${r.code} ${r.out.slice(0, 200)}`);
}
t('啟動設定印字不換行 → pdf、xlsx 的內容與文件屬性照常讀到（不誤判成沒有 Python）', nlBad.length === 0, nlBad.join(' ｜ '));
r = check([pdf, '--visual', '--json'], { PYTHONPATH: tailDir });
j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
t('啟動設定印字不換行 → 視覺檢查照常跑完（visual_check.py 的 JSON 不黏在啟動訊息後）',
  r.code === 0 && j && j.visual && j.visual_error === null, `code=${r.code} ${r.out.slice(0, 300)}`);
{
  // visual_check.py 的錯誤訊息（--json）同樣要獨占最後一行，呼叫端才讀得到原因
  const vc = spawnSync(core.findPython(), [path.join(ROOT, 'skills', 'check-before', 'scripts', 'visual_check.py'), path.join(tmp, 'no-such.pdf'), '--json'],
    { encoding: 'utf8', env: { ...process.env, PYTHONPATH: tailDir } });
  let vj = null; try { vj = JSON.parse(String(vc.stdout).trim().split(/\r?\n/).pop()); } catch (_) { /* 下面判斷 */ }
  t('啟動設定印字不換行 → visual_check.py 的錯誤 JSON 仍獨占最後一行', vc.status === 2 && vj && vj.ok === false && !!vj.error, String(vc.stdout).slice(0, 200));
}

// Stop hook：Python 本身沒跑成而沒檢查的 pdf 不擋，但一定列出來提醒（不可靜默略過）
{
  const HOOK = path.join(ROOT, 'hooks', 'doc-readability-gate.js');
  const hook = (env, doc = pdf) => {
    const tp = path.join(tmp, 'tr.jsonl');
    const lines = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: '幫我交付' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'deliver-report:deliver-report' } }] } },
      { type: 'user', promptId: 'p1', toolUseResult: { success: true }, message: { role: 'user', content: [] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: `報告在 \`${path.basename(doc)}\`，請過目。` }] } },
    ];
    fs.writeFileSync(tp, lines.map((o) => JSON.stringify(o)).join(LF) + LF);
    const h = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: path.dirname(pdf), transcript_path: tp, stop_hook_active: false }),
      encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
    try { const o = JSON.parse(h.stdout); return { d: o.decision || 'warn', t: o.reason || o.systemMessage || '' }; } catch (_) { return { d: 'allow', t: '' }; }
  };
  let h = hook({ PYTHONPATH: boomDir });
  t('Stop hook：查不出 pypdf 裝了沒的 pdf 不擋，但列出檔名提醒（不靜默放行）', h.d === 'warn' && h.t.includes(path.basename(pdf)) && h.t.includes('沒跑成'), h.d + ' ' + h.t);
  const cutDir = path.join(tmp, 'cut-output');
  fs.mkdirSync(cutDir, { recursive: true });
  fs.writeFileSync(path.join(cutDir, 'sitecustomize.py'),
    ['import sys, os', "if 'DR_PDF_TEXT_BEGIN' in sys.argv:", '    os._exit(0)', ''].join(LF));
  h = hook({ PYTHONPATH: cutDir });
  t('Stop hook：抽 pdf 文字的輸出不完整（沒有分隔標記）不擋，但列出檔名提醒', h.d === 'warn' && h.t.includes(path.basename(pdf)) && h.t.includes('沒跑成'), h.d + ' ' + h.t);
  // 檔案本身壞掉是資料問題：Stop hook 照舊略過（不說成 Python 沒跑成），check-before 寫明讀不到並 exit 2
  const brokenPdf = path.join(path.dirname(pdf), 'broken.pdf');
  fs.writeFileSync(brokenPdf, '這不是 PDF');
  h = hook({}, brokenPdf);
  t('Stop hook：壞掉的 pdf 照舊略過，不列成「檢查沒跑成」', h.d === 'allow', h.d + ' ' + h.t);
  r = check([brokenPdf, '--json']);
  t('壞掉的 pdf → check-before exit 2、寫明 PDF 內容讀不到', r.code === 2 && r.out.includes('PDF 內容讀不到'), `code=${r.code} ${r.out.slice(0, 300)}`);
  // 錯誤原文可能夾帶文件裡的字：三條錯誤路徑（屬性資料、內容讀不到、Python 異常結束）印出前都要遮蔽個資
  const leakDir = path.join(tmp, 'leak');
  fs.mkdirSync(leakDir, { recursive: true });
  fs.writeFileSync(path.join(leakDir, 'sitecustomize.py'), [
    'import sys',
    'if sys.argv and sys.argv[-1] == "DR_PDF_UNREADABLE":',
    '    import pypdf',
    '    def _bad(self, *a, **k): raise ValueError("聯絡 0912-345-678")',
    '    pypdf.PdfReader.__init__ = _bad',
    'elif len(sys.argv) == 2 and sys.argv[1].lower().endswith(".pdf"):',
    '    import pypdf',
    '    def _badm(self): raise ValueError("聯絡 0912-345-678")',
    '    pypdf.PdfReader.metadata = property(_badm)',
    'elif any("office_xml" in a for a in sys.argv):',
    '    raise SystemExit("聯絡 0912-345-678")', ''].join(LF));
  const leaks = [];
  r = check([pdf, '--json'], { PYTHONPATH: leakDir });
  if (r.code !== 2 || !r.out.includes('PDF 內容讀不到')) leaks.push(`內容 code=${r.code}`);
  if (r.out.includes('0912-345-678')) leaks.push('內容讀不到的訊息含電話');
  const okPdf = path.join(tmp, 'leak-meta.pdf');
  fs.copyFileSync(pdf, okPdf);
  const metaOnlyDir = path.join(tmp, 'leak-meta');
  fs.mkdirSync(metaOnlyDir, { recursive: true });
  fs.writeFileSync(path.join(metaOnlyDir, 'sitecustomize.py'), [
    'import sys',
    'if len(sys.argv) == 2 and sys.argv[1].lower().endswith(".pdf"):',
    '    import pypdf',
    '    def _badm(self): raise ValueError("聯絡 0912-345-678")',
    '    pypdf.PdfReader.metadata = property(_badm)', ''].join(LF));
  r = check([okPdf, '--json'], { PYTHONPATH: metaOnlyDir });
  if (!r.out.includes('文件屬性未檢查')) leaks.push(`屬性 code=${r.code}`);
  if (r.out.includes('0912-345-678')) leaks.push('屬性資料錯誤的訊息含電話');
  const leakDocx = path.join(tmp, 'leak.docx');
  py(`
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>')
    z.writestr('docProps/core.xml', '<cp:coreProperties xmlns:cp="c" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>報價</dc:title></cp:coreProperties>')
`, leakDocx);
  r = check([leakDocx], { PYTHONPATH: leakDir });
  if (r.code !== 2) leaks.push(`Python 異常結束 code=${r.code}`);
  if (r.out.includes('0912-345-678')) leaks.push('Python 異常結束的訊息含電話');
  t('三條錯誤路徑印出的例外原文都先遮蔽個資', leaks.length === 0, leaks.join('；') + ' ｜ ' + r.out.slice(0, 200));
  // 視覺檢查：異常結束的 stderr、visual_check.py 自己回報的錯誤、缺陷引用的原文片段，印出前都先遮蔽
  // （引用片段在 visual_check.py 已截到 14 字，這裡用剛好放得下的號碼，截斷後殘留的部分號碼是已知限制）
  const vleaks = [];
  const vCrashDir = path.join(tmp, 'visual-leak-crash');
  fs.mkdirSync(vCrashDir, { recursive: true });
  fs.writeFileSync(path.join(vCrashDir, 'sitecustomize.py'), [
    'import sys',
    'if any("visual_check" in a for a in sys.argv):',
    '    raise SystemExit("聯絡 0912-345-678")', ''].join(LF));
  r = check([pdf, '--visual', '--json'], { PYTHONPATH: vCrashDir });
  if (r.code !== 2) vleaks.push(`異常結束 code=${r.code}`);
  if (r.out.includes('0912-345-678')) vleaks.push('異常結束的 stderr 含電話');
  const vOpenDir = path.join(tmp, 'visual-leak-open');
  fs.mkdirSync(vOpenDir, { recursive: true });
  fs.writeFileSync(path.join(vOpenDir, 'sitecustomize.py'), [
    'import sys',
    'if any("visual_check" in a for a in sys.argv):',
    '    import fitz',
    '    def _bad(*a, **k): raise RuntimeError("聯絡 0912-345-678")',
    '    fitz.open = _bad', ''].join(LF));
  r = check([pdf, '--visual', '--json'], { PYTHONPATH: vOpenDir });
  j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
  if (!(r.code === 2 && j && j.visual_error)) vleaks.push(`開檔失敗 code=${r.code} ${r.out.slice(0, 120)}`);
  if (r.out.includes('0912-345-678')) vleaks.push('visual_check.py 回報的錯誤含電話');
  const phonePdf = path.join(tmp, 'phone-overlap.pdf');
  py(`
import sys, fitz
d = fitz.open(); pg = d.new_page(width=400, height=300)
pg.insert_text((40, 80), "0912-345-678", fontsize=14)
pg.insert_text((42, 81), "0912-345-678", fontsize=14)
d.save(sys.argv[1])
`, phonePdf);
  r = check([phonePdf, '--visual', '--json']);
  j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
  if (!(j && j.visual && j.bad.some((b) => b.startsWith('視覺 ')))) vleaks.push(`疊字沒被抓到 code=${r.code} ${r.out.slice(0, 200)}`);
  if (r.out.includes('0912-345-678')) vleaks.push('視覺缺陷引用的原文含電話');
  t('視覺檢查印出的錯誤與原文片段都先遮蔽個資', vleaks.length === 0, vleaks.join('；'));
  // 引用片段長於截短長度：要先遮蔽再截，不能截成「Tel 0912-345-6…」殘留前幾碼；提醒（字級太小）同樣處理
  const longPdf = path.join(tmp, 'phone-long.pdf');
  py(`
import sys, fitz
d = fitz.open(); pg = d.new_page(width=400, height=300)
pg.insert_text((40, 80), "Tel 0912-345-678 call now", fontsize=14)
pg.insert_text((42, 81), "Tel 0912-345-678 call now", fontsize=14)
pg.insert_text((40, 200), "Fax 0912-345-678 tiny print", fontsize=5)
d.save(sys.argv[1])
`, longPdf);
  r = check([longPdf, '--visual', '--json']);
  j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
  const vb = j ? j.bad.filter((b) => b.startsWith('視覺 ')) : [];
  const vn = j ? j.notes.filter((n) => n.startsWith('視覺 ')) : [];
  const quoteOk = (s) => !/0912|345-6/.test(s) && !/[\ue000-\ue002]/.test(s);
  t('視覺引用片段長於截短長度 → 先遮蔽再截，缺陷與提醒都不殘留號碼、不留標記字元，片段仍有截短',
    vb.length > 0 && vn.some((n) => n.includes('已遮蔽')) && vb.concat(vn).every(quoteOk) && vb.some((b) => /已遮蔽[^」]*…」|…」/.test(b)),
    `code=${r.code} ${JSON.stringify(vb.concat(vn))}`);
  let mf = '';
  try { mf = fs.readFileSync(j.visual.manifest, 'utf8'); JSON.parse(mf); } catch (e) { mf = 'ERR ' + e.message; }
  t('視覺清單檔（manifest）也是遮蔽後的版本：可解析、不含號碼與標記字元', !mf.startsWith('ERR') && mf.includes('已遮蔽') && quoteOk(mf), mf.slice(0, 300));
  // 直接執行 visual_check.py（不帶 --raw-quotes）：環境裡有同名變數也照舊截短，不印標記字元
  const direct = spawnSync(core.findPython(), [path.join(ROOT, 'skills', 'check-before', 'scripts', 'visual_check.py'), longPdf],
    { encoding: 'utf8', env: { ...process.env, DR_VISUAL_RAW_QUOTES: '1', PYTHONIOENCODING: 'utf-8' } });
  t('直接執行 visual_check.py 照舊截短、不印標記字元（環境變數不會誤開完整片段模式）',
    !/[\ue000-\ue002]/.test(direct.stdout) && direct.stdout.includes('…」'), String(direct.stdout).slice(0, 300));
  // 正文裡剛好有一行是讀不到的標記字串：仍是讀到的正文，不可誤判成讀不到
  const markerPdf = path.join(tmp, 'marker-text.pdf');
  py(`
import sys, fitz
d = fitz.open(); pg = d.new_page(width=400, height=300)
pg.insert_text((40, 80), "DR_PDF_UNREADABLE", fontsize=14)
pg.insert_text((40, 150), "normal second line", fontsize=14)
d.save(sys.argv[1])
`, markerPdf);
  r = check([markerPdf]);
  t('正文含讀不到標記字串的 pdf 照常讀（不誤判成讀不到）', r.code !== 2 && /段落：[1-9]/.test(r.out) && !r.out.includes('讀不到'), `code=${r.code} ${r.out.slice(0, 300)}`);
  // 視覺檢查印完成功結果後才異常結束（結束碼 9）：不算跑完
  const lateDir = path.join(tmp, 'visual-late-exit');
  fs.mkdirSync(lateDir, { recursive: true });
  fs.writeFileSync(path.join(lateDir, 'sitecustomize.py'), [
    'import sys, os, atexit',
    'if any("visual_check" in a for a in sys.argv):',
    '    atexit.register(lambda: os._exit(9))', ''].join(LF));
  const visBase = path.join(os.tmpdir(), 'deliver-report-visual');
  const before = new Set(fs.existsSync(visBase) ? fs.readdirSync(visBase) : []);
  r = check([pdf, '--visual', '--json'], { PYTHONPATH: lateDir });
  j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
  t('視覺檢查印出成功結果後才異常結束 → exit 2、visual_error 寫明沒有正常結束',
    r.code === 2 && j && j.pass === false && /沒有正常結束/.test(j.visual_error || ''), `code=${r.code} ${r.out.slice(0, 300)}`);
  // 這次跑出來的資料夾：有頁面圖（確認找對資料夾），但清單檔已刪（裡面是沒遮蔽的完整原文）
  const fresh = fs.readdirSync(visBase).filter((d) => !before.has(d) && d.startsWith(path.basename(pdf, '.pdf') + '-')).map((d) => path.join(visBase, d));
  // check-before 一律指定輸出資料夾：7 天前的舊輸出仍要清掉（只清本工具格式的資料夾，其他名稱不動）
  const oldDir = path.join(visBase, 'zz-old-20200101-000000-abcdef');
  const keepDir = path.join(visBase, 'zz-not-ours');
  for (const d of [oldDir, keepDir]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'page-001.png'), 'x');
    const old = (Date.now() - 8 * 86400 * 1000) / 1000;
    fs.utimesSync(d, old, old);
  }
  check([pdf, '--visual', '--json']);
  t('check-before 跑視覺檢查時清掉 7 天前的舊輸出、不動別的名稱', !fs.existsSync(oldDir) && fs.existsSync(keepDir), `old=${fs.existsSync(oldDir)} keep=${fs.existsSync(keepDir)}`);
  for (const d of [oldDir, keepDir]) fs.rmSync(d, { recursive: true, force: true });   // 斷言失敗時也不留在暫存區
  // TMPDIR 與 TEMP 指向不同地方（Windows 上 Node 不看 TMPDIR、Python 先看它）：舊輸出仍要清到 check-before 放輸出的那裡。
  // 只有 Windows 分得出改之前與改之後；其他平台 Node 也看 TMPDIR，兩邊本來就一致
  {
    const otherTmp = path.join(tmp, 'other-tmpdir');
    fs.mkdirSync(otherTmp, { recursive: true });
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'page-001.png'), 'x');
    const old = (Date.now() - 8 * 86400 * 1000) / 1000;
    fs.utimesSync(oldDir, old, old);
    check([pdf, '--visual', '--json'], { TMPDIR: otherTmp });
    t('TMPDIR 與 TEMP 不同時，check-before 仍清掉放輸出那裡的 7 天前舊輸出', !fs.existsSync(oldDir), 'old=' + fs.existsSync(oldDir));
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.rmSync(otherTmp, { recursive: true, force: true });
  }
  // --out 指到格式相符的舊資料夾本身或它底下：不能先被清掉（原有的檔案要留著）
  const vcPath = path.join(ROOT, 'skills', 'check-before', 'scripts', 'visual_check.py');
  const reuse = [];
  for (const [owner, out] of [['zz-reuse-20200101-000000-abcdef', ''], ['zz-parent-20200101-000000-abcdef', 'sub']]) {
    const od = path.join(visBase, owner);
    fs.mkdirSync(od, { recursive: true });
    fs.writeFileSync(path.join(od, 'keep.txt'), 'x');
    const old = (Date.now() - 8 * 86400 * 1000) / 1000;
    fs.utimesSync(od, old, old);
    spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', path.join(od, out)], { encoding: 'utf8' });
    if (!fs.existsSync(path.join(od, 'keep.txt'))) reuse.push(owner);
    fs.rmSync(od, { recursive: true, force: true });
  }
  t('--out 指到格式相符的舊資料夾或它底下 → 不被清理刪掉', reuse.length === 0, '被刪：' + reuse.join('、'));
  // 經別名（junction／符號連結）指到舊資料夾本身或它底下：路徑字串對不上，仍要認得是同一個資料夾
  const aliased = [];
  for (const [owner, sub, target] of [['zz-alias-20200101-000000-abcdef', '', ''], ['zz-aliasp-20200101-000000-abcdef', 'sub', ''], ['zz-aliast-20200101-000000-abcdef', '', 'inner']]) {
    const od = path.join(visBase, owner);
    fs.mkdirSync(path.join(od, target), { recursive: true });
    fs.writeFileSync(path.join(od, 'keep.txt'), 'x');
    const old = (Date.now() - 8 * 86400 * 1000) / 1000;
    fs.utimesSync(od, old, old);
    const link = path.join(tmp, 'link-' + owner);
    try { fs.symlinkSync(path.join(od, target), link, 'junction'); } catch (e) { aliased.push(`${owner}（建不了別名：${e.code}）`); fs.rmSync(od, { recursive: true, force: true }); continue; }
    spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', path.join(link, sub)], { encoding: 'utf8' });
    if (!fs.existsSync(path.join(od, 'keep.txt'))) aliased.push(owner);
    fs.rmSync(link, { force: true, recursive: false });
    fs.rmSync(od, { recursive: true, force: true });
  }
  t('--out 經別名（junction）指到格式相符的舊資料夾、它底下、或連結本身指向它底下的子目錄 → 不被清理刪掉', aliased.length === 0, '被刪或測不了：' + aliased.join('、'));
  // 連結一層接一層：外部 junction → 舊資料夾/inner，舊資料夾/inner/jump → 另一個外部資料夾，--out 指 外部 junction/jump/new
  {
    const od = path.join(visBase, 'zz-chain-20200101-000000-abcdef');
    const ext = path.join(tmp, 'chain-ext');
    const l1 = path.join(tmp, 'chain-l1');
    fs.mkdirSync(path.join(od, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(od, 'keep.txt'), 'x');
    fs.mkdirSync(ext, { recursive: true });
    let why = '';
    try {
      fs.symlinkSync(ext, path.join(od, 'inner', 'jump'), 'junction');
      fs.symlinkSync(path.join(od, 'inner'), l1, 'junction');
      const old = (Date.now() - 8 * 86400 * 1000) / 1000;
      fs.utimesSync(od, old, old);
      spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', path.join(l1, 'jump', 'new')], { encoding: 'utf8' });
      if (!fs.existsSync(path.join(od, 'keep.txt'))) why = '舊資料夾被刪';
    } catch (e) { why = `建不了別名：${e.code}`; }
    t('--out 經兩層串接的 junction 穿過格式相符的舊資料夾 → 不被清理刪掉', why === '', why);
    try { fs.rmSync(path.join(od, 'inner', 'jump'), { force: true, recursive: false }); } catch (e) { /* 舊資料夾被刪時已不在 */ }
    fs.rmSync(l1, { force: true, recursive: false });
    fs.rmSync(od, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
  // 連結指向另一個連結：外部 junction → 舊資料夾/inner/jump（它本身又是 junction → 外部資料夾），--out 指 外部 junction/new
  {
    const od = path.join(visBase, 'zz-chain2-20200101-000000-abcdef');
    const ext = path.join(tmp, 'chain2-ext');
    const l1 = path.join(tmp, 'chain2-l1');
    fs.mkdirSync(path.join(od, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(od, 'keep.txt'), 'x');
    fs.mkdirSync(ext, { recursive: true });
    let why = '';
    try {
      fs.symlinkSync(ext, path.join(od, 'inner', 'jump'), 'junction');
      fs.symlinkSync(path.join(od, 'inner', 'jump'), l1, 'junction');
      const old = (Date.now() - 8 * 86400 * 1000) / 1000;
      fs.utimesSync(od, old, old);
      spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', path.join(l1, 'new')], { encoding: 'utf8' });
      if (!fs.existsSync(path.join(od, 'keep.txt'))) why = '舊資料夾被刪';
    } catch (e) { why = `建不了別名：${e.code}`; }
    t('--out 經「連結指向另一個連結」穿過格式相符的舊資料夾 → 不被清理刪掉', why === '', why);
    try { fs.rmSync(path.join(od, 'inner', 'jump'), { force: true, recursive: false }); } catch (e) { /* 舊資料夾被刪時已不在 */ }
    fs.rmSync(l1, { force: true, recursive: false });
    fs.rmSync(od, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
  // 暫存資料夾本身經過連結（macOS 的 /var → /private/var 同型）：check-before 照常指定專用資料夾底下的新資料夾時，
  // 舊輸出仍要清掉；--out 指到舊資料夾本身時仍不清
  {
    const realTmp = path.join(tmp, 'linked-tmp-real');
    const jt = path.join(tmp, 'linked-tmp');
    fs.mkdirSync(path.join(realTmp, 'deliver-report-visual'), { recursive: true });
    let why = '';
    try {
      fs.symlinkSync(realTmp, jt, 'junction');
      const lb = path.join(jt, 'deliver-report-visual');
      const env = { ...process.env, TEMP: jt, TMP: jt, TMPDIR: jt };
      const old = (Date.now() - 8 * 86400 * 1000) / 1000;
      const mk = (name) => { const d = path.join(lb, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'keep.txt'), 'x'); fs.utimesSync(d, old, old); return d; };
      const gone = mk('zz-gone-20200101-000000-abcdef');
      spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', path.join(lb, 'zz-new-20991231-000000-abcdef')], { encoding: 'utf8', env });
      if (fs.existsSync(gone)) why += '舊輸出沒被清掉；';
      const reuse = mk('zz-reuse2-20200101-000000-abcdef');
      spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', reuse], { encoding: 'utf8', env });
      if (!fs.existsSync(path.join(reuse, 'keep.txt'))) why += '--out 指到的舊資料夾被刪；';
    } catch (e) { why = `建不了別名：${e.code}`; }
    t('暫存資料夾經過連結時：照常清掉舊輸出、--out 指到的舊資料夾不清', why === '', why);
    fs.rmSync(jt, { force: true, recursive: false });
    fs.rmSync(realTmp, { recursive: true, force: true });
  }
  // 暫存資料夾本身是連結、繞經專用資料夾底下某個舊輸出裡的連結：那個舊輸出不刪（刪了暫存資料夾就斷了）
  {
    const work = path.join(tmp, 'loop-tmp');
    const realT = path.join(work, 'R');
    const od = path.join(realT, 'deliver-report-visual', 'zz-loop-20200101-000000-abcdef');
    const T = path.join(work, 'T');
    fs.mkdirSync(path.join(od, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(od, 'keep.txt'), 'x');
    let why = '';
    try {
      fs.symlinkSync(realT, path.join(od, 'inner', 'jump'), 'junction');
      fs.symlinkSync(path.join(od, 'inner', 'jump'), T, 'junction');
      const old = (Date.now() - 8 * 86400 * 1000) / 1000;
      fs.utimesSync(od, old, old);
      const env = { ...process.env, TEMP: T, TMP: T, TMPDIR: T };
      const rr = spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', path.join(T, 'deliver-report-visual', 'zz-loopnew-20991231-000000-abcdef')], { encoding: 'utf8', env });
      if (!fs.existsSync(path.join(od, 'inner', 'jump'))) why += '舊輸出裡的連結被刪；';
      if (!fs.existsSync(path.join(od, 'keep.txt'))) why += '舊輸出被刪；';
      if (rr.status !== 0 && rr.status !== 1) why += '視覺檢查沒跑完（exit ' + rr.status + '）；';
    } catch (e) { why = '建不了別名：' + e.code; }
    t('暫存資料夾經舊輸出裡的連結繞回時，那個舊輸出不刪、視覺檢查照常跑完', why === '', why);
    try { fs.rmSync(path.join(od, 'inner', 'jump'), { force: true, recursive: false }); } catch (e) { /* 已不在 */ }
    try { fs.rmSync(T, { force: true, recursive: false }); } catch (e) { /* 已不在 */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
  // 同一個資料夾的另一種寫法（Windows 8.3 短檔名）：路徑字串對不上，要靠實際檔案身分認出 --out 就是舊資料夾
  if (process.platform === 'win32') {
    const od = path.join(visBase, 'zz-shortname-20200101-000000-abcdef');
    fs.mkdirSync(od, { recursive: true });
    fs.writeFileSync(path.join(od, 'keep.txt'), 'x');
    const old = (Date.now() - 8 * 86400 * 1000) / 1000;
    fs.utimesSync(od, old, old);
    const sp = spawnSync(core.findPython(), ['-c', 'import ctypes,sys\nb=ctypes.create_unicode_buffer(1024)\nctypes.windll.kernel32.GetShortPathNameW(sys.argv[1],b,1024)\nprint(b.value)', od], { encoding: 'utf8' });
    const short = (sp.stdout || '').trim().split(/\r?\n/).pop();
    // 8.3 短檔名可在磁碟層關掉（正常、受支援的設定），沒有時這項跳過、不算失敗
    if (!short || short.toLowerCase() === od.toLowerCase()) console.log('SKIP  --out 用 8.3 短檔名指到舊資料夾（這台磁碟沒有 8.3 短檔名）');
    else {
      spawnSync(core.findPython(), [vcPath, pdf, '--json', '--out', short], { encoding: 'utf8' });
      t('--out 用 8.3 短檔名指到格式相符的舊資料夾 → 不被清理刪掉', fs.existsSync(path.join(od, 'keep.txt')), '舊資料夾被刪');
    }
    fs.rmSync(od, { recursive: true, force: true });
  }

  t('寫完清單才異常結束 → 清單檔刪掉、頁面圖留著',
    fresh.length === 1 && fs.existsSync(path.join(fresh[0], 'page-001.png')) && !fs.existsSync(path.join(fresh[0], 'visual-manifest.json')),
    JSON.stringify(fresh.map((d) => [d, fs.readdirSync(d)])));
}

// PDF 文件屬性：檔案的屬性資料讀不了是資料問題（提醒）；Python 沒回傳結果是執行錯誤（exit 2）
{
  const badMetaDir = path.join(tmp, 'pdf-bad-meta');
  fs.mkdirSync(badMetaDir, { recursive: true });
  fs.writeFileSync(path.join(badMetaDir, 'sitecustomize.py'), [
    'import sys',
    'if len(sys.argv) == 2 and sys.argv[1].lower().endswith(".pdf"):',
    '    import pypdf',
    '    def _bad(self): raise ValueError("屬性字典損毀")',
    '    pypdf.PdfReader.metadata = property(_bad)', ''].join(LF));
  r = check([pdf, '--json'], { PYTHONPATH: badMetaDir });
  j = null; try { j = JSON.parse(r.out); } catch (_) { /* 下面判斷 */ }
  t('PDF 屬性資料損毀（pypdf 讀屬性拋錯）→ 記成「文件屬性未檢查」提醒、不 exit 2',
    r.code === 0 && j && j.metadata === null && j.notes.some((n) => n.startsWith('文件屬性未檢查') && n.includes('屬性字典損毀')), `code=${r.code} ${r.out.slice(0, 300)}`);
  const noOutDir = path.join(tmp, 'pdf-meta-no-output');
  fs.mkdirSync(noOutDir, { recursive: true });
  fs.writeFileSync(path.join(noOutDir, 'sitecustomize.py'), [
    'import sys, os',
    'if len(sys.argv) == 2 and sys.argv[1].lower().endswith(".pdf"):',
    '    os._exit(0)', ''].join(LF));
  r = check([pdf, '--json'], { PYTHONPATH: noOutDir });
  t('讀 PDF 屬性的 Python 沒有回傳結果 → exit 2（不降成提醒）', r.code === 2 && r.out.includes('沒有回傳結果'), `code=${r.code} ${r.out.slice(0, 300)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
