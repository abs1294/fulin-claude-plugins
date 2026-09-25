# ---- qa-webwright 掛點（qa-flow.sh scaffold 產生；既有 conftest.py 請把本段貼到檔尾）----
# 接上三層架構的執行事實層與閘：
#   - 每支測試結果寫進 tests/e2e/.runs/results.sqlite（批次名：QA_BATCH，相容 E2E_BATCH）
#   - 執行期 A/D 類 skip 讓整輪 exit 非 0；收集期 @pytest.mark.skipif 不計
#   - 總結區印 COVERAGE drift 與 skip 分類
#   - port 歸屬閘（QA_EXPECT_WORKTREE）與 fixture 圖環境檢查（qa-webwright.json env_requirements）
# 工具本體在 tests/e2e/tools/（qa-flow.sh tools-sync 更新）；專案值在 tests/e2e/qa-webwright.json。
#
# 兩個設計（避免貼進既有 conftest.py 時互相干擾）：
#   1. 不直接 `from tools.qa_pytest_plugin import pytest_configure, …`：同名 import 會把專案自己的
#      pytest_configure／pytest_terminal_summary 等 hook 蓋掉。改成把掛點模組註冊成獨立的 pytest plugin
#      （名稱 qa-webwright），與專案 conftest 的 hook 並存。
#   2. 工具目錄以專屬套件名 `qa_webwright_tools` 載入，不走頂層 `tools`：專案或第三方若也有叫 tools 的套件
#      （而且可能已被載入、留在 sys.modules），兩者不會互相遮蔽。套件物件直接建、只設搜尋路徑，
#      **不執行** tools/__init__.py（專案若自有同名檔，安裝器會保留它，它的初始化碼與本掛點無關）。
#      套件名帶 tools 目錄的雜湊：同一個 Python 程序載入兩個專案的掛點時，各自用自己的 tools，不會沿用先載入的那份。
import hashlib as _qa_hashlib
import importlib as _qa_importlib
import inspect as _qa_inspect
import os as _qa_os
import sys as _qa_sys
import types as _qa_types

_QA_TOOLS_DIR = _qa_os.path.join(_qa_os.path.dirname(_qa_os.path.abspath(__file__)), "tools")
_QA_PKG = "qa_webwright_tools_" + _qa_hashlib.sha1(
    _qa_os.path.normcase(_qa_os.path.realpath(_QA_TOOLS_DIR)).encode("utf-8")).hexdigest()[:10]
if _QA_PKG not in _qa_sys.modules:
    _qa_pkg = _qa_types.ModuleType(_QA_PKG)
    _qa_pkg.__path__ = [_QA_TOOLS_DIR]
    _qa_pkg.__package__ = _QA_PKG
    _qa_sys.modules[_QA_PKG] = _qa_pkg
_qa_plugin = _qa_importlib.import_module(_QA_PKG + ".qa_pytest_plugin")

_qa_prev_registered = globals().get("pytest_plugin_registered")


def pytest_plugin_registered(plugin, manager):
    """conftest 自己被註冊時（歷史 hook，一定會收到）順手註冊掛點 plugin；專案原本若也定義了本 hook 就接著呼叫它。"""
    existing = manager.get_plugin("qa-webwright")
    if existing is None:
        manager.register(_qa_plugin, "qa-webwright")
    elif existing is not _qa_plugin and not getattr(_qa_plugin, "_qa_webwright_warned", False):
        # 同一次 pytest 收到兩個 tests/e2e 的掛點：只有先載入的那個生效（執行紀錄與閘以它的參數檔為準）——明講，不沉默
        _qa_plugin._qa_webwright_warned = True
        # 印到 stderr，不用 warnings.warn：專案設了 filterwarnings=error 時警告會變例外，讓 conftest 載入失敗
        _qa_sys.stderr.write("[qa-webwright] 這次 pytest 同時收到多個 tests/e2e 的掛點，只有先載入的那個生效；"
                             "請分開對各專案執行 pytest\n")
    if _qa_prev_registered is not None:
        # 專案原本的 hook 可能要 plugin／plugin_name／manager 任意組合：照它的簽章給（plugin_name 由 manager 反查）
        names = _qa_inspect.signature(_qa_prev_registered).parameters
        args = {"plugin": plugin, "manager": manager}
        if "plugin_name" in names:
            args["plugin_name"] = manager.get_name(plugin)
        _qa_prev_registered(**{k: v for k, v in args.items() if k in names})
# ---- /qa-webwright 掛點 ----
