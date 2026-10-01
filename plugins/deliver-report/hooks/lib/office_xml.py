#!/usr/bin/env python3
"""office_xml.py — 讀 Office 檔裡的 XML，給 readability-scan.core.js 呼叫（只用 Python 標準庫）。

用法：python office_xml.py xlsx <檔案>   → 工作表文字、共用字串、儲存格註解
      python office_xml.py meta <檔案>   → docx／pptx／xlsx 的文件屬性（docProps）
輸出：一行 JSON。

為什麼交給 Python：XML 的格式規則（命名空間前綴、CDATA、註解、處理指令、實體字元、標籤配對）
用正則或自寫解析器怎麼補都有漏網的寫法；標準庫的 expat 是完整的 XML 解析器，格式錯就報錯。
DTD（<!DOCTYPE>）Office 檔不會有，一律當讀不到，不讓 expat 展開自訂實體；由 expat 判斷，UTF-16 編碼的檔也擋得到。
"""
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.parsers import expat

MAX_PART = 256 * 1024 * 1024   # 單一檔案解壓上限：異常的 zip 不能一次吃光記憶體（超過＝讀不到）


def local(tag):
    """去掉命名空間：{http://...}row → row"""
    return tag.rsplit('}', 1)[-1] if isinstance(tag, str) else ''


def kids(el, name):
    return [c for c in el if local(c.tag) == name]


def descendants(el, name):
    it = el.iter()
    next(it)   # 不含自己
    return [c for c in it if local(c.tag) == name]


def all_text(el):
    return ''.join(el.itertext())


def cell_text(el):
    """依序接起所有 <t>（rich text 分段也接）；拼音標註（<rPh>）是日文讀音，不是儲存格內容"""
    skip = set()
    for r in el.iter():
        if local(r.tag) == 'rPh':
            skip.update(id(x) for x in r.iter())
    return ''.join(all_text(t) for t in el.iter() if local(t.tag) == 't' and id(t) not in skip)


def read_part(z, name):
    """讀出並解析一個 XML；不存在、太大、有 DTD、格式錯都丟例外"""
    info = z.getinfo(name)
    if info.file_size > MAX_PART:
        raise ValueError('檔案過大')
    data = z.read(name)
    if has_dtd(data):
        raise ValueError('含 DTD 宣告')
    return ET.fromstring(data)


class _Found(Exception):
    pass


class _Stop(Exception):
    pass


def has_dtd(data):
    """根元素之前有沒有 DTD 宣告。交給 expat 判斷編碼與註解，比對位元組會漏掉 UTF-16 的檔；讀到根元素就停，不必整份解析"""
    p = expat.ParserCreate()

    def doctype(*_):
        raise _Found()

    def start(*_):
        raise _Stop()
    p.StartDoctypeDeclHandler = doctype
    p.StartElementHandler = start
    try:
        p.Parse(data, True)
    except _Found:
        return True
    except (_Stop, expat.ExpatError):
        return False   # 格式錯交給後面的完整解析報錯
    return False


def resolve(base, target):
    return target[1:] if target.startswith('/') else posixpath.normpath(posixpath.join(base, target))


def read_xlsx(path):
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        return {'invalid': f'不是有效的 Excel 檔（{e}）'}
    names = set(z.namelist())
    # 讀不到的部分記在 broken：只掃得到其餘部分就放行，讀不到的那塊裡有什麼都看不到
    broken = []

    def doc(name, roots, label):
        root = None
        try:
            root = read_part(z, name) if name in names else None
        except Exception:
            root = None
        if root is not None and local(root.tag) in roots:
            return root
        if label:
            broken.append(label)
        return None

    def rels_of(root):
        return [r.attrib for r in kids(root, 'Relationship')]

    wb = doc('xl/workbook.xml', ['workbook'], None)
    wb_rels = doc('xl/_rels/workbook.xml.rels', ['Relationships'], None)
    if wb is None or wb_rels is None:
        return {'invalid': '讀不到活頁簿結構（xl/workbook.xml）'}
    target = {a.get('Id'): a.get('Target') for a in rels_of(wb_rels)}
    ss = doc('xl/sharedStrings.xml', ['sst'], '共用字串（xl/sharedStrings.xml）') if 'xl/sharedStrings.xml' in names else None
    shared = [cell_text(si) for si in kids(ss, 'si')] if ss is not None else []
    used = set()
    lost_refs = 0
    sheets = []
    comment_files = {}   # 當有序集合用：工作表關聯到的在前、依檔名找到的在後
    for sh in descendants(wb, 'sheet'):
        name = sh.get('name', '')
        state = sh.get('state', 'visible')
        # 關聯 id 的屬性帶命名空間（通常寫成 r:id）
        rid = next((v for k, v in sh.attrib.items() if k.endswith('}id')), None)
        t = target.get(rid) if rid else None
        sheet_path = resolve('xl', t) if t else None
        label = f'工作表「{name}」'
        root = doc(sheet_path, ['worksheet', 'chartsheet', 'dialogsheet', 'macrosheet'], label) if sheet_path else None
        if not sheet_path:
            broken.append(label)
        # 工作表關聯到的註解檔要真的在：關聯在、檔案不在，那張工作表的註解就整個沒掃到；
        # 關聯到的檔不論檔名叫什麼（../notes.xml）都要讀
        if sheet_path:
            rels_path = posixpath.join(posixpath.dirname(sheet_path), '_rels', posixpath.basename(sheet_path) + '.rels')
            sheet_rels = doc(rels_path, ['Relationships'], f'{label}的關聯檔') if rels_path in names else None
            for a in rels_of(sheet_rels) if sheet_rels is not None else []:
                if not re.search(r'/(?:comments|threadedComment)$', a.get('Type', ''), re.I) or not a.get('Target') \
                        or a.get('TargetMode') == 'External':
                    continue
                p = resolve(posixpath.dirname(sheet_path), a['Target'])
                if p in names:
                    comment_files[p] = True
                else:
                    broken.append(f'儲存格註解（{p}）')
        rows = []
        for row in descendants(root, 'row') if root is not None else []:
            cells = []
            for c in kids(row, 'c'):
                typ = c.get('t')
                v_el = next(iter(kids(c, 'v')), None)
                v = all_text(v_el) if v_el is not None else None
                if typ == 's':
                    if v is None:
                        continue
                    # 索引只收純數字：空白、0x1 這類寫法不能被當成第 0、1 筆。
                    # 去掉前導零後超過 9 位的算不存在：超長數字串在 Python 3.11 起轉整數會拋錯（位數上限），
                    # 共用字串也不可能多到十億筆；前導零（0000000000＝第 0 筆）仍是合法索引
                    s = v.strip()
                    digits = s.lstrip('0') or '0'
                    if not re.fullmatch(r'[0-9]+', s) or len(digits) > 9 or int(digits) >= len(shared):
                        lost_refs += 1
                        continue
                    idx = int(digits)
                    cells.append(shared[idx])
                    used.add(idx)
                elif typ == 'inlineStr':
                    is_el = next(iter(kids(c, 'is')), None)
                    if is_el is not None:
                        cells.append(cell_text(is_el))
                elif v:
                    cells.append(v)   # 數值、公式結果、布林
            if any(x.strip() for x in cells):
                rows.append('　'.join(cells))
        sheets.append({'name': name, 'state': state, 'rows': rows})
    orphan = [s for i, s in enumerate(shared) if i not in used]
    # Excel 存在 xl/comments1.xml，openpyxl 存在 xl/comments/comment1.xml，新式討論串在 xl/threadedComments/
    for n in z.namelist():
        if re.match(r'^xl/(?:[^/]+/)*(?:comments?\d*|threadedComment\d*)\.xml$', n, re.I):
            comment_files[n] = True
    comments = []
    for n in comment_files:
        root = doc(n, ['comments', 'ThreadedComments'], f'儲存格註解（{n}）')
        if root is None:
            continue
        # 舊式註解的文字分段放在 <text><r><t>；新式討論串直接寫在 <text> 裡
        for el in descendants(root, 'comment') + descendants(root, 'threadedComment'):
            text_el = next(iter(kids(el, 'text')), None)
            s = (cell_text(text_el) or all_text(text_el)).strip() if text_el is not None else ''
            if s:
                comments.append(s)
    if lost_refs:
        broken.append(f'{lost_refs} 個儲存格引用的共用字串（共用字串檔缺漏）')
    return {'sheets': sheets, 'shared': shared, 'orphan': orphan, 'comments': comments, 'broken': broken}


CORE_FIELDS = {'title': 'title', 'subject': 'subject', 'creator': 'creator', 'lastModifiedBy': 'lastModifiedBy',
               'description': 'description', 'keywords': 'keywords', 'category': 'category'}
APP_FIELDS = {'Company': 'company', 'Manager': 'manager', 'Application': 'application'}


def read_meta(path):
    try:
        z = zipfile.ZipFile(path)
    except Exception:
        return {'error': '讀不到文件屬性（不是有效的 Office 檔）'}
    names = set(z.namelist())
    out = {}
    for part, fields, root_name in (('docProps/core.xml', CORE_FIELDS, 'coreProperties'), ('docProps/app.xml', APP_FIELDS, 'Properties')):
        # 沒有這個檔＝沒有屬性（不算缺陷）；有但解不開或格式錯＝讀不到，不可當成檢查過
        if part not in names:
            continue
        try:
            root = read_part(z, part)
        except Exception as e:
            return {'error': f'讀不到文件屬性 {part}（{e}）'}
        # 根元素不對＝不是屬性檔，Office 不會從裡面讀屬性；當成空白屬性就等於說檢查過了
        if local(root.tag) != root_name:
            return {'error': f'讀不到文件屬性 {part}（根元素不是 {root_name}）'}
        for el in root:
            key = fields.get(local(el.tag))
            if not key:
                continue
            # 每個屬性在格式上只能出現一次；重複時對方軟體顯示哪一個說不準，只檢查其中一個等於沒檢查完
            if key in out:
                return {'error': f'讀不到文件屬性 {part}（{local(el.tag)} 重複出現）'}
            out[key] = all_text(el).strip()
    return {'meta': out}


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 3 or sys.argv[1] not in ('xlsx', 'meta'):
        print(json.dumps({'error': '用法：office_xml.py xlsx|meta <檔案>'}, ensure_ascii=False))
        sys.exit(2)
    mode, path = sys.argv[1], sys.argv[2]
    result = read_xlsx(path) if mode == 'xlsx' else read_meta(path)
    print()   # 先換行：啟動設定（sitecustomize）印字不換行時，JSON 才會獨占最後一行
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
