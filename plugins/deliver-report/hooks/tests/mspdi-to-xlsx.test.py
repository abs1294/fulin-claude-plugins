#!/usr/bin/env python3
"""msproject-wbs 的 mspdi-to-xlsx.py 回歸測試（實跑腳本子程序，不 import）

由來：2.3.0 把交付前自檢接進 mspdi-to-xlsx.py，事後審查實跑抓到兩個錯，當時沒有任何測試碰這支腳本：
  1. 主控台是 cp950（Git Bash、輸出被導向）時，自檢沒過要印「✗」就 UnicodeEncodeError 當掉，
     原因一條都沒印、帶缺陷的 .checking.xlsx 留在交付檔旁邊。
  2. 只看 check_doc 的 bad 是否為空：找不到 Python 時文件屬性整項沒檢查（bad=[]、pass=false），
     作者＝openpyxl 的檔照樣產出、exit 0。

守的事：
  - 正常產檔：exit 0、沒有暫存檔殘留、文件屬性是交付用的值（標題、作者、應用程式）
  - 自檢沒過（硬缺陷）：exit 1、不產檔、不留暫存檔；cp950 主控台下不當掉且印得出原因
  - 自檢沒檢查到（找不到 Python）：exit 1、不產檔
  - 自檢沒過但上一版交付檔還在：舊檔不動，並提醒它已過期
  - 參數錯：exit 非 0、印用法
  - 自檢輸出異常（不是 JSON、以 { 開頭但 JSON 毀損）：走 readability_gate 的回傳值判不通過
  - 例外路徑（自檢逾時、改寫文件屬性中途出錯、os.replace 失敗）：走 __main__ 的 except，
    exit 1、沒有 traceback、不留暫存檔（本次的暫存資料夾 .chk<亂碼>/ 與裡面的檔案）、舊檔還在時提醒過期
  - 例外路徑另含：覆寫交付檔失敗（交付檔正被 Excel 開著）
  - 暫存資料夾建在交付檔所在資料夾，不碰系統暫存資料夾（子程序的系統暫存資料夾指到測試自己的資料夾，殘留兩邊都查）
  - 清暫存檔本身失敗（暫存檔刪不掉）：只印警告、不冒 traceback、原本的錯誤照印
  - 交付檔旁邊剛好有舊版固定暫存檔名的檔案（<輸出>.checking.xlsx、<輸出>.checking.xlsx.app-fix）：
    內容原封不動、交付檔照常產出（暫存檔放在 mkdtemp 建的本次專用資料夾裡，只刪自己建的）
  - XML 沒有專案 <Title>：標題取交付檔名，不是暫存檔名
  - 自檢訊息裡出現的檔名是交付檔名，不是暫存檔名；英文標題和檔名看不出關聯時提醒一定出現（暫存檔名會干擾比對）
  - 輸出資料夾不存在、輸出位置不是 .xlsx 檔案（結尾斜線、沒有副檔名、檔名只有 .xlsx）：直接講明，exit 1、不建任何東西
  - （Windows）交付檔路徑 240 字元（長檔名）照常產出：暫存路徑只比交付檔多 13 字元，改寫文件屬性原地做、不另建檔
  - （Windows）交付檔路徑 245 字元（短檔名 a.xlsx，所在資料夾 238 字元）：暫存資料夾放不下，
    轉檔前就講明路徑太長、exit 1、不建任何東西；那裡已有上一版交付檔時原封不動並提醒它已過期
    （不看長路徑支援的登錄值，一律照 260／248 算）
  - （POSIX）交付檔權限跟一般新檔案一樣（0666 扣掉 umask），不是 mkstemp 的 0600
  - 輸出位置是資料夾（名稱以 .xlsx 結尾）：轉檔前就擋、講明是資料夾，不說成舊檔、不露暫存路徑
  - 輸出位置不是 .xlsx、但那裡有使用者自己的檔案：不把它說成「上一次產出的舊檔」，檔案原封不動
  - 自檢沒過時不列出「沒給 --prev／--thread」（本腳本沒有這兩個參數）
  每個案例用自己的資料夾，前一例的殘留不會拖累下一例；需要「上一版交付檔」的案例從正常產檔的結果複製，
  正常產檔失敗時這些案例記為失敗、測試照常跑完並印統計。

需要：node、Python 3＋openpyxl。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.normpath(os.path.join(HERE, '..', '..', 'skills', 'msproject-wbs', 'scripts'))
CONVERTER = os.path.join(SKILL, 'mspdi-to-xlsx.py')
GENERATOR = os.path.join(SKILL, 'generate-wbs.mjs')

passed = failed = 0
SYSTEMP = None   # 子程序的系統暫存資料夾（TMP／TEMP／TMPDIR）指到這裡，殘留檢查也看這裡



def check(desc, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ✓ ' + desc)
    else:
        failed += 1
        print('  ✗ ' + desc + ('：' + detail if detail else ''))


def run(args, **env_over):
    env = dict(os.environ)
    env.pop('PYTHONIOENCODING', None)
    if SYSTEMP:
        env.update(TMP=SYSTEMP, TEMP=SYSTEMP, TMPDIR=SYSTEMP)
    env.update(env_over)
    r = subprocess.run([sys.executable, CONVERTER] + args, capture_output=True, env=env, timeout=300)
    enc = env_over.get('PYTHONIOENCODING', 'utf-8')
    out = (r.stdout + r.stderr).decode(enc, 'replace')
    return r.returncode, out


# 在子程序裡先替換掉某個函式、再以 __main__ 身分執行轉檔腳本，用來模擬平常碰不到的例外路徑
PATCHED_RUNNER = r'''
import runpy, subprocess, sys, zipfile
mode, converter = sys.argv[1], sys.argv[2]
sys.argv = [converter] + sys.argv[3:]
real_run = subprocess.run
if mode == 'timeout':
    def fake(cmd, *a, **k):
        if any(str(c).endswith('check_doc.js') for c in cmd):
            raise subprocess.TimeoutExpired(cmd, 180)
        return real_run(cmd, *a, **k)
    subprocess.run = fake
elif mode in ('notjson', 'brokenjson'):
    payload = b'not json at all' if mode == 'notjson' else b'{"pass": true, broken'
    def fake(cmd, *a, **k):
        if any(str(c).endswith('check_doc.js') for c in cmd):
            return subprocess.CompletedProcess(cmd, 0, payload, b'')
        return real_run(cmd, *a, **k)
    subprocess.run = fake
elif mode in ('appfix', 'appfix_rmfail'):
    import os
    if mode == 'appfix_rmfail':
        real_remove = os.remove
        def no_remove(path, *a, **k):
            if '.chk' in str(path):
                raise PermissionError(13, 'simulated: file is locked', str(path))
            return real_remove(path, *a, **k)
        os.remove = no_remove
    real_writestr = zipfile.ZipFile.writestr
    def boom(self, item, data, *a, **k):
        # 只在 fix_application 寫回「已改好的 app.xml」時出錯（openpyxl 自己存檔時 Application 還是 Openpyxl）
        name = getattr(item, 'filename', item)
        if name == 'docProps/app.xml' and b'<Application>Microsoft Excel</Application>' in data:
            real_writestr(self, item, data, *a, **k)
            raise OSError('simulated failure while rewriting app.xml')
        return real_writestr(self, item, data, *a, **k)
    zipfile.ZipFile.writestr = boom
elif mode == 'replacefail':
    import os
    def no_replace(src, dst, *a, **k):
        raise PermissionError(13, 'simulated: target is open in Excel', str(dst))
    os.replace = no_replace
elif mode == 'spy_workdir':
    import tempfile
    real_mkdtemp = tempfile.mkdtemp
    def spy(*a, **k):
        path = real_mkdtemp(*a, **k)
        print('WORKDIR_PARENT=' + __import__('os').path.dirname(path))
        return path
    tempfile.mkdtemp = spy
runpy.run_path(converter, run_name='__main__')
'''


def run_patched(mode, args):
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    if SYSTEMP:
        env.update(TMP=SYSTEMP, TEMP=SYSTEMP, TMPDIR=SYSTEMP)
    r = subprocess.run([sys.executable, '-c', PATCHED_RUNNER, mode, CONVERTER] + args,
                       capture_output=True, env=env, timeout=300)
    return r.returncode, (r.stdout + r.stderr).decode('utf-8', 'replace')


def props(path):
    with zipfile.ZipFile(path) as z:
        core = z.read('docProps/core.xml').decode('utf-8')
        app = z.read('docProps/app.xml').decode('utf-8')
    tag = lambda x, t: (re.search(r'<%s[^>]*>([^<]*)</%s>' % (t, t), x) or [None, None])[1]
    return {'title': tag(core, 'dc:title'), 'creator': tag(core, 'dc:creator'),
            'lastModifiedBy': tag(core, 'cp:lastModifiedBy'), 'application': tag(app, 'Application'),
            'raw': core + app}


def leftovers(d):
    """d 底下（含子資料夾）的暫存檔與暫存資料夾（.chk*／.checking／.app-fix），回傳相對路徑；
    另加系統暫存資料夾（SYSTEMP）裡本腳本建的 .chk*（前面標 TEMP:）。"""
    out = []
    for root, dirs, files in os.walk(d):
        for n in dirs + files:
            rel = os.path.relpath(os.path.join(root, n), d)
            if n.startswith('.chk') or '.checking' in rel or n.endswith('.app-fix'):
                out.append(rel)
    if SYSTEMP and os.path.isdir(SYSTEMP):
        out += ['TEMP:' + n for n in os.listdir(SYSTEMP) if n.startswith('.chk')]
    return out


def reset_systemp():
    """清空 SYSTEMP（刻意模擬清不掉的案例跑完後用，免得殘留拖累下一例）。"""
    shutil.rmtree(SYSTEMP, ignore_errors=True)
    os.makedirs(SYSTEMP, exist_ok=True)


def case_dir(root, name):
    d = os.path.join(root, name)
    os.makedirs(d)
    return d


def old_copy(baseline, d):
    """把正常產檔的結果複製進 d 當「上一版交付檔」；正常產檔失敗時記一筆失敗、回傳 None。"""
    if not baseline or not os.path.isfile(baseline):
        check('需要正常產檔的結果當上一版交付檔', False, '正常產檔沒有產出，這一例無法驗證')
        return None
    dst = os.path.join(d, 'deliver.xlsx')
    shutil.copyfile(baseline, dst)
    return dst


def main():
    if not shutil.which('node'):
        print('略過：本機沒有 node')
        return 0
    global SYSTEMP
    tmp = tempfile.mkdtemp(prefix='mspdi-test-')
    SYSTEMP = os.path.join(tmp, 't')
    os.makedirs(SYSTEMP)
    try:
        xml = os.path.join(tmp, 'sample.xml').replace('\\', '/')
        with open(GENERATOR, encoding='utf-8') as f:
            src = f.read()
        gen_src, n = re.subn(r"const OUT = '[^']*'", "const OUT = '%s'" % xml, src, count=1)
        if n != 1:
            print('✗ generate-wbs.mjs 找不到 OUT 常數，測試無法產範例 XML')
            return 1
        gen = os.path.join(tmp, 'gen.mjs')
        with open(gen, 'w', encoding='utf-8', newline='') as f:
            f.write(gen_src)
        subprocess.run(['node', gen], check=True, capture_output=True, timeout=120)

        print('== 正常產檔')
        d = case_dir(tmp, 'normal')
        # 中文檔名：標題「範例開發時程」和它看不出關聯，check_doc 會印出含檔名的提醒，用來驗訊息裡的檔名
        dst = os.path.join(d, '交付檔.xlsx')
        code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
        check('exit 0', code == 0, out[-300:])
        check('產出交付檔', os.path.isfile(dst))
        check('沒有暫存檔殘留', not leftovers(d), str(leftovers(d)))
        baseline = dst if os.path.isfile(dst) else None
        if baseline:
            p = props(dst)
            check('標題取專案名稱', p['title'] == '範例開發時程', repr(p['title']))
            check('作者留空（不留 openpyxl）', not p['creator'], repr(p['creator']))
            check('應用程式＝Microsoft Excel', p['application'] == 'Microsoft Excel', repr(p['application']))
            check('文件屬性沒有任何 openpyxl 字樣', 'openpyxl' not in p['raw'].lower())
        if os.name == 'posix' and os.path.isfile(dst):
            mask = os.umask(0)
            os.umask(mask)
            mode = os.stat(dst).st_mode & 0o777
            check('交付檔權限＝0666 扣掉 umask（不是 mkstemp 的 0600）', mode == 0o666 & ~mask, oct(mode))
        check('自檢訊息提到的是交付檔名、沒有暫存路徑', '和檔名「交付檔.xlsx」' in out and '.chk' not in out, out[-400:])

        print('== --author 指定作者')
        d = case_dir(tmp, 'author')
        dst = os.path.join(d, 'author.xlsx')
        code, out = run([xml, dst, '--author', '王小明'], PYTHONIOENCODING='utf-8')
        check('exit 0', code == 0, out[-300:])
        check('產出交付檔', os.path.isfile(dst))
        if os.path.isfile(dst):
            p = props(dst)
            check('作者與最後修改者寫入指定值', p['creator'] == '王小明' and p['lastModifiedBy'] == '王小明',
                  repr((p['creator'], p['lastModifiedBy'])))

        print('== 硬缺陷：cp950 主控台下自檢沒過')
        d = case_dir(tmp, 'cp950')
        dst = os.path.join(d, 'bad.xlsx')
        code, out = run([xml, dst, '--author', 'openpyxl'], PYTHONIOENCODING='cp950')
        check('exit 1', code == 1, out[-300:])
        check('沒有 traceback（不因編碼當掉）', 'Traceback' not in out and 'UnicodeEncodeError' not in out, out[-300:])
        check('印出沒過的原因', '作者' in out and 'openpyxl' in out, out[-300:])
        check('沒有產出交付檔', not os.path.exists(dst))
        check('沒有暫存檔殘留', not leftovers(d), str(leftovers(d)))

        print('== 沒檢查到：自檢找不到 Python')
        d = case_dir(tmp, 'nopy')
        dst = os.path.join(d, 'nopy.xlsx')
        code, out = run([xml, dst, '--author', 'openpyxl'], PYTHONIOENCODING='utf-8',
                        DR_PYTHON=os.path.join(tmp, 'no-such-python.exe'))
        check('exit 1（不因 bad 為空就放行）', code == 1, out[-300:])
        check('印出沒檢查到的項目', '沒檢查到' in out, out[-300:])
        check('不出現「沒給 --」（本腳本沒有 --prev／--thread）', '沒給 --' not in out, out[-400:])
        check('沒有產出交付檔', not os.path.exists(dst))
        check('沒有暫存檔殘留', not leftovers(d), str(leftovers(d)))

        print('== 自檢沒過、上一版交付檔還在')
        d = case_dir(tmp, 'stale')
        dst = old_copy(baseline, d)
        if dst:
            before = open(dst, 'rb').read()
            code, out = run([xml, dst, '--author', 'openpyxl'], PYTHONIOENCODING='utf-8')
            check('exit 1', code == 1, out[-300:])
            check('舊檔原封不動', open(dst, 'rb').read() == before)
            check('提醒舊檔已過期', '舊檔' in out, out[-300:])
            check('沒有暫存檔殘留', not leftovers(d), str(leftovers(d)))

        # mode, 標題, 必須出現的字樣（證明走到預期的那條路）
        cases = (
            ('notjson', '自檢輸出異常：不是 JSON（回傳值判不通過）', '讀不到檔案'),
            ('brokenjson', '自檢輸出異常：以 { 開頭但 JSON 毀損（回傳值判不通過）', '無法解析'),
            ('timeout', '例外路徑：自檢逾時', '途中出錯'),
            ('appfix', '例外路徑：改寫文件屬性中途出錯', '途中出錯'),
            ('replacefail', '例外路徑：覆寫交付檔失敗（正被 Excel 開著）', '途中出錯'),
        )
        for mode, desc, marker in cases:
            print('== ' + desc)
            d = case_dir(tmp, mode)
            dst = old_copy(baseline, d)
            if not dst:
                continue
            before = open(dst, 'rb').read()
            code, out = run_patched(mode, [xml, dst])
            check('exit 1', code == 1, out[-300:])
            check('走到預期的路徑（出現「%s」）' % marker, marker in out, out[-300:])
            check('沒有 traceback', 'Traceback' not in out, out[-400:])
            check('印出沒有產出', '沒有產出' in out, out[-300:])
            check('舊檔原封不動並提醒過期', open(dst, 'rb').read() == before and '舊檔' in out, out[-300:])
            check('沒有暫存檔殘留（.checking／.app-fix）', not leftovers(d), str(leftovers(d)))

        print('== 清暫存失敗：暫存檔刪不掉')
        d = case_dir(tmp, 'rmfail')
        dst = old_copy(baseline, d)
        if dst:
            before = open(dst, 'rb').read()
            code, out = run_patched('appfix_rmfail', [xml, dst])
            check('exit 1', code == 1, out[-300:])
            check('沒有 traceback（清理失敗不蓋掉原本的錯誤）', 'Traceback' not in out, out[-400:])
            check('印出原本的錯誤', '途中出錯' in out, out[-300:])
            check('警告暫存檔／暫存資料夾刪不掉', '刪不掉' in out and '.chk' in out, out[-300:])
            check('交付檔（上一版）原封不動', open(dst, 'rb').read() == before)
        reset_systemp()

        print('== 交付檔旁邊有同名的使用者檔案')
        d = case_dir(tmp, 'samename')
        dst = os.path.join(d, 'out.xlsx')
        sentinels = {}
        for name in ('out.checking.xlsx', 'out.checking.xlsx.app-fix'):
            path = os.path.join(d, name)
            data = ('使用者自己的檔案：' + name).encode('utf-8')
            with open(path, 'wb') as f:
                f.write(data)
            sentinels[path] = data
        code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
        check('exit 0', code == 0, out[-300:])
        check('產出交付檔', os.path.isfile(dst))
        for path, data in sentinels.items():
            kept = os.path.isfile(path) and open(path, 'rb').read() == data
            check('%s 原封不動' % os.path.basename(path), kept, str(os.listdir(d)))
        extra = [f for f in leftovers(d) if os.path.join(d, f) not in sentinels]
        check('沒有本次的暫存檔殘留', not extra, str(extra))

        print('== 暫存資料夾建在交付檔所在資料夾（不放系統暫存資料夾）')
        d = case_dir(tmp, 'wherework')
        dst = os.path.join(d, 'w.xlsx')
        code, out = run_patched('spy_workdir', [xml, dst])
        check('exit 0', code == 0, out[-300:])
        parents = re.findall(r'WORKDIR_PARENT=(.*)', out)
        check('暫存資料夾的上層＝交付檔所在資料夾',
              [os.path.normcase(x.strip()) for x in parents] == [os.path.normcase(d)], repr(parents))

        print('== 英文標題、英文檔名看不出關聯：提醒一定出現')
        d = case_dir(tmp, 'entitle')
        with open(xml, encoding='utf-8-sig') as f:
            xml_text = f.read()
        en_text, k = re.subn(r'<Title>.*?</Title>', '<Title>Schedule</Title>', xml_text, count=1, flags=re.S)
        check('範例 XML 有 <Title> 可換', k == 1)
        en_xml = os.path.join(d, 'en.xml')
        with open(en_xml, 'w', encoding='utf-8', newline='') as f:
            f.write(en_text)
        dst = os.path.join(d, 'plan.xlsx')
        code, out = run([en_xml, dst], PYTHONIOENCODING='utf-8')
        check('exit 0', code == 0, out[-300:])
        check('提醒標題「Schedule」和檔名「plan.xlsx」看不出關聯', '和檔名「plan.xlsx」看不出關聯' in out, out[-400:])

        print('== 輸出資料夾不存在')
        d = case_dir(tmp, 'nodir')
        dst = os.path.join(d, 'nope', 'x.xlsx')
        code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
        check('exit 1', code == 1, out[-300:])
        check('沒有 traceback', 'Traceback' not in out, out[-400:])
        check('講明輸出資料夾不存在', '不存在' in out and 'nope' in out, out[-300:])
        check('沒有建出任何東西', os.listdir(d) == [], str(os.listdir(d)))

        for label, key in (('結尾斜線', 'slash'), ('沒有副檔名', 'noext')):
            print('== 輸出位置不是 .xlsx 檔案：' + label)
            d = case_dir(tmp, key)
            target = d + os.sep if key == 'slash' else os.path.join(d, 'report')
            code, out = run([xml, target], PYTHONIOENCODING='utf-8')
            check('exit 1', code == 1, out[-300:])
            check('講明不是 .xlsx 檔案路徑、不露暫存路徑', '不是 .xlsx 檔案路徑' in out and '.chk' not in out, out[-300:])
            check('沒有建出任何東西', os.listdir(d) == [], str(os.listdir(d)))

        print('== 輸出位置不是 .xlsx、但那裡有使用者自己的檔案')
        d = case_dir(tmp, 'notxlsx-own')
        own = os.path.join(d, 'report')
        with open(own, 'wb') as f:
            f.write(b'keep')
        code, out = run([xml, own], PYTHONIOENCODING='utf-8')
        check('exit 1', code == 1, out[-300:])
        check('不說成「上一次產出的舊檔」', '舊檔' not in out, out[-300:])
        check('檔案原封不動', open(own, 'rb').read() == b'keep')

        print('== 檔名只有 .xlsx（沒有主檔名）')
        d = case_dir(tmp, 'dotxlsx')
        dst = os.path.join(d, '.xlsx')
        code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
        check('exit 1、講明不是 .xlsx 檔案路徑', code == 1 and '不是 .xlsx 檔案路徑' in out, out[-300:])
        check('沒有建出任何東西', os.listdir(d) == [], str(os.listdir(d)))

        if os.name == 'nt':
            # (總長, 檔名)：長檔名一例（放得下）、短檔名一例（所在資料夾 238 字元，暫存資料夾超過 248 上限）
            for total, base in ((240, None), (245, 'a.xlsx')):
                print('== Windows 長路徑：交付檔路徑 %d 字元（%s）' % (total, '短檔名 a.xlsx' if base else '長檔名'))
                d = case_dir(tmp, 'long%d' % total)
                room = total - len(os.path.join(d, ''))
                if room < 20:
                    print('  略過：測試暫存資料夾路徑太長，湊不出 %d 字元的交付檔路徑' % total)
                    continue
                if base:
                    sub = os.path.join(d, 'p' * (room - len(base) - 1))
                else:
                    sub = os.path.join(d, 'p' * (room - 40))
                    base = 'L' * (total - len(os.path.join(sub, '')) - len('.xlsx')) + '.xlsx'
                os.makedirs(sub)
                dst = os.path.join(sub, base)
                if total == 245:
                    with open(dst, 'wb') as f:   # 上一版交付檔
                        f.write(b'OLD')
                code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
                check('路徑長度＝%d' % total, len(dst) == total, str(len(dst)))
                if total == 245:
                    check('exit 1、講明路徑太長', code == 1 and '路徑太長' in out, out[-300:])
                    check('上一版交付檔原封不動並提醒過期', open(dst, 'rb').read() == b'OLD' and '舊檔' in out, out[-300:])
                    check('沒有暫存資料夾殘留', not leftovers(d), str(leftovers(d)))
                    continue
                check('exit 0、產出交付檔', code == 0 and os.path.isfile(dst), out[-300:])
                check('沒有暫存檔殘留', not leftovers(d), str(leftovers(d)))

            print('== Windows 長路徑：所在資料夾短、交付檔路徑 250 字元（暫存檔超過 260 上限）')
            d = case_dir(tmp, 'long250f')
            fill = 250 - len(os.path.join(d, '')) - len('.xlsx')
            if fill < 20:
                print('  略過：測試暫存資料夾路徑太長')
            else:
                dst = os.path.join(d, 'F' * fill + '.xlsx')
                code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
                check('路徑長度＝250', len(dst) == 250, str(len(dst)))
                check('exit 1、講明是檔案路徑上限 260', code == 1 and '路徑太長' in out and '260' in out and '248' not in out,
                      out[-300:])
                check('沒有建出任何東西', os.listdir(d) == [], str(os.listdir(d)))

            print('== Windows 長路徑：資料夾名稱含 emoji（UTF-16 算 2 個字），用 len() 算會漏擋')
            d = case_dir(tmp, 'emoji')
            # 所在資料夾 len()＝233（＋13＝246，len() 判放得下），UTF-16＝236（＋13＝249，實際放不下）
            fill = 233 - len(os.path.join(d, '')) - 3
            if fill < 20:
                print('  略過：測試暫存資料夾路徑太長')
            else:
                sub = os.path.join(d, 'p' * fill + '\U0001F600' * 3)
                os.makedirs(sub)
                dst = os.path.join(sub, 'a.xlsx')
                code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
                check('所在資料夾 len()＝233', len(sub) == 233, str(len(sub)))
                check('exit 1、轉檔前講明資料夾路徑上限 248', code == 1 and '路徑太長' in out and '248' in out, out[-300:])
                check('沒有暫存資料夾殘留', not leftovers(d), str(leftovers(d)))

        print('== XML 沒有專案名稱：標題取交付檔名')
        d = case_dir(tmp, 'notitle')
        notitle_text, k = re.subn(r'<Title>.*?</Title>', '', xml_text, count=1, flags=re.S)
        check('範例 XML 有 <Title> 可拿掉', k == 1)
        notitle = os.path.join(d, 'notitle.xml')
        with open(notitle, 'w', encoding='utf-8', newline='') as f:
            f.write(notitle_text)
        dst = os.path.join(d, '交付時程.xlsx')
        code, out = run([notitle, dst], PYTHONIOENCODING='utf-8')
        check('exit 0', code == 0, out[-300:])
        if os.path.isfile(dst):
            title = props(dst)['title']
            check('標題＝交付檔名（不是暫存檔名）', title == '交付時程', repr(title))
        else:
            check('產出交付檔', False, out[-300:])

        print('== 輸出位置是資料夾（名稱以 .xlsx 結尾）')
        d = case_dir(tmp, 'dstdir')
        dst = os.path.join(d, 'is-a-dir.xlsx')
        os.mkdir(dst)
        code, out = run([xml, dst], PYTHONIOENCODING='utf-8')
        check('exit 1', code == 1, out[-300:])
        check('沒有 traceback', 'Traceback' not in out, out[-400:])
        check('說明輸出位置是資料夾、不說成舊檔、不露暫存路徑',
              '是一個資料夾' in out and '舊檔' not in out and '.chk' not in out, out[-300:])
        check('資料夾沒被動到', os.path.isdir(dst) and os.listdir(dst) == [], str(os.listdir(d)))
        check('沒有暫存檔殘留', not leftovers(d), str(leftovers(d)))

        print('== 參數錯')
        code, out = run([xml], PYTHONIOENCODING='utf-8')
        check('少參數 exit 非 0 並印用法', code != 0 and '用法' in out, out[-300:])
        code, out = run([xml, os.path.join(tmp, 'x.xlsx'), '--author'], PYTHONIOENCODING='utf-8')
        check('--author 沒接值 exit 非 0', code != 0 and not os.path.exists(os.path.join(tmp, 'x.xlsx')), out[-300:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\n%d 過、%d 失敗' % (passed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(errors='replace')
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
