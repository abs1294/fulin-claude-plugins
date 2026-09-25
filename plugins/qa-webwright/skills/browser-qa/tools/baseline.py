"""所有稽核工具共用的 baseline（存量豁免）模組。

## 為什麼要有 baseline

存量違規不可能一次清完；全量零容忍的閘會變成永遠告警，最後一定被關掉。
baseline 把「當下存量」記成指紋清單，`--baseline` 模式只擋**新增**。

## 為什麼 baseline 需要保護

`--write-baseline` 是整套閘的**單點永久失效開關**：一旦把當下水位記進去，
那些違規就永久合法，而且不留痕跡。故統一加四道機械保護（各工具共用、不各寫一份）：

  ① 理由必填：`--write-baseline --why "<清掉了什麼>"`，寫進檔案供下一個人稽核。
  ② 不得夾帶新增：判準是**集合差**，不是總數比較——總數可能因清掉一批而下降，
     卻同時混進本輪新寫的違規一起被蓋章。新指紋只要有一個不在舊 baseline 內就拒寫，
     除非加 `--allow-raise`（僅限判準本身改變、指紋重算的情形，且 --why 要說明）。
  ③ 部分掃描不得重產：只掃一個資料夾就寫回去，會把**其他範圍的指紋整批抹掉**，
     水位假性歸零。只有全範圍掃描（all）才准寫。
  ④ 指紋不含行號：行號會隨無關編輯漂移（上面插一行註解，下面全部「變成新增」），
     baseline 就永遠對不上。指紋由各工具組成「類別|檔案|內容」。

⚠ 舊檔判斷一律用 `is not None`：檔案存在但 fingerprints 為空時是空 set（falsy），
  寫成 `if old:` 會讓水位歸零後整條保護被跳過——而那正是最該守的時候。

⚠ 檔案存在但壞掉（不是 JSON、fingerprints 不是字串清單）≠ 沒有 baseline：
  當成「沒有」會讓 `--write-baseline` 跳過集合差檢查、把新增一起蓋章。
  故壞檔一律明確報錯：`--baseline` 印 `QA-TOOL-RESULT: baseline-error` 並 exit 2（hook 據此擋下）；
  `--write-baseline` 拒寫，除非加 `--allow-raise` 並在 --why 說明。

已知限制（機器擋不住，靠文件與提示）：直接刪掉 baseline 檔再重產＝回到「首次產生」，
集合差無從比對；直接手改 JSON 加指紋也不經過本模組。hook 對 `_reports/*-baseline.json`
的直接寫入會提示改用 --write-baseline；刪檔與手改請在 code review 時看 git diff。

JSON 欄位：tool / generated_at / count / prev_count / why / fingerprints。
"""
import json
import os
import sys
from datetime import datetime

EXIT_REFUSED = 2
RESULT_ERROR = "QA-TOOL-RESULT: baseline-error"


class BaselineError(Exception):
    """baseline 檔存在但內容壞掉。"""


class BaselineUnreadable(BaselineError):
    """baseline 檔存在但讀不到（權限、被鎖）：閘端當「無從判斷」（scan-error），寫入端照樣拒寫。"""


def default_path(e2e_root, tool):
    return os.path.join(e2e_root, "_reports", "%s-baseline.json" % tool)


def add_args(parser, default_path_value):
    """給 argparse 加上統一的 baseline 旗標。"""
    parser.add_argument("--baseline", nargs="?", const=default_path_value, default=None,
                        metavar="PATH", help="只報 baseline 以外的**新增**（接閘用）")
    parser.add_argument("--write-baseline", nargs="?", const=default_path_value, default=None,
                        metavar="PATH", help="把當前存量寫成 baseline（必須帶 --why，只降不升）")
    parser.add_argument("--why", default=None, help="重產 baseline 的理由（--write-baseline 必填）")
    parser.add_argument("--allow-raise", action="store_true",
                        help="允許把新增一起收進 baseline（僅限判準本身改變時，--why 要說明）")


def load(path):
    """回傳指紋 set；檔案不存在回 None（＝沒有 baseline，走全量）；存在但壞掉丟 BaselineError。"""
    if not path:
        return None
    try:
        os.stat(path)
    except FileNotFoundError:
        return None                     # 真的不存在＝沒有 baseline
    except OSError as exc:
        # 上層目錄沒權限等：os.path.exists 會回 False，但這不是「不存在」而是讀不到 → 無從判斷
        raise BaselineUnreadable("%s 讀不到（%s: %s）" % (path, type(exc).__name__, exc))
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except OSError as exc:
        # 讀不到（權限、被鎖）≠ 內容壞掉：無從判斷，閘端 fail-open（不擋、不當成沒有 baseline）
        raise BaselineUnreadable("%s 讀不到（%s: %s）" % (path, type(exc).__name__, exc))
    except ValueError as exc:
        raise BaselineError("%s 不是合法 JSON（%s）" % (path, exc))
    if not isinstance(data, dict):
        raise BaselineError("%s 頂層不是 JSON 物件" % path)
    fps = data.get("fingerprints")
    if not isinstance(fps, list) or not all(isinstance(x, str) for x in fps):
        raise BaselineError("%s 的 fingerprints 不是字串清單" % path)
    return set(fps)


def load_for_gate(path):
    """`--baseline` 用：壞檔明確報錯並 exit 2（印 QA-TOOL-RESULT: baseline-error，hook 據此擋下）。"""
    try:
        return load(path)
    except BaselineUnreadable as exc:
        print("[錯誤] baseline 檔讀不到：%s——本次無從判斷新增與存量，不當成「沒有 baseline」，也不當成違規。" % exc)
        print("QA-TOOL-RESULT: scan-error")
        sys.exit(EXIT_REFUSED)
    except BaselineError as exc:
        print("[錯誤] baseline 檔壞掉：%s" % exc)
        print("       壞檔不能當成「沒有 baseline」——那會讓新增違規被當成存量豁免、或讓重產跳過集合差檢查。")
        print("       修法：從版控還原該檔；確定要重建就跑 `--write-baseline --why \"<原因>\" --allow-raise`。")
        print(RESULT_ERROR)
        sys.exit(EXIT_REFUSED)


def split(fingerprints, baseline):
    """回傳 (新增指紋 set, 存量豁免指紋 set)。baseline 為 None 時全部算新增。"""
    fps = set(fingerprints)
    if baseline is None:
        return fps, set()
    return fps - baseline, fps & baseline


def _atomic_write_json(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp-%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    os.replace(tmp, path)


def write(path, fingerprints, why, allow_raise=False, full_scan=True, tool="", unit="處"):
    """依四道保護決定是否寫入。回傳 (exit_code, 訊息行 list)。exit 0＝已寫；2＝拒絕。"""
    msgs = []
    if not full_scan:
        msgs.append("[拒絕] --write-baseline 只能對全範圍（all）跑。")
        msgs.append("       部分掃描寫回去會抹掉其他範圍的存量指紋，讓水位假性歸零。")
        return EXIT_REFUSED, msgs
    if not why or not str(why).strip():
        msgs.append('[拒絕] --write-baseline 必須帶 --why "<這批清掉了什麼>"。')
        msgs.append("       baseline 是這道閘的失效開關，改動要留給下一個人稽核的理由。")
        return EXIT_REFUSED, msgs
    new_fps = set(fingerprints)
    try:
        old = load(path)
    except BaselineError as exc:
        if not allow_raise:
            msgs.append("[拒絕] 舊 baseline 檔壞掉，無法做「不得夾帶新增」的集合差檢查：%s" % exc)
            msgs.append("       先從版控還原；確定要整份重建，加 --allow-raise 並在 --why 說明。")
            return EXIT_REFUSED, msgs
        old = None
    old_n = len(old) if old is not None else None
    added = sorted(new_fps - old) if old is not None else []
    if added and not allow_raise:
        msgs.append("[拒絕] 這次重產會把 %d %s**新增**蓋章成合法存量"
                    "（總數 %s → %d，總數下降不代表沒有新增）：" % (len(added), unit, old_n, len(new_fps)))
        for fp in added[:15]:
            msgs.append("         %s" % fp)
        if len(added) > 15:
            msgs.append("         …另有 %d %s" % (len(added) - 15, unit))
        msgs.append("       這表示本輪新寫了違規——修掉再重產，而不是把它蓋章成合法存量。")
        msgs.append("       真的要收（判準本身改了導致指紋重算）：加 --allow-raise 並在 --why 說明。")
        return EXIT_REFUSED, msgs
    fps = sorted(new_fps)
    _atomic_write_json(path, {
        "_comment": ("存量豁免清單（%s --write-baseline 產生）。指紋不含行號。"
                     "清掉一批後重產，讓水位跟著降——只降不升。"
                     "⚠ 這不是水位：看真實水位跑不帶 --baseline 的那次。" % (tool or "qa-webwright")),
        "tool": tool,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(fps),
        "prev_count": old_n,
        "why": why,
        "fingerprints": fps,
    })
    delta = "" if old_n is None else "（%d → %d，%+d）" % (old_n, len(fps), len(fps) - old_n)
    msgs.append("baseline 已寫入 %s：%d 筆存量指紋%s" % (path, len(fps), delta))
    msgs.append("理由：%s" % why)
    msgs.append("往後 --baseline 只報 baseline 以外的**新增**。")
    return 0, msgs
