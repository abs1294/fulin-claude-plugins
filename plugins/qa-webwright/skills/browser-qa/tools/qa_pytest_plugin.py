"""qa-webwright 的 pytest 掛點（由 tests/e2e/conftest.py 的片段引入）。

做四件事：
  1. 執行事實層：makereport 收集每支測試的最終結果，sessionfinish 寫進 `.runs/results.sqlite`
     （批次名讀 QA_BATCH，相容舊名 E2E_BATCH；未帶記 adhoc）。寫入失敗在總結區印紅字，不吞。
  2. skip 閘：**執行期** skip 依 skip_audit.classify 分類，A/D 類讓整輪 exit 非 0。
     收集期 skip（@pytest.mark.skip/skipif 裝飾器）不計——開跑前就知道不適用是誠實的形式。
  3. 總結區：印 COVERAGE 漂移狀態（drift 0/0/0 才算 codify 完成）與 skip 分類。
  4. 環境閘：port 歸屬（QA_EXPECT_WORKTREE）、依 fixture 圖檢查必要環境變數（見 env_gates.py）。

⚠ 兩個踩過的坑：
  - `pytest_terminal_summary` 跑在 `pytest_sessionfinish` **之後**。exit code 閘若靠 summary
    設旗標，exitstatus 早已定案（訊息印得好好的、exit 仍是 0）。故 exit 閘在 sessionfinish 自己算。
  - 終端計數與 exit 閘必須同一口徑。本檔在 makereport 當下就判定「收集期／執行期」
    並只把執行期 skip 放進清單，summary 與 sessionfinish 讀同一份清單——不會出現
    「終端說 0 筆 A/D、exit 卻是 1」或反過來的分歧。

conftest 片段見 skill 的 templates/conftest_snippet.py（scaffold 會自動寫入）。
"""
import os

import pytest

try:
    from . import qa_config
    from . import runs_db
    from . import env_gates
except ImportError:  # 以非套件方式載入
    import qa_config
    import runs_db
    import env_gates

__all__ = [
    "pytest_configure",
    "pytest_runtest_makereport",
    "pytest_runtest_logreport",
    "pytest_testnodedown",
    "pytest_sessionfinish",
    "pytest_terminal_summary",
    "pytest_collection_modifyitems",
    "pytest_sessionstart",
]

_STATE = {"record_error": None, "recorded": 0, "config": None}
_PROP_SKIP = "qa_webwright_runtime_skip"
_PROP_STATIC = "qa_webwright_static_skip"


def _e2e_nodeid(item):
    """nodeid 一律換成相對 tests/e2e（rootdir 可能是專案根，nodeid 會多出 tests/e2e/ 前綴）。"""
    nodeid = item.nodeid
    try:
        path = str(getattr(item, "path", None) or item.fspath)
        rel = os.path.relpath(path, qa_config.e2e_root()).replace("\\", "/")
        if not rel.startswith(".."):
            tail = nodeid.split("::", 1)[1] if "::" in nodeid else item.name
            return "%s::%s" % (rel, tail)
    except (ValueError, TypeError):
        pass
    return nodeid


def _collection_time_skip(item, report):
    """這筆 skip 是不是收集期（裝飾器 skip/skipif）決定的。

    首選 pytest 內部的 skipped_by_mark 旗標（setup 時由 evaluate_skip_marks 設定）；
    拿不到時退回「setup 階段 ∧ 標記**條件成立**」：只看有沒有 skipif 標記不夠——
    `skipif(False)` 的測試在 fixture 裡執行期 `pytest.skip()` 會被誤豁免、繞過 A/D 閘。
    執行期 `pytest.skip()`（測試函式或 fixture 內呼叫）兩條都不成立。
    """
    try:
        from _pytest.skipping import skipped_by_mark_key
        val = item.stash.get(skipped_by_mark_key, None)
        if val is not None:
            return bool(val)
    except Exception:  # noqa: BLE001 — 舊版 pytest 沒有 stash／key
        pass
    if report.when != "setup":
        return False
    return _marks_would_skip(item)


def _marks_would_skip(item):
    """skip 標記一律成立；skipif 只有條件為真才成立（字串條件交給 pytest 自己評估，評估不了視為不成立＝從嚴計入閘）。"""
    if any(True for _ in item.iter_markers("skip")):
        return True
    for mark in item.iter_markers("skipif"):
        conds = list(mark.args) if mark.args else ([mark.kwargs["condition"]] if "condition" in mark.kwargs else [])
        if not conds:
            return True   # skipif() 沒給條件＝無條件跳過
        for cond in conds:
            if isinstance(cond, str):
                try:
                    from _pytest.skipping import evaluate_condition
                    if evaluate_condition(item, mark, cond)[0]:
                        return True
                except Exception:  # noqa: BLE001
                    continue
            elif bool(cond):
                return True
    return False


def pytest_configure(config):
    # 每次 session 重設：同一個 Python 程序連續呼叫 pytest.main() 時不得沿用上一輪的錯誤、筆數與說明
    _STATE.update({"record_error": None, "recorded": 0, "port_notes": []})
    config._qa_reports = []
    config._qa_runtime_skips = []   # [(cls, loc, line, reason)]，只含執行期 skip
    config._qa_static_skips = 0
    config._qa_started_at = runs_db.utc_now_iso()
    _STATE["config"] = config


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    try:
        config = item.config
        if not hasattr(config, "_qa_reports"):
            pytest_configure(config)
        if report.when == "call" or (report.when == "setup" and report.outcome != "passed"):
            result = report.outcome
            if hasattr(report, "wasxfail"):
                result = "xfailed" if report.skipped else "xpassed"
            config._qa_reports.append((_e2e_nodeid(item), result, getattr(report, "duration", 0.0)))
        elif report.when == "teardown" and report.failed:
            # teardown 失敗（清理沒做成）＝這支測試不是綠的：與 pytest 自己的口徑一致記為 error
            nodeid = _e2e_nodeid(item)
            for k in range(len(config._qa_reports) - 1, -1, -1):
                if config._qa_reports[k][0] == nodeid:
                    config._qa_reports[k] = (nodeid, "error", config._qa_reports[k][2])
                    break
            else:
                config._qa_reports.append((nodeid, "error", getattr(report, "duration", 0.0)))
        if report.skipped and not hasattr(report, "wasxfail"):
            if _collection_time_skip(item, report):
                config._qa_static_skips += 1
                report.user_properties.append((_PROP_STATIC, 1))
            else:
                lr = report.longrepr
                reason, loc, line = "", "", 0
                if isinstance(lr, tuple) and len(lr) >= 3:
                    loc, line, reason = str(lr[0]), lr[1], str(lr[2])
                reason = reason.replace("Skipped: ", "", 1)
                try:
                    from . import skip_audit
                except ImportError:
                    import skip_audit
                cls = skip_audit.classify(reason)
                try:
                    loc = os.path.relpath(loc, qa_config.e2e_root()).replace("\\", "/")
                except ValueError:
                    pass
                config._qa_runtime_skips.append((cls, loc, line, reason[:100]))
                # xdist：分類結果掛在報告上（user_properties 會序列化回控制端），由控制端彙整後套 A/D 閘
                report.user_properties.append((_PROP_SKIP, [cls, loc, line, reason[:100]]))
        elif (report.skipped and hasattr(report, "wasxfail") and call.excinfo is not None
              and call.excinfo.errisinstance(pytest.xfail.Exception)):
            # 執行期 pytest.xfail("沒資料")：與執行期 skip 同一條繞路——理由屬 A/D 類就一樣計入閘。
            # 其他理由（已知缺陷鎖定）照常是 xfail；xfail 標記（@pytest.mark.xfail）不走這裡
            try:
                from . import skip_audit
            except ImportError:
                import skip_audit
            reason = "xfail: " + str(report.wasxfail or "")
            cls = skip_audit.classify(str(report.wasxfail or ""))
            if cls in ("A", "D"):
                loc, line = "", 0
                try:
                    loc = str(item.location[0]).replace("\\", "/")
                    line = int(item.location[1]) + 1
                    loc = os.path.relpath(os.path.join(str(item.config.rootpath), loc),
                                          qa_config.e2e_root()).replace("\\", "/")
                except (ValueError, TypeError, AttributeError):
                    pass
                config._qa_runtime_skips.append((cls, loc, line, reason[:100]))
                report.user_properties.append((_PROP_SKIP, [cls, loc, line, reason[:100]]))
    except Exception as exc:  # noqa: BLE001 — 觀測層不得讓測試失敗，但錯誤要浮上來
        _STATE["record_error"] = "%s: %s" % (type(exc).__name__, exc)


def pytest_runtest_logreport(report):
    """pytest-xdist 的控制端：worker 的報告在這裡收到（帶 report.node）。把 worker 分類好的執行期 skip
    彙整到控制端，sessionfinish 的 A/D 閘與總結區才看得到（worker 端改 exitstatus 不會傳回控制端）。"""
    if getattr(report, "node", None) is None:
        return   # 非 xdist（或 worker 自己）：makereport 已經記過
    config = _STATE.get("config")
    if config is None:
        return
    try:
        for key, val in getattr(report, "user_properties", None) or []:
            if key == _PROP_SKIP and isinstance(val, (list, tuple)) and len(val) == 4:
                config._qa_runtime_skips.append(tuple(val))
            elif key == _PROP_STATIC:
                config._qa_static_skips += 1
    except Exception as exc:  # noqa: BLE001
        _STATE["record_error"] = "%s: %s" % (type(exc).__name__, exc)


@pytest.hookimpl(optionalhook=True)
def pytest_testnodedown(node, error):
    """pytest-xdist 控制端：worker 結束時帶回的記錄錯誤（沒裝 xdist 時這個 hook 不存在，optionalhook 不報錯）。"""
    err = (getattr(node, "workeroutput", None) or {}).get("qa_webwright_record_error")
    if err and not _STATE.get("record_error"):
        _STATE["record_error"] = "worker %s：%s" % (getattr(getattr(node, "gateway", None), "id", "?"), err)


def pytest_sessionstart(session):
    """port 歸屬閘：QA_EXPECT_WORKTREE 未設不檢查；不符 pytest.exit(3)。"""
    try:
        ok, lines = env_gates.port_guard_check()
    except Exception:  # noqa: BLE001 — 閘本身故障不擋跑
        return
    if not ok:
        pytest.exit("\n" + "\n".join(lines), returncode=3)
    # 通過但有說明（查不到歸屬、參數檔沒設 port 而略過）：總結區照印，不得無聲略過
    _STATE["port_notes"] = list(lines or [])


def _will_skip(item):
    """收集期就決定跳過的測試（@pytest.mark.skip、條件成立的 skipif）：不會跑，不需要它的環境件。"""
    try:
        from _pytest.skipping import evaluate_skip_marks
        return evaluate_skip_marks(item) is not None
    except Exception:  # noqa: BLE001 — 內部 API 不可用或條件求值失敗：退回只看 skip 標記與布林條件
        if item.get_closest_marker("skip") is not None:
            return True
        for m in item.iter_markers("skipif"):
            conds = m.args or ((m.kwargs["condition"],) if "condition" in m.kwargs else ())
            if any(isinstance(c, bool) and c for c in conds):
                return True
        return False


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(session, config, items):
    """依 collect 結果的 fixture 圖檢查必要環境變數；缺件 → UsageError（開跑前就擋）。

    trylast：排在 pytest 自己的 -k／-m 篩選之後——被排除、或收集期就標了 skip 的測試不會跑，不得因它們缺環境件擋整輪。
    """
    try:
        problems = env_gates.fixture_env_problems([it for it in items if not _will_skip(it)])
    except Exception:  # noqa: BLE001
        return
    if problems:
        raise pytest.UsageError(env_gates.format_fixture_env_report(problems))


def pytest_sessionfinish(session, exitstatus):
    config = session.config
    try:
        reports = getattr(config, "_qa_reports", [])
        if reports:
            batch = os.environ.get("QA_BATCH") or os.environ.get("E2E_BATCH") or "adhoc"
            # pytest-xdist：每個 worker 各自 sessionfinish；共用控制端發的 testrunuid 當 run_id，
            # 資料夾摘要才會把所有 worker 的結果算進同一次執行（否則只取到其中一個 worker）
            winput = getattr(config, "workerinput", None)
            run_id = (winput or {}).get("testrunuid") if isinstance(winput, dict) else None
            _STATE["recorded"] = runs_db.record_run(
                run_id or runs_db.new_run_id(), getattr(config, "_qa_started_at", None) or runs_db.utc_now_iso(),
                batch, reports, runs_db.db_path())
    except Exception as exc:  # noqa: BLE001
        _STATE["record_error"] = "%s: %s" % (type(exc).__name__, exc)
    # xdist worker：記錄失敗要讓控制端知道（總結區在控制端印），經 workeroutput 帶回
    winput_out = getattr(config, "workeroutput", None)
    if _STATE["record_error"] and isinstance(winput_out, dict):
        winput_out["qa_webwright_record_error"] = _STATE["record_error"]

    # A/D 類執行期 skip → 整輪失敗。在這裡算（terminal_summary 太晚）。
    try:
        cfg = qa_config.load()
        if cfg.get("skip_gate", True):
            n_ad = sum(1 for s in getattr(config, "_qa_runtime_skips", []) if s[0] in ("A", "D"))
            if n_ad and session.exitstatus == 0:
                session.exitstatus = 1
    except Exception:  # noqa: BLE001
        pass


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    tr = terminalreporter
    if _STATE["record_error"]:
        tr.write_sep("=", "ERROR: qa run recording FAILED — %s" % _STATE["record_error"], red=True, bold=True)
        tr.write_line("  .runs/results.sqlite 未更新，CATALOG 的執行日期會停在上次成功記錄。")
    else:
        # 只印相對 tests/e2e 的路徑：完整本機路徑會跟著 pytest 輸出進日誌
        tr.write_line("qa-webwright: recorded %d result(s) → tests/e2e/.runs/results.sqlite" % _STATE["recorded"])
    for note in _STATE.get("port_notes") or []:
        tr.write_line(note)

    # COVERAGE 漂移：只在三層模式（有參數檔或已有 COVERAGE）時印
    try:
        cfg = qa_config.load()
        try:
            from . import drift_check, coverage_md
        except ImportError:
            import drift_check
            import coverage_md
        has_cov = any(os.path.exists(coverage_md.coverage_path(f, cfg))
                      for f in coverage_md.test_folders(cfg.root))
        if cfg.found or has_cov:
            clean, line = drift_check.summary_line()
            if clean:
                tr.write_line("COVERAGE drift clean — " + line)
            else:
                tr.write_line("⚠️ COVERAGE DRIFT — " + line + "（codify 未完成：drift 須 0/0/0，勿當綠燈交差）")
    except Exception as exc:  # noqa: BLE001
        tr.write_line("⚠️ drift_check 無法執行（%s）——機械保證鏽了，要修" % type(exc).__name__)

    skips = getattr(config, "_qa_runtime_skips", [])
    static_n = getattr(config, "_qa_static_skips", 0)
    if skips or static_n:
        buckets = {}
        for cls, _loc, _line, _r in skips:
            buckets[cls] = buckets.get(cls, 0) + 1
        parts = ", ".join("%s=%d" % (k, buckets[k]) for k in sorted(buckets)) or "無"
        tr.write_line("SKIP 分類 — 收集期 skip/skipif＝%d（不計入閘）；執行期 skip＝%d：%s"
                      "  A=資料不存在（該自種）／B=環境不可用（合理）／C=結構變更（該 fail）／D=共用狀態被佔（該 fail）"
                      % (static_n, len(skips), parts))
        offenders = [s for s in skips if s[0] in ("A", "D")]
        if offenders:
            try:
                gate_on = bool(qa_config.load().get("skip_gate", True))
            except Exception:  # noqa: BLE001 — 參數檔壞掉時 sessionfinish 也沒套閘
                gate_on = False
            verdict = ("整輪判為失敗" if gate_on
                       else "參數檔 skip_gate=false，本輪**不**因此判失敗——但它仍然沒測到")
            tr.write_line("")
            tr.write_line("⛔ 本輪有 %d 支測試因 A/D 類理由在執行期跳過——這不是綠燈，是沒測到（%s）"
                          % (len(offenders), verdict))
            for cls, loc, line, reason in offenders[:20]:
                tr.write_line("   [%s] %s:%s  %s" % (cls, loc, line, reason))
            if len(offenders) > 20:
                tr.write_line("   …另有 %d 筆（python tools/skip_audit.py all --list）" % (len(offenders) - 20))
            tr.write_line("   修法：A＝走產品入口自種，造不出來才 fail；D＝改 fail，teardown 要還原狀態。"
                          "開跑前就知道不適用的，改寫成收集期 @pytest.mark.skipif（具名條件）。")
