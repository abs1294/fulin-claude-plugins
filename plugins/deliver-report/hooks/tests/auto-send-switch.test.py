# 自動寄開關（require_approval）測試 —— 跑法：python hooks/tests/auto-send-switch.test.py
#
# 為什麼有這支：1.6.0 前 require_approval 只寫在 SKILL.md 與範本裡，沒有任何腳本讀它，
# 第 5 步又不分設定一律開默許窗口、喚醒後帶 --auto 自動寄——「預設要人工核可」只是自律。
# 這支驗證開關真的由寄送腳本強制：
#   - 需人工核可（true／沒寫／讀不到）時，帶 --auto 一律拒寄
#   - 允許時（false）照舊走確認窗口的全部檢查
#   - 不帶 --auto（使用者親口說「寄」）不受開關影響
#
# 安全：全程只跑 --dry-run（寄送腳本在 dry-run 時於連線前就 return），
# 另把 smtp host 設成 127.0.0.1:9，萬一哪裡沒擋住也連不到任何真的郵件伺服器。
# 家目錄以 USERPROFILE／HOME 指到暫存目錄，不碰使用者真正的 ~/.claude/daily-report。
#
# 失敗時 exit 1（與同目錄其他測試同一道紀律）。
import json
import os
import shutil
import subprocess
import sys
import tempfile

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.normpath(os.path.join(HERE, '..', '..', 'skills', 'daily-report', 'scripts'))
SEND = os.path.join(SCRIPTS, 'send_gmail.py')
GATE = os.path.join(SCRIPTS, 'confirm_gate.py')
DATE = '2099-01-01'
REPORT_MD = ('# 2099-01-01 工作日報\n\n'
             '## 供應商平台\n'
             '- 完成訂單查詢頁的欄位調整\n\n'
             '## 待辦與未完成\n'
             '- 無\n')

ok = 0
bad = 0


def check(cond, label, detail=''):
    global ok, bad
    if cond:
        ok += 1
        print('  PASS        ' + label)
    else:
        bad += 1
        print('  ** FAIL **  ' + label)
        if detail:
            for ln in detail.strip().splitlines()[:12]:
                print('      | ' + ln)


class Sandbox:
    """一個暫存家目錄＋一個暫存專案目錄。每個案例各開一個，互不污染。"""

    def __init__(self, home_cfg_extra=None, project_cfg_extra=None,
                 home_raw=None, project_raw=None, write_home=True, write_project=True):
        self.root = tempfile.mkdtemp(prefix='dr-autosend-')
        self.home = os.path.join(self.root, 'home')
        self.proj = os.path.join(self.root, 'proj')
        os.makedirs(os.path.join(self.home, '.claude', 'daily-report', 'reports'))
        os.makedirs(os.path.join(self.proj, '.claude'))
        home_cfg = {
            'channel': 'app_password',
            'subject_prefix': '[測試日報]',
            'from_name': '測試',
            'smtp': {'host': '127.0.0.1', 'port': 9,
                     'user': 'sender@example.invalid', 'app_password': 'not-a-real-password'},
        }
        home_cfg.update(home_cfg_extra or {})
        proj_cfg = {'recipients': ['someone@example.invalid'], 'cc': []}
        proj_cfg.update(project_cfg_extra or {})
        if write_home:
            self._write(os.path.join(self.home, '.claude', 'daily-report', 'config.json'),
                        home_raw if home_raw is not None else json.dumps(home_cfg, ensure_ascii=False))
        if write_project:
            self._write(os.path.join(self.proj, '.claude', 'daily-report.json'),
                        project_raw if project_raw is not None else json.dumps(proj_cfg, ensure_ascii=False))
        self.report = os.path.join(self.home, '.claude', 'daily-report', 'reports', DATE + '.md')
        self._write(self.report, REPORT_MD)

    @staticmethod
    def _write(path, text):
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write(text)

    def env(self):
        e = dict(os.environ)
        e['USERPROFILE'] = self.home   # Windows：os.path.expanduser 與 node os.homedir 都看這個
        e['HOME'] = self.home          # POSIX
        e['PYTHONIOENCODING'] = 'utf-8'
        return e

    def run(self, argv):
        r = subprocess.run([sys.executable] + argv, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', env=self.env(), cwd=self.proj)
        return r.returncode, (r.stdout or '') + (r.stderr or '')

    def gate(self, *a):
        return self.run([GATE] + list(a) + ['--project', self.proj])

    def arm(self, minutes):
        return self.run([GATE, 'arm', DATE, '--report', self.report,
                         '--recipients', 'someone@example.invalid',
                         '--minutes', str(minutes), '--project', self.proj])

    def send(self, auto):
        a = [SEND, '--report', self.report, '--date', DATE, '--project', self.proj, '--dry-run']
        if auto:
            a.append('--auto')
        return self.run(a)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def case(title):
    print('=== ' + title + ' ===')


# ── 案 1：開關 true ＋ --auto → 拒寄（即使窗口已到期）
case('案 1：require_approval=true，窗口已到期，帶 --auto → 拒寄')
s = Sandbox(project_cfg_extra={'require_approval': True})
s.arm(0)
code, out = s.send(auto=True)
check(code == 5, 'exit 5（自動寄送檢查未通過）', out)
check('approval-required' in out, '原因是 approval-required', out)
check('require_approval' in out and 'false' in out, '有寫出要改 config 的 require_approval', out)
check('未寄送' not in out, '沒有走到預覽／寄送', out)
s.cleanup()

# ── 案 2：開關 false ＋ 已 arm 且到期 → 放行（dry-run）
case('案 2：require_approval=false，已 arm 且到期，帶 --auto --dry-run → 放行')
s = Sandbox(project_cfg_extra={'require_approval': False})
c_arm, o_arm = s.arm(0)
check(c_arm == 0 and '必須立刻排喚醒' in o_arm, 'arm 成功且提醒排喚醒', o_arm)
code, out = s.send(auto=True)
check(code == 0, 'exit 0', out)
check('[ready]' in out, 'confirm_gate 回 ready', out)
check('--dry-run：未寄送' in out, '停在 dry-run 預覽，未寄出', out)
s.cleanup()

# ── 案 3：開關 false ＋ vetoed → 拒寄
case('案 3：require_approval=false，使用者已喊停（veto），帶 --auto → 拒寄')
s = Sandbox(project_cfg_extra={'require_approval': False})
s.arm(0)
s.gate('veto', DATE, '--reason', '內容要再改')
code, out = s.send(auto=True)
check(code == 5, 'exit 5', out)
check('vetoed' in out, '原因是 vetoed', out)
s.cleanup()

# ── 案 4：讀不到設定 → 拒寄（fail-closed）
case('案 4：設定檔讀不到／壞掉 → 一律當需人工核可')
s = Sandbox(home_raw='{ 這不是 JSON', project_cfg_extra={'require_approval': False})
s.arm(0)
code, out = s.gate('check', DATE)
check(code == 14, '家目錄設定壞掉（專案寫 false 也一樣）：check exit 14', out)
check('格式壞了' in out, '原因寫出設定檔讀不到', out)
code, out = s.send(auto=True)
check(code != 0 and '未寄送' not in out, '寄送路徑也被擋下（exit {}）'.format(code), out)
s.cleanup()

s = Sandbox(project_raw='[1, 2', write_home=True)
code, out = s.gate('policy')
check(code == 14, '專案設定壞掉：policy exit 14', out)
s.cleanup()

s = Sandbox(write_home=False, write_project=False)
code, out = s.gate('policy')
check(code == 14, '兩份設定檔都不存在：policy exit 14（預設需人工核可）', out)
s.cleanup()

# ── 案 5：不帶 --auto（使用者親口說寄）→ 不受開關影響
case('案 5：require_approval=true，不帶 --auto（使用者說「寄」）→ 不受開關影響')
s = Sandbox(project_cfg_extra={'require_approval': True})
code, out = s.send(auto=False)
check(code == 0, 'exit 0', out)
check('--dry-run：未寄送' in out, '停在 dry-run 預覽，未寄出', out)
check('approval-required' not in out, '沒有被開關擋', out)
s.cleanup()

# ── 補充：開關的邊界值
case('補充：開關沒寫、寫錯型別、舊位置、新舊矛盾、家目錄層')
s = Sandbox()
code, out = s.gate('policy')
check(code == 14, '完全沒寫 require_approval → 需人工核可', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': 'false'})
code, out = s.gate('policy')
check(code == 14, '寫成字串 "false"（不是布林）→ 需人工核可', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'schedule': {'enabled': False, 'require_approval': False}})
code, out = s.gate('policy')
check(code == 0, '舊位置 schedule.require_approval=false 仍被讀到 → 允許', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': False,
                               'schedule': {'require_approval': True}})
code, out = s.gate('policy')
check(code == 14, '最外層 false、schedule 裡 true（矛盾）→ 需人工核可', out)
s.cleanup()

s = Sandbox(home_cfg_extra={'require_approval': False}, project_cfg_extra={'require_approval': None})
code, out = s.gate('policy')
check(code == 14, '專案寫 null、家目錄 false → null 不算「沒寫」，需人工核可', out)
s.cleanup()

s = Sandbox(home_cfg_extra={'require_approval': 'false'}, project_cfg_extra={'require_approval': False})
code, out = s.gate('policy')
check(code == 14, '家目錄寫字串 "false"、專案 false → 任一層非布林即需人工核可', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': False, 'schedule': {'require_approval': 0}})
code, out = s.gate('policy')
check(code == 14, '最外層 false、舊位置寫 0（Python 的 False == 0）→ 需人工核可', out)
s.cleanup()

s = Sandbox(home_cfg_extra={'require_approval': False})
code, out = s.gate('policy')
check(code == 0, '只有家目錄寫 false → 允許', out)
s.cleanup()

s = Sandbox(home_cfg_extra={'require_approval': False}, project_cfg_extra={'require_approval': True})
code, out = s.gate('policy')
check(code == 14, '家目錄 false、專案 true → 專案優先，需人工核可', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': True})
c_arm, o_arm = s.arm(30)
check('不要排喚醒' in o_arm and '必須立刻排喚醒' not in o_arm,
      '需人工核可時 arm 不再要求排喚醒', o_arm)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': False})
s.arm(30)
code, out = s.send(auto=True)
check(code == 5 and 'still-waiting' in out, '允許自動寄但窗口未到期 → 仍拒寄（still-waiting）', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': False})
code, out = s.send(auto=True)
check(code == 5 and 'not-armed' in out, '允許自動寄但沒 arm → 仍拒寄（not-armed）', out)
s.cleanup()

s = Sandbox(project_cfg_extra={'require_approval': False})
s.arm(0)
with open(s.report, 'a', encoding='utf-8') as fh:
    fh.write('- 補一條\n')
code, out = s.send(auto=True)
check(code == 5 and '被修改' in out, '允許自動寄但 arm 後內容被改 → 仍拒寄（內容指紋）', out)
s.cleanup()

print('  -> ' + str(ok) + ' passed, ' + str(bad) + ' failed')
if bad > 0:
    sys.exit(1)
