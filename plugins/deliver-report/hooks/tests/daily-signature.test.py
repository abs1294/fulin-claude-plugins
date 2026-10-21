# 日報簽名檔測試 —— 跑法：python hooks/tests/daily-signature.test.py
#
# 為什麼有這支（2026-10-21）：日報走 SMTP／OAuth 直寄，不經 Gmail 網頁，不會自動帶簽名檔。
# 改成用 OAuth 的 gmail.settings.basic 讀寄件帳號的簽名、接在日報結尾。這裡不打真 API，
# 把 urlopen／post_form 換成假的回應，驗：
#   1. fetch_signature：選對寄件身分（from_email 對得上的 > 預設）、沒設簽名、
#      權限不足（舊授權）、沒有 OAuth、換 token 失敗——都不中止、回傳原因
#   1b. primary_send_as（補寄件信箱）：取 isPrimary、沒有就退回 isDefault、舊授權或逾時回 None
#   2. append_signature：HTML 包 gmail_signature、純文字用「-- 」分隔且去掉標籤、沒簽名原樣回傳
#   3. 預覽多一行「簽名檔」狀態；舊呼叫端不傳參數時不印
# （端到端：2026-10-21 以舊授權實跑 gmail_oauth.py send --dry-run，預覽標出「未附上——授權範圍不含
#   gmail.settings.basic」、exit 0；doctor 對真 API 回報同一句。真 API 讀到簽名的那條要使用者重新授權後才能實跑。）
# 失敗時 exit 1。
import contextlib
import io
import json
import os
import sys
import types
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', '..', 'skills', 'daily-report', 'scripts')
sys.path.insert(0, SCRIPTS)

import gmail_oauth as go  # noqa: E402
import send_common as sc  # noqa: E402

ok = 0
bad = 0


def check(label, got, want):
    global ok, bad
    if got == want:
        ok += 1
        print('  PASS  ' + label)
    else:
        bad += 1
        print('  FAIL  ' + label + '\n        got =' + repr(got) + '\n        want=' + repr(want))


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_urlopen(payload=None, http_error=None):
    def _open(req, timeout=None):
        if http_error:
            code, body = http_error
            raise urllib.error.HTTPError(req.full_url, code, 'x', {}, io.BytesIO(body.encode()))
        return FakeResp(json.dumps(payload).encode())
    return _open


OAUTH = {'oauth': {'client_id': 'a.apps.googleusercontent.com', 'client_secret': 's', 'refresh_token': 'r'}}
SIG_A = '<div dir="ltr">林甫軒<br>Mobile : +886 912 345 678<br><a href="mailto:a@example.com">Email : a@example.com</a></div>'
SIG_B = '<div dir="ltr">另一個身分</div>'
SENDAS = {'sendAs': [
    {'sendAsEmail': 'b@example.com', 'isDefault': True, 'signature': SIG_B},
    {'sendAsEmail': 'a@example.com', 'isDefault': False, 'signature': SIG_A},
]}

orig_urlopen, orig_post = go.urllib.request.urlopen, go.post_form
go.post_form = lambda url, data: {'access_token': 'tok'}

print('=== 1. fetch_signature ===')
go.urllib.request.urlopen = fake_urlopen(SENDAS)
check('from_email 對得上 → 用那個身分的簽名',
      go.fetch_signature(dict(OAUTH, from_email='A@example.com'))[0], SIG_A)
check('沒有 from_email → 用預設身分',
      go.fetch_signature(dict(OAUTH))[0], SIG_B)
check('SMTP 路徑：用 smtp.user 比對，不被 from_email 蓋過',
      go.fetch_signature(dict(OAUTH, from_email='b@example.com', smtp={'user': 'a@example.com'}),
                         sender_email='a@example.com')[0], SIG_A)
sig, why = go.fetch_signature(dict(OAUTH), sender_email='other@example.org')
check('寄件地址不在授權帳號的身分裡 → 不附（不退回預設身分）', (sig, '不在 OAuth 授權帳號' in why), (None, True))
sig, why = go.fetch_signature(dict(OAUTH, from_email='other@example.org'))
check('OAuth 路徑 from_email 對不上 → 同樣不附', (sig, '不在 OAuth 授權帳號' in why), (None, True))
check('有 token 參數時不再換發（直接用）',
      go.fetch_signature(dict(OAUTH, from_email='a@example.com'), token='given')[0], SIG_A)

go.urllib.request.urlopen = fake_urlopen({'sendAs': [{'sendAsEmail': 'a@example.com', 'isDefault': True, 'signature': ''}]})
sig, why = go.fetch_signature(dict(OAUTH))
check('帳號沒設簽名 → None 並說明', (sig, '沒有設定簽名檔' in why), (None, True))

go.urllib.request.urlopen = fake_urlopen(http_error=(403, '{"error":{"message":"Request had insufficient authentication scopes."}}'))
sig, why = go.fetch_signature(dict(OAUTH))
check('舊授權權限不足 → None，叫使用者重跑 setup', (sig, 'gmail.settings.basic' in why and 'setup' in why), (None, True))

go.urllib.request.urlopen = fake_urlopen(http_error=(500, 'boom'))
sig, why = go.fetch_signature(dict(OAUTH))
check('其他 HTTP 錯誤 → None 並帶狀態碼', (sig, 'HTTP 500' in why), (None, True))

sig, why = go.fetch_signature({})
check('沒有 OAuth 設定 → None，不中止', (sig, 'OAuth' in why), (None, True))


def raise_timeout(req, timeout=None):
    raise TimeoutError('timed out')


def raise_reset(req, timeout=None):
    raise ConnectionResetError(10054, 'reset')


go.urllib.request.urlopen = raise_timeout
sig, why = go.fetch_signature(dict(OAUTH))
check('讀簽名逾時（TimeoutError）→ None，不中止', (sig, 'TimeoutError' in why), (None, True))
go.urllib.request.urlopen = raise_reset
sig, why = go.fetch_signature(dict(OAUTH))
check('連線被切斷（ConnectionResetError）→ None，不中止', (sig, 'ConnectionResetError' in why), (None, True))


def post_timeout(url, data):
    raise TimeoutError('token timed out')


go.post_form = post_timeout
sig, why = go.fetch_signature(dict(OAUTH))
check('換 token 逾時 → None，不中止', (sig, 'TimeoutError' in why), (None, True))
go.post_form = lambda url, data: {'access_token': 'tok'}


def raise_rt(url, data):
    raise RuntimeError('HTTP 400：invalid_grant')


go.post_form = raise_rt
sig, why = go.fetch_signature(dict(OAUTH))
check('換 token 失敗 → None，不中止', (sig, 'invalid_grant' in why), (None, True))
go.post_form = lambda url, data: {'access_token': 'tok'}

print('=== 1b. primary_send_as（補寄件信箱）===')
go.urllib.request.urlopen = fake_urlopen({'sendAs': [
    {'sendAsEmail': 'alias@example.com', 'isPrimary': False, 'isDefault': True},
    {'sendAsEmail': 'me@example.com', 'isPrimary': True, 'isDefault': False}]})
check('取 isPrimary 的信箱（不是預設別名）', go.primary_send_as('tok'), 'me@example.com')
go.urllib.request.urlopen = fake_urlopen({'sendAs': [{'sendAsEmail': 'only@example.com', 'isDefault': True}]})
check('沒有 isPrimary → 退回 isDefault', go.primary_send_as('tok'), 'only@example.com')
go.urllib.request.urlopen = fake_urlopen(http_error=(403, 'insufficient scopes'))
check('舊授權讀不到清單 → None，不中止', go.primary_send_as('tok'), None)
go.urllib.request.urlopen = raise_timeout
check('逾時 → None，不中止', go.primary_send_as('tok'), None)

print('=== 2. append_signature ===')
md, html = sc.append_signature('# 日報\n\n- 完成 A\n', '<b>日報</b><ul><li>完成 A</li></ul>', SIG_A)
check('HTML：正文後接 gmail_signature 區塊',
      html, '<b>日報</b><ul><li>完成 A</li></ul><br><div class="gmail_signature" data-smartmail="gmail_signature">' + SIG_A + '</div>')
check('純文字：「-- 」分隔、標籤去掉、實體解碼',
      md, '# 日報\n\n- 完成 A\n\n-- \n林甫軒\nMobile : +886 912 345 678\nEmail : a@example.com\n')
check('沒有簽名 → 原樣回傳', sc.append_signature('x', '<b>x</b>', None), ('x', '<b>x</b>'))
check('HTML 轉換不可用（None）→ 只加純文字簽名', sc.append_signature('x', None, SIG_B)[1], None)
check('簽名含 &amp; 實體 → 純文字解碼', sc.append_signature('x', None, '<div>A&amp;B</div>')[0], 'x\n\n-- \nA&B\n')
check('簽名含 <style>/<script> → 純文字版不帶其內容',
      sc.append_signature('x', None, '<style>.a{color:red}</style><div>林</div><script>alert(1)</script>')[0], 'x\n\n-- \n林\n')

print('=== 3. 預覽顯示簽名檔狀態 ===')
plan = types.SimpleNamespace(recipients=['r@example.com'], cc=[], subject='主旨', md='內文')
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    sc.print_preview(plan, '測試', False, '未附上——沒有 OAuth 授權')
check('預覽多一行「簽名檔」', '簽名檔   : 未附上——沒有 OAuth 授權' in buf.getvalue(), True)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    sc.print_preview(plan, '測試', False)
check('不傳簽名參數 → 不印那一行（舊呼叫端相容）', '簽名檔' in buf.getvalue(), False)

go.urllib.request.urlopen, go.post_form = orig_urlopen, orig_post
print('\n{} passed, {} failed'.format(ok, bad))
sys.exit(1 if bad else 0)
