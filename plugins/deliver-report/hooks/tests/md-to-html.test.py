# md_to_html() 單元測試 —— 跑法：python hooks/tests/md-to-html.test.py
#
# 為什麼有這支：0.18.0 把段落從 <p> 改成 <br> 收尾時，段落間的空行整個消失
# （'段落一\n\n段落二' 產出 '段落一<br>\n段落二<br>'，兩段黏成連續行），
# 三輪對抗審查的第三輪才抓到——因為 md_to_html 當時沒有任何測試覆蓋間距。
# 白名單那支測試只管「標籤合不合法」，管不到「版面對不對」。
#
# 失敗時 exit 1（與 disallowed-tags.test.js 同一道紀律：只印字不設退出碼
# 等於接進 CI 或 hook 鏈會靜默通過）。
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', '..', 'skills', 'daily-report', 'scripts')
sys.path.insert(0, SCRIPTS)

from send_gmail import md_to_html  # noqa: E402

ok = 0
bad = 0


def t(md, expect, label):
    """expect 是完整輸出字串，逐字元比對——不只斷言『有沒有命中』。"""
    global ok, bad
    got = md_to_html(md)
    passed = got == expect
    if passed:
        ok += 1
        mark = 'PASS'
    else:
        bad += 1
        mark = '** FAIL **'
    print('  ' + mark.ljust(12) + label)
    if not passed:
        print('      期待: ' + repr(expect))
        print('      實得: ' + repr(got))


print('=== 段落間距（0.18.0 <p>→<br> 的回歸區）===')
t('段落一\n\n段落二', '段落一<br>\n<br>\n段落二<br>', '兩段落之間要有空行')
t('段落一\n段落二', '段落一<br>\n段落二<br>', '無空行時不可自己補')
t('段落一\n\n\n\n段落二', '段落一<br>\n<br>\n段落二<br>', '連續多空行不疊成多個 <br>')
t('段落一\n\n', '段落一<br>', '結尾空行不拖出多餘 <br>')
t('\n\n段落一', '段落一<br>', '開頭空行不補前導 <br>')

print('=== 標題間距 ===')
t('# 標題\n內文', '<b>標題</b><br>\n內文<br>', '開頭標題前不補 <br>')
t('內文\n## 標題', '內文<br>\n<br>\n<b>標題</b><br>',
  '標題前一律補 <br>（即使原始碼沒空行）')
t('內文\n\n## 標題', '內文<br>\n<br>\n<b>標題</b><br>',
  '原始碼有空行時也只補一個 <br>')

print('=== 清單 ===')
t('- A\n- B', '<ul>\n<li>A</li>\n<li>B</li>\n</ul>', '清單基本形')
t('- A\n\n內文', '<ul>\n<li>A</li>\n</ul>\n<br>\n內文<br>', '清單後接內文要有間距')
t('內文\n- A', '內文<br>\n<ul>\n<li>A</li>\n</ul>', '內文後接清單')

print('=== 表格間距（第四輪審查 BLOCK 的回歸區）===')
# 舊版表格列在 pending_blank 之前就 continue，於是表格前的空行被吞——
# 「內文+空行+表格」與「內文+表格」產出位元組相同，而表格後接內文卻有 <br>，
# 前後不對稱。兩軌審查獨立指向同一處，且 daily-report 的典型版面必中。
_TBL = '| 欄 | 值 |\n|---|---|\n| a | 1 |'


def tbl_spacing(md, want_br_before, label):
    global ok, bad
    got = md_to_html(md)
    head = got.split('<table')[0]
    has_br = head.count('<br>') >= 2 if '內文' in head else head.strip() == '<br>'
    passed = has_br == want_br_before
    if passed:
        ok += 1
        print('  PASS        ' + label)
    else:
        bad += 1
        print('  ** FAIL **  ' + label)
        print('      表格前的內容: ' + repr(head))


tbl_spacing('內文\n\n' + _TBL, True, '內文與表格之間有空行 → 要補 <br>')
tbl_spacing('內文\n' + _TBL, False, '內文與表格之間無空行 → 不補')

# 有空行與無空行必須產出不同結果（舊版兩者位元組相同）
_a = md_to_html('內文\n\n' + _TBL)
_b = md_to_html('內文\n' + _TBL)
if _a != _b:
    ok += 1
    print('  PASS        有空行與無空行的產出必須不同')
else:
    bad += 1
    print('  ** FAIL **  有空行與無空行產出相同（空行被吞）')

t(_TBL + '\n\n內文',
  '<table cellspacing="0" cellpadding="8" style="border-collapse:collapse;'
  'font-family:Arial,sans-serif;font-size:13px;width:100%">\n'
  '<tr><th style="border:1px solid #d0d0d0;background:#f4f4f4;text-align:left">欄</th>'
  '<th style="border:1px solid #d0d0d0;background:#f4f4f4;text-align:left">值</th></tr>\n'
  '<tr><td style="border:1px solid #d0d0d0;vertical-align:top">a</td>'
  '<td style="border:1px solid #d0d0d0;vertical-align:top">1</td></tr>\n'
  '</table>\n<br>\n內文<br>',
  '表格後接內文要有 <br>（原本就對，防回歸）')

# 表格列與列之間絕不可插入 <br>
_rows = md_to_html('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')
if _rows.count('<br>') == 0:
    ok += 1
    print('  PASS        表格列與列之間不補 <br>')
else:
    bad += 1
    print('  ** FAIL **  表格內出現 ' + str(_rows.count('<br>')) + ' 個 <br>')

# 表格在最開頭時不可補前導 <br>
if not md_to_html(_TBL).startswith('<br>'):
    ok += 1
    print('  PASS        表格在開頭不補前導 <br>')
else:
    bad += 1
    print('  ** FAIL **  表格在開頭補了前導 <br>')

print('=== 行內語法與跳脫 ===')
t('**粗體**', '<b>粗體</b><br>', '粗體轉 <b>')
t('`code`', '<code>code</code><br>', 'code 轉 <code>')
t('<script>x</script>', '&lt;script&gt;x&lt;/script&gt;<br>', 'HTML 注入要跳脫')
t('---', '<hr>', '分隔線轉 <hr>')

print('=== 不可產生 <p>（0.18.0 的核心約束）===')
for md in ['內文', '# 標題', '段落一\n\n段落二', '- A\n\n內文']:
    got = md_to_html(md)
    if '<p>' in got or '<p ' in got:
        bad += 1
        print('  ** FAIL **  產生了 <p>：' + repr(md))
    else:
        ok += 1
        print('  PASS        無 <p>：' + repr(md))

print('=== 產出的標籤必須全在 hook 白名單內 ===')
ALLOWED = set(['br', 'hr', 'b', 'i', 'u', 'strong', 'em',
               'ul', 'ol', 'li', 'a', 'pre', 'code',
               'table', 'tr', 'td', 'th', 'thead', 'tbody'])
sample = md_to_html('# 日報\n\n## 專案甲\n- A\n\n內文\n\n| 欄 | 值 |\n|---|---|\n| a | 1 |\n\n---\n結尾')
tags = set(m.lower() for m in re.findall(r'</?([A-Za-z][A-Za-z0-9]*)', sample))
extra = tags - ALLOWED
if extra:
    bad += 1
    print('  ** FAIL **  白名單外的標籤：' + repr(sorted(extra)))
else:
    ok += 1
    print('  PASS        全部在白名單內：' + repr(sorted(tags)))

print('  -> ' + str(ok) + ' passed, ' + str(bad) + ' failed')
if bad > 0:
    sys.exit(1)
