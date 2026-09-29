#!/usr/bin/env python3
"""
產生視覺檢查的測試文件（pptx／docx），每一份對應一種要抓或不能誤抓的狀況。
用法：python make_fixtures.py <輸出目錄>
依賴：python-pptx、python-docx（只有產測試檔需要，visual_check.py 本身不需要）
"""
import os
import sys
from pptx import Presentation
from pptx.util import Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_AUTO_SIZE
from lxml import etree

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

out = sys.argv[1] if len(sys.argv) > 1 else "fixtures"
os.makedirs(out, exist_ok=True)
IN = 914400  # 1 inch in EMU


def deck():
    p = Presentation()
    p.slide_width, p.slide_height = Emu(12192000), Emu(6858000)  # 16:9
    return p


def box(slide, x, y, w, h, text, size=20, wrap=True):
    tb = slide.shapes.add_textbox(Emu(int(x * IN)), Emu(int(y * IN)), Emu(int(w * IN)), Emu(int(h * IN)))
    tf = tb.text_frame
    tf.word_wrap = wrap
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.text = text
    for para in tf.paragraphs:
        for r in para.runs:
            r.font.size = Pt(size)
    return tb


def card(slide, x, y, w, h, text, size=18):
    sp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(int(x * IN)), Emu(int(y * IN)), Emu(int(w * IN)), Emu(int(h * IN)))
    sp.fill.solid()
    sp.fill.fore_color.rgb = RGBColor(0xDD, 0xEE, 0xFF)
    tf = sp.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.text = text
    for para in tf.paragraphs:
        for r in para.runs:
            r.font.size = Pt(size)
            r.font.color.rgb = RGBColor(0, 0, 0)
    return sp


LONG = "這是一段很長的說明文字，用來把方塊塞滿。" * 6

# 1 乾淨：標題＋兩欄內容，沒有任何問題（必須全綠）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
box(s, 0.6, 0.4, 12, 0.9, "專案時程總覽", 36)
box(s, 0.6, 1.6, 5.8, 3, "第一階段：需求訪談與現況盤點\n第二階段：系統設計", 20)
box(s, 6.8, 1.6, 5.8, 3, "第三階段：開發與測試\n第四階段：上線與教育訓練", 20)
p.save(os.path.join(out, "p01_clean.pptx"))

# 2 疊字：兩個文字方塊壓在一起（必須報疊字）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
box(s, 1, 1, 8, 1.2, "預計三月底完成系統上線作業", 28)
box(s, 1.3, 1.15, 8, 1.2, "驗收標準依合約附件二辦理", 28)
p.save(os.path.join(out, "p02_overlap.pptx"))

# 3 字跑出有底色的方塊（下方是空白，不會撞到別的字；必須報字跑出方塊外）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
card(s, 1, 1, 4, 1.2, LONG, 18)
p.save(os.path.join(out, "p03_card_overflow.pptx"))

# 4 字超出投影片底部（必須報超出頁面或文字被裁掉）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
box(s, 1, 7.2, 10, 1, "這一行放在投影片最底下，會超出畫面範圍", 28)  # 投影片高 7.5 吋，28pt 一行約 0.4 吋
p.save(os.path.join(out, "p04_offslide.pptx"))

# 5 字放在有底色的方塊上（正常設計，必須不報）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(int(0.5 * IN)), Emu(int(0.5 * IN)), Emu(int(12 * IN)), Emu(int(6 * IN)))
bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor(0x20, 0x40, 0x80)
t = box(s, 1, 1, 10, 1, "深色底上的白字標題", 32)
t.text_frame.paragraphs[0].runs[0].font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
card(s, 1, 2.5, 5, 2.5, "卡片內文，字數剛好裝得下", 20)
p.save(os.path.join(out, "p05_text_on_shape.pptx"))

# 6 表格被內容撐高、超出投影片（必須報超出頁面或文字被裁掉）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
rows = 9
tbl = s.shapes.add_table(rows, 3, Emu(int(0.5 * IN)), Emu(int(3 * IN)), Emu(int(12 * IN)), Emu(int(3 * IN))).table
for r in range(rows):
    for c in range(3):
        tbl.cell(r, c).text = "第 {} 列第 {} 欄的內容，文字比較長一點會換行".format(r + 1, c + 1)
p.save(os.path.join(out, "p06_table_tall.pptx"))

# 7 自動縮小文字縮到很小（必須提醒字太小）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
t = box(s, 1, 1, 5, 1.5, LONG * 2, 20)
bp = t.text_frame._txBody.find("{http://schemas.openxmlformats.org/drawingml/2006/main}bodyPr")
for ch in list(bp):
    bp.remove(ch)
na = etree.SubElement(bp, "{http://schemas.openxmlformats.org/drawingml/2006/main}normAutofit")
na.set("fontScale", "35000")
na.set("lnSpcReduction", "20000")
p.save(os.path.join(out, "p07_shrunk.pptx"))

# 8 同一段文字疊兩層、偏移 1pt（重複貼上；必須報）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
box(s, 1, 1, 9, 1, "重複貼上的文字方塊", 32)
box(s, 1 + 1 / 72, 1 + 1 / 72, 9, 1, "重複貼上的文字方塊", 32)
p.save(os.path.join(out, "p08_ghost.pptx"))

# 9 多頁混合：第 1 頁乾淨、第 2 頁疊字、第 3 頁空白（頁碼必須對）
p = deck()
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "第一頁沒有問題", 28)
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 8, 1, "第二頁上方文字", 28); box(s, 1.2, 1.1, 8, 1, "第二頁壓上來的字", 28)
s = p.slides.add_slide(p.slide_layouts[6])
p.save(os.path.join(out, "p09_multi.pptx"))

# 10 版面配置的佔位符（標題＋內容，沒有自己的座標，要從版面配置繼承；必須不報）
p = deck(); s = p.slides.add_slide(p.slide_layouts[1])
s.shapes.title.text = "使用內建版面配置的標題"
s.placeholders[1].text = "第一點\n第二點\n第三點"
p.save(os.path.join(out, "p10_placeholders.pptx"))

# 11 中間夾一張隱藏投影片（PowerPoint 不輸出隱藏頁；頁碼要對到未隱藏的投影片，必須不報）
p = deck()
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "第一張正常投影片", 28)
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "這一張是隱藏投影片的內容", 28)
s._element.set("show", "0")
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "第三張正常投影片", 28)
p.save(os.path.join(out, "p11_hidden_slide.pptx"))

# 11b 同上，但隱藏寫成 show="false"（XML 布林值的另一種合法寫法，必須同樣不報）
p = deck()
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "第一張正常投影片", 28)
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "這一張是隱藏投影片的內容", 28)
s._element.set("show", "false")
s = p.slides.add_slide(p.slide_layouts[6]); box(s, 1, 1, 10, 1, "第三張正常投影片", 28)
p.save(os.path.join(out, "p13_hidden_false.pptx"))

# 12 有底色的方塊裡一行不換行的長字，從方塊右側跑出去（必須報字跑出方塊外）
p = deck(); s = p.slides.add_slide(p.slide_layouts[6])
c = card(s, 1, 1, 3, 1, "這一行字不會自動換行所以會從方塊右邊跑出去", 20)
c.text_frame.word_wrap = False
p.save(os.path.join(out, "p12_card_wrap_none.pptx"))

# ---- docx ----
from docx import Document
from docx.shared import Pt as DPt

# 13 docx 乾淨（必須全綠）
d = Document()
d.add_heading("系統說明", 1)
for k in range(8):
    d.add_paragraph("第 {} 段說明文字，內容正常、行距正常，不應該被判為疊字。".format(k + 1) * 3)
d.save(os.path.join(out, "d11_clean.docx"))

# 14 docx 行距固定值太小：12pt 的字設固定行距 6pt，上下行互相壓到（必須報疊字）
d = Document()
para = d.add_paragraph("行距設得太小的段落，" * 30)
para.paragraph_format.line_spacing = DPt(6)
for r in para.runs:
    r.font.size = DPt(12)
d.save(os.path.join(out, "d12_tight_spacing.docx"))
# ---- pdf ----
import fitz

# 15 旋轉 90 度的頁面，字在未旋轉座標的右側（x=320，未旋轉寬 400、旋轉後寬 300）；必須不報超出頁面
d = fitz.open()
pg = d.new_page(width=400, height=300)
pg.insert_text((320, 100), "right", fontsize=14)
pg.insert_text((50, 200), "rotated page body text", fontsize=14)
pg.set_rotation(90)
d.save(os.path.join(out, "f15_rotated.pdf"))
print("fixtures ->", os.path.abspath(out))
