# 日報萃取（extract_sessions.py）測試 —— 跑法：python hooks/tests/extract-sessions.test.py
#
# 為什麼有這支：看板（session-board）的對話、執行中補打的話、按建議送出的話都沒進日報
# （2026-11-21、22、23 整天 0 筆，實際 7、5、6 場），反而 hook 回饋與續接摘要被當成人說的。
#
# 家目錄以 USERPROFILE／HOME 指到暫存目錄，不碰使用者真正的 ~/.claude。失敗時 exit 1。
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, '..', '..', 'skills', 'daily-report', 'scripts', 'extract_sessions.py'))
DATE = '2026-11-20'
ok = bad = 0


def check(name, got, want):
    global ok, bad
    if got == want:
        ok += 1
    else:
        bad += 1
        print('FAIL', name, '\n  got ', got, '\n  want', want)


def row(text, kind='user', **kw):
    o = {'type': kind, 'timestamp': DATE + 'T03:00:00.000Z', 'cwd': kw.pop('cwd', HOME), 'entrypoint': kw.pop('entry', 'cli')}
    if kind == 'user':
        o['message'] = {'role': 'user', 'content': kw.pop('content', text)}
    else:
        o['attachment'] = dict({'type': 'queued_command', 'prompt': text, 'commandMode': 'prompt'}, **kw.pop('att', {}))
    o.update(kw)
    return o


def put(sid, rows):
    with open(os.path.join(PROJ, sid + '.jsonl'), 'w', encoding='utf-8', newline='') as fh:
        fh.write(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))


def run():
    out = os.path.join(HOME, 'out.json')
    if os.path.exists(out):
        os.remove(out)
    env = dict(os.environ, USERPROFILE=HOME, HOME=HOME, PYTHONIOENCODING='utf-8')
    p = subprocess.run([sys.executable, SCRIPT, '--date', DATE, '--all-projects', '--out', out],
                       env=env, capture_output=True, encoding='utf-8', timeout=60)
    got = {}
    if p.returncode == 0:
        with open(out, encoding='utf-8') as fh:
            got = {s['session_id']: [x['text'] for x in s['prompts']] for pr in json.load(fh)['projects'] for s in pr['sessions']}
    return p, got


HOME = tempfile.mkdtemp(prefix='extract-')
PROJ = os.path.join(HOME, '.claude', 'projects', 'C--w')
BOARD = os.path.join(HOME, '.claude', 'session-board')
os.makedirs(PROJ)
try:
    put('term', [
        row('打的', promptSource='typed', origin={'kind': 'human'}),
        row('排隊的', promptSource='queued'),
        row('按建議', promptSource='suggestion_accepted'),
        row('舊格式'),
        row('補打的', 'attachment'),
        row('', 'attachment', att={'prompt': [{'type': 'text', 'text': '補打的區塊'}, {'type': 'image'}]}),
        # 以下都不是人說的
        row('<task-notification>x', 'attachment', att={'commandMode': 'task-notification'}),
        row('別的 session', 'attachment', att={'origin': {'kind': 'peer'}}),
        row('標了 meta', 'attachment', att={'isMeta': True}),
        row('Stop hook feedback: 擋', isMeta=True),
        row('續接摘要', isCompactSummary=True),
        row('只給人看紀錄', isVisibleInTranscriptOnly=True),
        row('系統', promptSource='system'),
        row('別的 session', origin={'kind': 'peer'}),
        row('Another Claude session sent a message: hi'),
        row('（看板自動送出）這個 session 上次是在…'),
        row('代理說的', isSidechain=True),
        row('代理排隊的', 'attachment', isSidechain=True),
    ])
    board_rows = [row('看板裡打的', entry='sdk-cli', promptSource='sdk'),
                  row('', entry='sdk-cli', content=[{'type': 'text', 'text': '舊看板列'}]),
                  row('看板裡補打的', 'attachment', entry='sdk-cli'),
                  row('別的 session', entry='sdk-cli', promptSource='system', origin={'kind': 'peer'}, isMeta=True)]
    put('board', board_rows)
    put('secretary', board_rows)
    put('program', board_rows)
    put('program-sdk', [row('claude-mem', entry='sdk-ts')])
    # 終端機開的、後來在看板接手：一場裡兩種都有
    put('moved', [row('終端機打的', promptSource='typed'), row('看板接手後打的', entry='sdk-cli', promptSource='sdk')])
    # 程式開的、後來你在終端機接手：只算你打的
    put('taken', [row('程式餵的', entry='sdk-cli', promptSource='sdk'), row('接手後打的', entry='cli', promptSource='typed')])
    # 排程開的：排程送的那一句不算，之後人說的才算；沒說過話的整場不進
    AT = 1795143600000   # 2026-11-20T03:00:00Z
    later = {'timestamp': DATE + 'T03:30:00.000Z'}
    put('sched', [row('排程的話', entry='sdk-cli', promptSource='sdk'), row('人接著說', entry='sdk-cli', promptSource='sdk', **later)])
    put('sched-alone', [row('排程的話', entry='sdk-cli', promptSource='sdk')])
    put('sched-mine', [row('人先說的', entry='sdk-cli', promptSource='sdk'), row('排程接著送的', entry='sdk-cli', promptSource='sdk', **later)])
    # 排程送的是斜線指令、或送進終端機（peer）：拿掉的是那一句，不是人接著打的
    soon = {'timestamp': DATE + 'T03:00:20.000Z'}
    put('sched-slash', [row('<command-message>harness:review</command-message>', entry='sdk-cli', promptSource='sdk'), row('人二十秒後說的', entry='sdk-cli', promptSource='sdk', **soon)])
    put('sched-peer', [row('【看板排程】', promptSource='system', origin={'kind': 'peer'}, isMeta=True), row('終端機打的', promptSource='typed', **soon)])
    put('sched-typed', [row('剛好在那時打的', promptSource='typed')])
    # 對話正忙，排程那一句排進去（附件）；前面先來一則背景工作回報（新舊兩種寫法）
    put('sched-busy', [row('', content='<task-notification>舊寫法', entry='sdk-cli'),
                       row('做完了', entry='sdk-cli', promptSource='system', origin={'kind': 'task-notification'}),
                       row('排程的話', 'attachment', entry='sdk-cli'), row('人接著打的', 'attachment', entry='sdk-cli', **soon)])
    # 壞行：不可讓整次萃取崩潰
    put('odd', [row('壞 origin', origin='human'), {'type': 'attachment', 'timestamp': DATE + 'T03:00:00Z', 'attachment': 'x'},
                {'type': 'attachment', 'timestamp': DATE + 'T03:00:00Z', 'attachment': {'type': 'queued_command', 'prompt': 5}},
                dict(row('x'), message='壞'), dict(row('y', 'attachment'), timestamp=None)])

    TERM = ['打的', '排隊的', '按建議', '舊格式', '補打的', '補打的區塊']
    # 沒裝看板
    p, got = run()
    check('沒裝看板：成功、不吵', (p.returncode, 'WARN' in p.stderr), (0, False))
    check('終端機', got.get('term'), TERM)
    check('沒名單：看板與程式的都不進', sorted(got), ['moved', 'odd', 'sched-peer', 'sched-typed', 'taken', 'term'])
    check('接手後只算你打的', got.get('taken'), ['接手後打的'])
    check('壞行跳過', got.get('odd'), ['壞 origin'])

    # 裝了看板
    os.makedirs(BOARD)
    con = sqlite3.connect(os.path.join(BOARD, 'board.db'))
    con.execute('PRAGMA journal_mode = WAL')
    con.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)')
    con.execute('INSERT INTO settings VALUES (?, ?, 0)', ('boardStarted', json.dumps(['board', 'secretary', 'moved', 'sched', 'sched-alone', 'sched-mine', 'sched-slash', 'sched-busy', 5])))
    con.execute('INSERT INTO settings VALUES (?, ?, 0)', ('openedBy', json.dumps({'sched': {'by': 'schedule', 'at': AT - 2000}, 'sched-alone': {'by': 'health', 'at': AT - 1000}, 'sched-slash': {'by': 'health', 'at': AT - 1000}, 'term': {'by': 'x', 'at': 1e30}, 'bad': 5})))
    con.execute('CREATE TABLE schedule_run (id INTEGER PRIMARY KEY, session_id TEXT, started_at INTEGER)')
    con.execute('INSERT INTO schedule_run (session_id, started_at) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)', ('sched-busy', AT - 500, 'sched', AT - 1500, 'sched-mine', AT + 1795000, 'sched-peer', AT - 500, 'sched-typed', AT - 500, '', 1))
    con.execute('INSERT INTO settings VALUES (?, ?, 0)', ('lineSessions', json.dumps(['secretary'])))
    con.commit()   # 不關：看板開著時就是這樣讀
    p, got = run()
    check('看板開的進、小秘書與程式的不進', sorted(got), ['board', 'moved', 'odd', 'sched', 'sched-busy', 'sched-mine', 'sched-peer', 'sched-slash', 'sched-typed', 'taken', 'term'])
    check('拿掉的是看板送的那一句', (got.get('sched-slash'), got.get('sched-peer'), got.get('sched-typed'), got.get('sched-busy')), (['人二十秒後說的'], ['終端機打的'], ['剛好在那時打的'], ['人接著打的']))
    check('排程送的不是人說的', (got.get('sched'), got.get('sched-mine')), (['人接著說'], ['人先說的']))
    check('看板裡說的', got.get('board'), ['看板裡打的', '舊看板列', '看板裡補打的'])
    check('終端機與看板各說的', got.get('moved'), ['終端機打的', '看板接手後打的'])
    check('終端機不變', got.get('term'), TERM)
    con.execute("UPDATE settings SET value = '{\"a\":1}'")
    con.commit()
    p, got = run()
    check('名單不是清單：當沒有，要說', (p.returncode, 'WARN' in p.stderr, sorted(got)), (0, True, ['moved', 'odd', 'sched-peer', 'sched-typed', 'taken', 'term']))

    # 名單讀不到：照跑，但要說（先關連線，Windows 才刪得掉檔）
    con.close()
    for n in os.listdir(BOARD):
        os.remove(os.path.join(BOARD, n))
    with open(os.path.join(BOARD, 'board.db'), 'w') as fh:
        fh.write('not a database, not a database, not a database')
    p, got = run()
    check('讀不到：說出來', (p.returncode, 'WARN: 讀不到看板的對話名單' in p.stderr, sorted(got)), (0, True, ['moved', 'odd', 'sched-peer', 'sched-typed', 'taken', 'term']))
finally:
    shutil.rmtree(HOME, ignore_errors=True)

print('{} passed, {} failed'.format(ok, bad))
sys.exit(1 if bad else 0)
