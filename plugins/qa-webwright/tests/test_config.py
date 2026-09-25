"""專案參數檔約定：範例檔可被每支工具載入；缺檔有預設；壞檔明確報錯。"""
import json
import os
import shutil
import subprocess
import sys

import pytest

from conftest import PLUGIN, TEMPLATES

# 每支 CLI 工具與一組「不需要額外資源也能跑完」的參數
CLI = [
    ("drift_check.py", ["all"]),
    ("gen_catalog.py", []),
    ("skip_audit.py", ["all"]),
    ("hardcode_check.py", ["all"]),
    ("i18n_locator_check.py", ["all"]),
    ("make_skeleton.py", ["orders"]),
    ("fill_orphans.py", ["--dry-run"]),
    ("coverage_register.py", ["情境", "test_a", "完整", "orders"]),
    ("sweep_residue.py", []),
    ("run_by_folder.py", ["orders"]),
    ("migrate_catalog.py", ["--dry-run"]),
]


def _prep(p):
    p.write("orders/test_o.py", "def test_a():\n    pass\n")


@pytest.mark.parametrize("script,args", CLI)
def test_example_config_loads_in_every_tool(installed, script, args):
    shutil.copy(str(TEMPLATES / "qa-webwright.example.json"), str(installed.e2e / "qa-webwright.json"))
    _prep(installed)
    r = installed.tool(script, *args)
    out = r.stdout + r.stderr
    assert "參數檔錯誤" not in out and "Traceback" not in out, out
    assert r.returncode in (0, 1, 2), out
    if script == "migrate_catalog.py":
        assert "找不到舊版 catalog" in out     # 2＝沒有可遷移的東西，不是設定錯


@pytest.mark.parametrize("script,args", CLI)
def test_missing_config_uses_defaults(installed, script, args):
    (installed.e2e / "qa-webwright.json").unlink()
    _prep(installed)
    r = installed.tool(script, *args)
    out = r.stdout + r.stderr
    assert "Traceback" not in out and "參數檔錯誤" not in out, out


@pytest.mark.parametrize("script,args", CLI)
def test_broken_config_is_explicit_error(installed, script, args):
    (installed.e2e / "qa-webwright.json").write_text("{ not json", encoding="utf-8")
    _prep(installed)
    r = installed.tool(script, *args)
    assert r.returncode == 2 and "參數檔錯誤" in r.stderr and "不是合法 JSON" in r.stderr, r.stdout + r.stderr


def test_wrong_type_is_explicit_error(installed):
    installed.config(biz_tables="orders")
    r = installed.tool("hardcode_check.py", "all")
    assert r.returncode == 2 and "`biz_tables` 型別應為 list" in r.stderr


def test_missing_note_printed(installed):
    (installed.e2e / "qa-webwright.json").unlink()
    _prep(installed)
    r = installed.tool("hardcode_check.py", "all")
    assert "找不到" in r.stdout and "使用內建預設值" in r.stdout


def test_example_has_every_documented_key():
    ex = json.loads((TEMPLATES / "qa-webwright.example.json").read_text(encoding="utf-8"))
    for key in ("test_data_prefix", "intentional_prefixes", "biz_tables", "skeleton_tables", "ports",
                "residue", "db", "coverage", "catalog", "external_system_keywords", "data_source_tags",
                "skip_classify", "skip_gate", "env_requirements", "i18n", "hardcode", "hook"):
        assert key in ex, key
    assert ex["test_data_prefix"] == "E2E-"
    assert ex["coverage"]["placeholder"] == "待補"
    assert "BAD" in ex["intentional_prefixes"]
    assert len(ex["external_system_keywords"]) == 4


# ---------------- PreToolUse 閘的規則段（dispatch_gate / commit_gate / pretest / command_guards / report_hygiene / browser_guard）----------------

GATE_SECTIONS = ("dispatch_gate", "commit_gate", "pretest", "command_guards", "report_hygiene", "browser_guard")


def test_example_has_gate_sections():
    ex = json.loads((TEMPLATES / "qa-webwright.example.json").read_text(encoding="utf-8"))
    for key in GATE_SECTIONS:
        assert key in ex, key
    assert ex["commit_gate"]["enabled"] is True                       # 任務約定：範例開啟、程式預設關閉
    assert ex["dispatch_gate"]["checks"] == ["triage", "target_env", "data_source", "out_of_scope", "no_relay",
                                         "alignment", "scope_expansion", "field_verification"]
    names = [g["name"] for g in ex["command_guards"]]
    assert names == ["db-superuser", "service-env"]                  # 兩條示範：高權限 DB 帳號、服務啟動環境名
    assert ex["command_guards"][1]["enabled"] is False               # 會誤擋一般專案的示範預設不生效
    assert ex["pretest"]["alignment"] == [] and ex["pretest"]["side_effect_guards"] == []
    assert ex["pretest"]["_alignment_example"] and ex["pretest"]["_side_effect_guards_example"]
    assert "tests/e2e/reports" not in json.dumps(ex["report_hygiene"]["roots"])   # 不與 qa-flow.sh run 的 junit 落點衝突


def test_defaults_mean_gates_silent(installed):
    """參數檔沒有閘規則段時，DEFAULTS 代表「該閘靜默」。"""
    path = installed.e2e / "qa-webwright.json"
    cfg = json.loads(path.read_text(encoding="utf-8"))
    for key in GATE_SECTIONS:
        cfg.pop(key, None)
    path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    code = ("import sys, json; sys.path.insert(0, 'tools'); import qa_config as q; c = q.load(); "
            "print(json.dumps({k: c[k] for k in %r}))" % (GATE_SECTIONS,))
    r = subprocess.run([sys.executable, "-c", code], cwd=str(installed.e2e), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout.strip().splitlines()[-1])
    assert got["dispatch_gate"] is None
    assert got["commit_gate"] == {"enabled": False}
    assert got["pretest"]["alignment"] == [] and got["pretest"]["side_effect_guards"] == []
    assert got["command_guards"] == [] and got["report_hygiene"]["roots"] == []
    assert got["browser_guard"]["deny_hosts_regex"] is None and got["browser_guard"]["rate_limits"] == []


BAD_GATE_CONFIGS = [
    ({"dispatch_gate": "yes"}, "`dispatch_gate` 型別應為 dict"),
    ({"command_guards": {"name": "x"}}, "`command_guards` 型別應為 list"),
    ({"commit_gate": {"enabled": "true"}}, "`commit_gate.enabled` 型別應為 bool"),
    ({"commit_gate": {"behavior_globs": "**/*.js"}}, "`commit_gate.behavior_globs` 型別應為 list[str]"),
    ({"dispatch_gate": {"checks": ["triage", "typo"]}}, "不認得的檢查項"),
    ({"dispatch_gate": {"required_reading": [1]}}, "`dispatch_gate.required_reading` 型別應為 list[str]"),
    ({"command_guards": [{"deny_regex": ["-U sa"]}]}, "`command_guards[0]` 缺必填欄位 `when_regex`"),
    ({"command_guards": [{"when_regex": "x", "require_env": "A"}]}, "`command_guards[0].require_env` 型別應為 list[str]"),
    ({"pretest": {"alignment": [{"required": True}]}}, "`pretest.alignment[0]` 缺必填欄位 `env`"),
    ({"pretest": {"side_effect_guards": [{"file": "a", "require_regex": "x"}]}}, "`pretest.side_effect_guards[0].require_regex`"),
    ({"report_hygiene": {"roots": "tests/reports"}}, "`report_hygiene.roots` 型別應為 list[str]"),
    ({"browser_guard": {"rate_limits": [{"host_regex": ".*", "max": "3", "window_s": 10}]}}, "`browser_guard.rate_limits[0].max` 型別應為 int"),
    ({"browser_guard": {"rate_limits": [{"host_regex": ".*", "max": 3}]}}, "缺必填欄位 `window_s`"),
]


@pytest.mark.parametrize("updates,msg", BAD_GATE_CONFIGS, ids=[m for _u, m in BAD_GATE_CONFIGS])
def test_bad_gate_section_is_explicit_error(installed, updates, msg):
    installed.config(**updates)
    r = installed.tool("hardcode_check.py", "all")
    assert r.returncode == 2 and "參數檔錯誤" in r.stderr and msg in r.stderr, r.stdout + r.stderr


def test_comment_keys_in_gate_sections_are_ignored(installed):
    installed.config(commit_gate={"_doc": 123, "enabled": True, "_extra_commands_example": "x"})
    r = installed.tool("hardcode_check.py", "all")
    assert r.returncode in (0, 1) and "參數檔錯誤" not in r.stderr, r.stdout + r.stderr


HOOK_BAD = [
    ("guard-command-rules.js", {"command_guards": "sqlcmd"}, {"tool_name": "Bash", "tool_input": {"command": "sqlcmd -U sa"}}),
    ("guard-qa-dispatch.js", {"dispatch_gate": ["x"]}, {"tool_name": "Agent", "tool_input": {"subagent_type": "qa-engineer", "prompt": "x"}}),
    ("guard-report-output.js", {"report_hygiene": {"roots": "tests/reports"}}, {"tool_name": "Write", "tool_input": {"file_path": "tests/reports/a.xml"}}),
    ("guard-browser-nav.js", {"browser_guard": {"deny_hosts_regex": "(unclosed"}}, {"tool_name": "mcp__playwright__browser_navigate", "tool_input": {"url": "https://x.example.com"}}),
    ("guard-pretest-env.js", {"pretest": {"alignment": "x", "side_effect_guards": [{"file": "missing.cs", "require_regex": ["(bad"]}]}}, {"tool_name": "Bash", "tool_input": {"command": "python -m pytest"}}),
    ("guard-qa-before-commit.js", {"commit_gate": {"enabled": "yes"}}, {"tool_name": "Bash", "tool_input": {"command": "git commit -m x"}}),
]


@pytest.mark.skipif(shutil.which("node") is None, reason="本機沒有 node")
@pytest.mark.parametrize("hook,updates,payload", HOOK_BAD, ids=[h for h, _u, _p in HOOK_BAD])
def test_hook_side_bad_config_fails_open_silently(project, hook, updates, payload):
    """hook 端讀到壞型別／壞 regex：fail-open 且完全靜默（明確報錯是工具端的事）。"""
    project.e2e.mkdir(parents=True, exist_ok=True)
    (project.e2e / "qa-webwright.json").write_text(json.dumps(updates), encoding="utf-8")
    body = dict(payload, cwd=str(project.root))
    env = dict(os.environ)
    env.pop("CLAUDE_PROJECT_DIR", None)
    r = subprocess.run(["node", str(PLUGIN / "hooks" / hook)], input=json.dumps(body), cwd=str(project.root),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    assert r.returncode == 0 and r.stdout.strip() == "" and r.stderr.strip() == "", r.stdout + r.stderr
