import sys, re, shlex

# 判斷一條 shell 指令有沒有在「不經 flow.sh 就建 commit 或改寫 ref」。
# 命中印描述 exit 0；沒命中 exit 1；解析不了也 exit 1（fail-open）。
#
# 為什麼不是一條 regex：shell 指令的變形空間比 regex 能表達的大。六輪審查各抓到一批
# 漏法——指令替換 $(...)、含 = 的全域選項、值含空白的 -c user.name="A B"、旗標置於
# 參數之後、重導向被算成參數或插在子指令之前、bash -c/eval/xargs 把指令包成字串、
# 變數展開、-c alias.x=commit——每補一個 regex 就冒出下一個。
#
# 處理範圍：
#   - shlex 斷詞後逐 token 判斷（引號、重導向交給斷詞器）
#   - 殼包裝（bash/sh/eval/xargs/env/...）的字串參數遞迴解析，深度上限 MAX_DEPTH
#   - 同段內的 VAR=value 賦值，供後面的 $VAR 展開
#   - 同一條指令裡用 -c alias.x=commit 設的 alias
#
# 刻意不處理（需要讀外部狀態，且誤判代價高）：
#   - 使用者 .gitconfig 裡既有的 alias（ci = commit 之類）——要讀 git 設定才能展開
#   - 跨行／跨指令的變數傳遞（export 到環境後在另一條 Bash 呼叫使用）
#   - 動態組字串（printf 拼出指令再 eval）
#   - 指令替換產生「指令名」：$(echo git) commit -m x
#     （要執行 echo 才知道輸出是什麼；試過保守地「段落開頭是受監控子指令就擋」，
#       結果把 `echo $(date) commit` 這種日常寫法一起誤擋，代價高於價值，故撤回）
#   - 超過 MAX_DEPTH 層的巢狀殼包裝（預設 5 層，再深就退回不擋）
# 這些都繞得過，但都屬於「明知故犯」而非「不知道 plumbing 也算 commit」。
# 本閘的目標是後者：讓不知道的人知道，而不是讓想繞的人繞不了。

SEPARATORS = {';', '&&', '||', '|', '&', '(', ')', '{', '}'}
# 自帶目標的複合重導向（2>&1、1>&2、>&1、&>>…）——它們後面沒有檔名，
# 跳過時只能跳 1 個 token，跳 2 個會連下一個指令名一起吃掉（`2>&1 git commit`
# 曾因此完全漏擋）。判別與跳幾步統一走 redirect_span()。
# `&>` / `&>>` 不在此列——它們後面仍要接檔名（`&>/dev/null`），屬於吃 2 個那類。
FD_REDIRECTS = {'%s>&%s' % (a, b)
                for a in ('', '1', '2')
                for b in ('', '1', '2')} - {'>&'}
REDIRECTS = ({'>', '>>', '<', '<<', '2>', '2>>', '1>', '<<<',
              '&>', '&>>', '>&'} | FD_REDIRECTS)


def redirect_span(token):
    """token 是重導向就回它佔幾個 token（自帶目標＝1、吃檔名＝2），否則回 0。"""
    if token not in REDIRECTS:
        return 0
    return 1 if token in FD_REDIRECTS else 2
GLOBAL_OPTS_WITH_VALUE = {'-C', '-c', '--git-dir', '--work-tree', '--namespace',
                          '--exec-path', '--super-prefix', '--config-env'}
# 這些指令會把參數當成另一條指令執行 → 要遞迴進去看
SHELL_WRAPPERS = {
    # 把指令包成字串
    'bash', 'sh', 'zsh', 'dash', 'ksh', 'eval',
    # 前置包裝，後面接真正的指令
    'command', 'xargs', 'env', 'nohup', 'timeout', 'nice', 'ionice',
    'stdbuf', 'setsid', 'unbuffer', 'script', 'time', 'sudo', 'doas',
}
# 其中「只有第一個非選項參數是指令字串」的（其餘是位置參數，掃了會誤擋）
STRING_CMD_WRAPPERS = {'bash', 'sh', 'zsh', 'dash', 'ksh', 'eval'}
# shell 自己的選項中會吃掉下一個 token 的（bash -o pipefail -c '…'）
SHELL_OPTS_WITH_VALUE = {'-o', '+o', '--rcfile', '--init-file'}
# 前置包裝詞的選項中會吃掉下一個 token 的（env -u FOO、xargs -n 1）
WRAPPER_OPTS_WITH_VALUE = {'-u', '-n', '-P', '-I', '-L', '-s', '-a', '-E', '-d',
                           '--unset', '--max-args', '--max-procs', '--replace',
                           '--delimiter', '--signal', '--kill-after', '--chdir'}

WATCHED = {'commit', 'commit-tree', 'update-ref', 'symbolic-ref', 'branch'}
# shell 的控制結構關鍵字：它們後面接的是指令，不是自己的參數
# （`if git commit …; then` 的 git 位在 idx 1，不剝掉會被當成 if 的參數而漏擋）
SHELL_KEYWORDS = {'if', 'while', 'until', 'then', 'else', 'elif', 'do', 'done',
                  'fi', 'esac', 'case', '!', 'time'}

MAX_DEPTH = 5          # 遞迴上限，避免惡意巢狀拖垮 hook


def judge(sub, args):
    if sub in ('commit', 'commit-tree', 'update-ref'):
        return 'git ' + sub
    if sub == 'symbolic-ref':
        if any(a in ('-d', '--delete') for a in args):
            return 'git symbolic-ref (delete)'
        if len([a for a in args if not a.startswith('-')]) >= 2:
            return 'git symbolic-ref (write)'
        return None
    if sub == 'branch':
        for a in args:
            if a in ('--force', '--move', '--copy'):
                return 'git branch (force)'
            if a.startswith('-') and not a.startswith('--') and any(c in a[1:] for c in 'fMC'):
                return 'git branch (force)'
        return None
    return None


def strip_noise(tok):
    """剝掉指令替換／子 shell 的前綴雜訊：WIP=$(git → git。

    `=` 只有在右側帶替換前綴（$( 或反引號）時才剝——否則 `echo foo=git commit`
    的 foo=git 會被當成 git 而誤擋（實際只會執行 echo）。
    """
    t = tok.lstrip('`$(){}')
    if '=' in t:
        rhs = t.split('=', 1)[1]
        if rhs[:1] in ('$', '`', '('):
            t = rhs.lstrip('`$(){}')
    return t


def is_git(tok):
    t = strip_noise(tok)
    return t == 'git' or t.endswith('/git') or t.endswith('\\git')


def _strip_comments(text):
    """砍掉 shell 註解（# 到行尾）。

    引號內的 # 是普通字元不能砍（`git commit -m "fix #123"`），
    故逐字掃描並追蹤引號狀態。# 也只有在行首或空白之後才是註解起點
    （`abc#def` 的 # 是字面）。
    """
    res, i, n = [], 0, len(text)
    quote = None
    prev = ''
    while i < n:
        c = text[i]
        if quote:
            res.append(c)
            # 雙引號內反斜線會跳脫下一個字元；單引號內不會（單引號裡沒有跳脫）
            if c == '\\' and quote == '"' and i + 1 < n:
                res.append(text[i + 1])
                prev = text[i + 1]
                i += 2
                continue
            if c == quote:
                quote = None
            prev = c
            i += 1
            continue
        if c in ('"', "'"):
            quote = c
            res.append(c)
            prev = c
            i += 1
            continue
        # 註解只在行首或空白之後才成立；一路吃到行尾（引號狀態跨行由上面維持）
        if c == '#' and (prev in ('', ' ', '\t', '\n')):
            while i < n and text[i] != '\n':
                i += 1
            continue
        res.append(c)
        prev = c
        i += 1
    return ''.join(res)


def _strip_heredocs(text):
    """移除 heredoc 的「資料內容」，保留指令本身與後續指令。

    用逐行狀態機而非 regex——heredoc 的語法 regex 處理不了：
      - 一行可以有多份（`cat <<A <<B`），各自有自己的終止符
      - `<<-` 允許終止符前有 tab 縮排，`<<` 則必須頂格
      - 終止符可以是任意字（`<<'END-DOC'`），不只 \\w+
      - 終止符「引用了」內容才是純資料；沒引用時 shell 會展開其中的替換，
        那些替換是真的會執行的，不能當資料丟掉
    """
    lines = text.split('\n')
    out = []
    pending = []          # [(終止符, 允許縮排, 是否引用), ...]
    i = 0
    while i < len(lines):
        line = lines[i]
        if not pending:
            out.append(line)
            # 終止符可以是任意字，含純數字（`cat <<'123'`）
            for m in re.finditer(r'<<(-?)\s*(["\']?)([\w.-]+)\2', line):
                pending.append((m.group(3), m.group(1) == '-', bool(m.group(2))))
            i += 1
            continue
        # 收集這一份 heredoc 的內容直到終止符
        term, dash, quoted = pending.pop(0)
        body = []
        while i < len(lines):
            # `<<-` 只移除「tab」縮排，空格不算（shell 的實際行為）
            probe = lines[i].lstrip('\t') if dash else lines[i]
            if probe == term:
                break
            body.append(lines[i])
            i += 1
        i += 1                                   # 跳過終止符那行
        if not quoted:
            # 未引用：內容裡的 $( … ) / 反引號 shell 會真的執行，保留它們
            for b in body:
                # 跳脫的 $ 是字面（`\$(…)` 在 heredoc 裡不會被展開），要排除
                for piece in re.findall(r'(?<!\\)\$\([^)]*\)|(?<!\\)`[^`]*`', b):
                    out.append(piece)
    return '\n'.join(out)


def _unquote(text):
    """把中性化的佔位符還原。

    中性化只為了讓 shlex 斷詞時分得出「單引號內的 $ 是字面」；
    但殼包裝（bash -c '…'）的單引號內容是「要執行的指令」，
    裡面的 $ 是真的，遞迴前必須還原，否則變數展開會失效。
    """
    return text.replace('\x00', '$').replace('\x01', '`')


def _extract_substitutions(tok):
    """取出 token 裡每一段指令替換的內容（$( … ) 與反引號），含巢狀。

    非貪婪 regex 在 `$(git commit -m "$(date)")` 會切在內層的 )，
    外層的 git commit 就看不到——故手動配對括號取最外層。
    注意：本模組在斷詞前已把 ( ) 前後補了空白，所以這裡看到的是 '$ ( … ) '。
    """
    out = []
    i = 0
    while i < len(tok):
        if tok.startswith('$ (', i):
            depth_ = 0
            j = i + 2
            closed = False
            while j < len(tok):
                if tok[j] == '(':
                    depth_ += 1
                elif tok[j] == ')':
                    depth_ -= 1
                    if depth_ == 0:
                        out.append(tok[i + 3:j])
                        closed = True
                        break
                j += 1
            if not closed:
                # 內層若帶引號，shlex 會把 token 切斷，這裡就找不到閉括號
                # （`echo "$(git commit -m "$(date)")"` 的第一個 token 是
                #  '$ ( git commit -m $'）。剩下的內容照樣要掃，否則整條漏擋。
                out.append(tok[i + 3:])
            i = j + 1 if j < len(tok) else len(tok)
            continue
        if tok[i] == '`':
            j = tok.find('`', i + 1)
            if j == -1:
                break
            out.append(tok[i + 1:j])
            i = j + 1
            continue
        i += 1
    return out


def scan(cmd, depth=0, varmap=None):
    """回傳命中描述或 None。varmap 追蹤 VAR=value 的賦值供 $VAR 展開。"""
    if depth > MAX_DEPTH:
        return None
    if varmap is None:
        varmap = {}

    # shlex 不把 ; & | ( ) 當分隔符，先補空白
    # 換行也是命令分隔符——shlex 會把它當普通空白，導致第二行的指令被當成第一行的參數
    # （`git status` 換行接 `git commit -m x` 整條漏擋）。先轉成 ; 一併處理。
    # 續行（反斜線接換行）是同一條指令，要先併起來——
    # 否則 `git \` 換行 `commit -m x` 會被切成兩段而漏擋。
    text = re.sub(r'\\\r?\n[ \t]*', ' ', cmd)
    # 順序重要：先砍註解再處理 heredoc——
    # 註解裡的 `<<EOF` 不是真的 heredoc，先處理 heredoc 會讓它吞掉後面的真指令。
    text = _strip_comments(text)
    text = _strip_heredocs(text)
    spaced = text.replace('\r\n', ';').replace('\n', ';').replace('\r', ';')
    # 順序重要：複合重導向（2>&1、1>&2、>&1）含 &，若先做分隔符切割會被拆成
    # `2>` / `&` / `1` 三段，指令從此斷開、git 落到非指令位置而漏擋
    # （`2>&1 git commit -m x` 是日常寫法，不是刁鑽組合）。
    # 故先把複合重導向整個圈成一個 token，再做一般的分隔符與重導向處理。
    # 複合重導向（2>&1、1>&2、>&1、&>）裡的 & 不是分隔符。先用佔位符把整段換掉，
    # 分隔符切割做完再還原——否則 & 會被當成背景執行符，把 `2>&1 git commit`
    # 從中間切斷，git 落到非指令位置而漏擋（日常寫法，不是刁鑽組合）。
    combo = []

    def _hold(m):
        combo.append(m.group(0))
        return ' \x02%d\x03 ' % (len(combo) - 1)

    spaced = re.sub(r'\d?>&\d?|&>>?', _hold, spaced)
    spaced = re.sub(r'([;&|()])', r' \1 ', spaced)
    # >file / 2>file 沒空白時 shlex 不會拆開，先補空白讓重導向自成 token，
    # 否則 `git symbolic-ref HEAD >/tmp/x` 的 ">/tmp/x" 會被算成第二個參數而誤擋
    spaced = re.sub(r'(\d?>>?|<<?<?)(?=\S)', r' \1 ', spaced)
    if combo:
        spaced = re.sub(r'\x02(\d+)\x03',
                        lambda m: combo[int(m.group(1))], spaced)
    # 單引號內的 $( 與反引號是「字面」不是替換（`echo '$(git commit)'` 只印字）。
    # shlex 會剝掉引號、之後就分不出來了，故先把單引號區段裡的替換標記中性化。
    # 只中性化「真正在單引號裡」的部分：雙引號內的單引號只是普通字元，
    # 那裡的 $( 仍然是替換（`echo "'$(git commit)'"` 會執行）。
    # 故先切出雙引號區段，只對區段外的單引號做中性化。
    def _neutralize_single_quotes(text):
        out, i, n = [], 0, len(text)
        while i < n:
            if text[i] == '"':                      # 雙引號區段原樣保留
                j = text.find('"', i + 1)
                if j == -1:
                    out.append(text[i:])
                    break
                out.append(text[i:j + 1])
                i = j + 1
                continue
            if text[i] == "'":                      # 單引號區段中性化
                j = text.find("'", i + 1)
                if j == -1:
                    out.append(text[i:])
                    break
                out.append(text[i:j + 1].replace('$', '\x00').replace('`', '\x01'))
                i = j + 1
                continue
            out.append(text[i])
            i += 1
        return ''.join(out)

    spaced = _neutralize_single_quotes(spaced)
    try:
        tokens = shlex.split(spaced, posix=True)
    except ValueError:
        return None
    return scan_tokens(tokens, depth, varmap)


def scan_tokens(tokens, depth=0, varmap=None):
    """判斷已斷好詞的 token 串。與 scan 分開是為了讓遞迴能直接傳 token，
    不必 ' '.join 重組成字串——重組會讓含空白的 token 失去引號而散開。"""
    if depth > MAX_DEPTH:
        return None
    if varmap is None:
        varmap = {}

    # 切段
    segments, seg = [], []
    for tok in tokens:
        if tok in SEPARATORS:
            segments.append(seg)
            seg = []
        else:
            seg.append(tok)
    segments.append(seg)

    for seg in segments:
        if not seg:
            continue

        # 雙引號裡的指令替換：`echo "$(git commit -m x)"` 的替換內容被 shlex 保留在
        # 單一 token 內（'$ ( git commit -m x ) '），token 層判斷看不到裡面的 git。
        # 逐 token 檢查，含替換標記且內含空白者遞迴掃其內容。
        for t in seg:
            if ('$ (' in t or '`' in t) and ' ' in t:
                # 只取替換「裡面」的內容當指令掃——連同外層的字一起掃的話，
                # `echo "a $(git commit) b"` 的 git 會落在 idx 1 而被指令位置判斷跳過。
                # 巢狀替換 `$(git commit -m "$(date)")` 用非貪婪 regex 會切在內層的 )，
                # 外層的 git commit 就看不到了。改為手動配對括號取最外層內容。
                for text in _extract_substitutions(t):
                    if not text.strip():
                        continue
                    hit = scan(text, depth + 1, dict(varmap))
                    if hit:
                        return hit

        # 指令前面可能同時有重導向與變數賦值，且順序任意
        # （`FOO=1 >/dev/null git commit`、`>/dev/null FOO=1 git commit` 都合法）。
        # 兩者交錯剝到剝不動為止，只剝一輪會讓 git 不在 idx 0 而被當成參數漏擋。
        i = 0
        stripped_keyword = False
        while i < len(seg):
            span = redirect_span(seg[i])
            if span and i + span - 1 < len(seg):
                seg = seg[:i] + seg[i + span:]
                continue
            # 控制結構關鍵字後面接的是指令，剝掉才看得到真正的 git
            # （`if git commit …; then` 的 git 位在 idx 1）
            if seg[i] in SHELL_KEYWORDS:
                seg = seg[:i] + seg[i + 1:]
                stripped_keyword = True
                continue
            # 關鍵字自己的選項（time -p）——只在剝過關鍵字後才跳，
            # 否則會誤吃掉 git 自己的全域旗標
            if stripped_keyword and seg[i].startswith('-'):
                seg = seg[:i] + seg[i + 1:]
                continue
            if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', seg[i]):
                k, v = seg[i].split('=', 1)
                # 反引號指令替換：WIP=`git commit -m x` 會被 shlex 斷成
                # ['WIP=`git', 'commit', ...]，賦值分支若直接刪掉這個 token，
                # 唯一帶 git 的線索就沒了 → 保留原 token 讓後面判斷。
                # 但條件要夠窄：只有「這個 token 本身就帶 git」才保留，
                # 否則 `X=$HOME git commit` 會因為值以 $ 開頭而停在段首賦值，
                # 後面真正的 git 反而被當成參數漏擋。
                if v[:1] in ('`', '$', '(') and is_git(seg[i]):
                    break
                varmap[k] = v
                seg = seg[:i] + seg[i + 1:]
                continue
            break
        rest_seg = seg
        if not rest_seg:
            continue

        # $VAR / ${VAR} 展開後重新掃這一段
        # 記下「哪些位置是展開來的」——後面要拆詞時只拆這些，
        # 用值比對（t in varmap.values()）會誤傷剛好同值的其他 token
        # （X='git commit -m x' 時，原本 bash -c 的指令字串也會被拆散）。
        expanded = []
        expanded_idx = set()
        changed = False
        for tok in rest_seg:
            m = re.fullmatch(r'\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?', tok)
            if m and m.group(1) in varmap:
                expanded_idx.add(len(expanded))
                expanded.append(varmap[m.group(1)])
                changed = True
            else:
                expanded.append(tok)
        if changed:
            # 展開值含空白時 shell 會再做分詞，但只有「那個 token」要拆——
            # 直接 ' '.join 整段會把其他原本含空白的 token
            #（bash -c 'git commit -m x' 的指令字串）也一起拆散而漏擋。
            flat = []
            for n, t in enumerate(expanded):
                if n in expanded_idx and ' ' in t:
                    flat.extend(t.split())
                else:
                    flat.append(t)
            hit = scan_tokens(flat, depth + 1, dict(varmap))
            if hit:
                return hit
            continue

        # 殼包裝：把指令包成字串或接在後面 → 遞迴看內層。
        # 兩類要分開處理，混在一起會誤判：
        #   A 只有「第一個非選項參數」是指令（bash -c 'cmd' _ arg1 arg2：後面是位置參數，
        #     不是指令。整串都掃會誤擋 `bash -c 'echo "$1"' _ 'git commit'`）
        #   B 後面整串就是指令（timeout 10 git commit、xargs -0 git commit、env FOO=1 git commit）
        head = rest_seg[0].split('/')[-1].split('\\')[-1]
        if head in SHELL_WRAPPERS:
            body = rest_seg[1:]
            # command -v/-V 只查指令在哪、不執行它 → 唯讀，放行。
            # 但 -v 必須出現在「指令名之前」才是 command 自己的旗標——
            # `command git commit -v -m x` 的 -v 是 git 的 verbose，那是真的在 commit。
            if head == 'command':
                readonly_query = False
                for a in body:
                    if a in ('-v', '-V'):
                        readonly_query = True
                        break
                    if not a.startswith('-'):
                        break          # 碰到指令名就停，後面的旗標都不算 command 的
                if readonly_query:
                    continue
            if not body:
                continue
            if head == 'eval':
                # eval 會把所有參數「串起來」當一條指令執行，
                # 所以 `eval git commit -m x` 與 `eval 'git commit -m x'` 等價，
                # 只掃第一個參數會漏掉前者。
                hit = scan(_unquote(' '.join(body)), depth + 1, dict(varmap))
            elif head in STRING_CMD_WRAPPERS:
                # A 類（bash/sh/zsh…）：要執行的指令字串是 -c 緊接的那個參數。
                # 不能用「第一個非選項參數」——`bash -o pipefail -c '…'` 的 pipefail
                # 是 -o 的值，那樣會掃錯對象而漏掉真正的 -c 內容。
                target = None
                n = 0
                while n < len(body):
                    t = body[n]
                    # -c 也可以合併在短旗標裡（bash -lc '…'、bash -xc '…'）
                    if (t == '-c' or (t.startswith('-') and not t.startswith('--')
                                      and 'c' in t[1:])) and n + 1 < len(body):
                        target = body[n + 1]
                        break
                    if t.startswith('-'):
                        # -o pipefail 這種會吃掉下一個 token
                        n += 2 if t in SHELL_OPTS_WITH_VALUE else 1
                        continue
                    # 沒有 -c：那是腳本「檔名」不是指令字串（sh script.sh），
                    # 當成指令掃會把 `sh 'git commit'`（執行名為 git commit 的檔）誤擋。
                    break
                if target is None:
                    continue
                hit = scan(_unquote(target), depth + 1, dict(varmap))
            else:
                # B 類（timeout/env/nohup/nice/xargs/command…）：後面某處開始是真正的指令。
                # 不列舉每個包裝詞的選項——那是列舉法，漏一個就是一個洞
                # （timeout 10 的 10、nice -n 10 的 10、stdbuf -oL 各有各的形狀）。
                # 改為跳過「包裝詞自己的東西」後看下一個 token 是不是 git：
                #   - -開頭的選項
                #   - VAR=value（env 的環境設定）
                #   - 純數字／時間量（timeout 10、nice -n 的值已被上一條吃掉）
                # 只跳過這三類，遇到其他詞就停——那才是真正被執行的指令。
                # 不能無條件「往後找第一個 git」：`env FOO=1 echo git commit` 執行的是
                # echo、git 只是它的參數，那樣會誤擋。
                k = 0
                while k < len(body):
                    t = body[k]
                    if t.startswith('-'):
                        # 有些選項會吃掉下一個 token（env -u FOO、xargs -n 1）
                        k += 2 if t in WRAPPER_OPTS_WITH_VALUE else 1
                    elif re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', t):
                        k += 1
                    elif re.fullmatch(r'\d+(\.\d+)?[smhd]?', t):
                        k += 1
                    else:
                        break
                body = body[k:]
                if not body:
                    continue
                # 用 token list 遞迴，不要 ' '.join 重組成字串——
                # 重組會讓含空白的 token（bash -c 'git commit -m x' 的那串）失去引號而散開，
                # 於是 `timeout 5 bash -c '…'` 的內層整個看不到（第七輪實測漏擋）。
                # 前置包裝（timeout/env/nice…）後面接的是「指令與它的參數」，
                # 參數裡的單引號內容是字面，不可還原佔位符——
                # `env echo '$(git commit)'` 只是印字，還原了會誤擋。
                hit = scan_tokens(body, depth + 1, dict(varmap))
            if hit:
                return hit
            continue

        # 一般情況：git 必須位在「指令位置」，不能是別的指令的參數。
        # 否則 `echo git commit`、`rg git commit` 這類會被誤擋（第五輪實際發生過）。
        # 指令位置＝該段第一個 token，或帶指令替換前綴者（$(git…、`git、VAR=$(git）。
        for idx, tok in enumerate(rest_seg):
            if not is_git(tok):
                continue
            if idx != 0 and tok == strip_noise(tok):
                continue
            rest = rest_seg[idx + 1:]
            aliases = {}
            j = 0
            # 跳過全域旗標與重導向（重導向可插在任何位置）
            while j < len(rest):
                t = rest[j]
                if t in REDIRECTS:
                    j += redirect_span(t)       # 跳過符號與它的目標（自帶目標者只跳 1）
                elif t in GLOBAL_OPTS_WITH_VALUE:
                    # -c alias.co=commit 這種要記下來
                    if j + 1 < len(rest):
                        m = re.match(r'^alias\.([^=]+)=(.+)$', rest[j + 1])
                        if m:
                            aliases[m.group(1)] = m.group(2)
                    j += 2
                elif t.startswith('-'):
                    m = re.match(r'^--\w[\w-]*=alias\.([^=]+)=(.+)$', t)
                    if m:
                        aliases[m.group(1)] = m.group(2)
                    j += 1
                else:
                    break
            if j >= len(rest):
                break
            sub = rest[j]
            extra_args = []
            # alias 展開（只認同一條指令裡用 -c 設的；讀不到使用者 .gitconfig）。
            # alias 的值可能自帶旗標（alias.b='branch -f'），只取第一個詞會把 -f 弄丟
            # 而漏擋，故其餘詞要併進參數一起判斷。
            if sub in aliases:
                parts = aliases[sub].split()
                sub = parts[0]
                extra_args = parts[1:]
            # 重導向可插在參數中間（git branch >/dev/null -f topic），遇到它要「跳過
            # 符號與目標」而不是停止掃描——停止會把後面的 -f 漏掉。
            args = list(extra_args)
            tail = rest[j + 1:]
            k2 = 0
            while k2 < len(tail):
                if tail[k2] in REDIRECTS:
                    k2 += redirect_span(tail[k2])
                    continue
                args.append(tail[k2])
                k2 += 1
            hit = judge(sub, args)
            if hit:
                return hit
            break
    return None


cmd = sys.stdin.read()
hit = scan(cmd)
if hit:
    print(hit)
    sys.exit(0)
sys.exit(1)
