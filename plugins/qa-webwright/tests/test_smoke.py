"""上線前健檢 tools/smoke.py 的純邏輯回歸（不起服務；起服務的實跑驗證見 CHANGELOG 0.10.0）。"""
import copy
import io
import json
import sys

import pytest

from conftest import SKILL, TEMPLATES

sys.path.insert(0, str(SKILL / "tools"))
import smoke  # noqa: E402


def _cfg():
    with io.open(str(TEMPLATES / "SMOKE.example.json"), encoding="utf-8") as fh:
        return json.load(fh)


def test_example_config_is_valid():
    c = smoke.validate(_cfg())
    assert [s["name"] for s in c["services"]] == ["backend", "frontend"]
    assert all(not smoke.config_warnings(s) for s in c["services"])


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.pop("levels"), "levels"),
    (lambda c: c["levels"].update({"X": 1}), "levels.X"),
    (lambda c: c["levels"].update({"X": "P0 and"}), "篩選式不合法"),
    (lambda c: c["services"][0].update({"port": "8080"}), "services[0].port"),
    (lambda c: c["services"][0].update({"port": True}), "services[0].port"),
    (lambda c: c["services"][0].update({"scheme": "ftp"}), "scheme"),
    (lambda c: c["services"][0]["start"].update({"args": "run"}), "start.args"),
    (lambda c: c["services"][0]["health"].update({"url": "localhost:8080"}), "health.url"),
    (lambda c: c["services"][1].update({"name": "backend"}), "重複"),
    (lambda c: c["services"][0].update({"typo_field": 1}), "不認得的欄位"),
    (lambda c: c.update({"report_dir": "../out"}), "report_dir"),
    (lambda c: c.update({"always_run": ["/abs/test_x.py"]}), "always_run[0]"),
    (lambda c: c["services"][0]["post_start_checks"].append({"type": "log_absent", "pattern": "("}), "regex"),
])
def test_bad_config_names_the_field(mutate, needle):
    c = _cfg()
    mutate(c)
    with pytest.raises(smoke.SmokeError) as ei:
        smoke.validate(c)
    assert needle in str(ei.value) and ei.value.code == 2


@pytest.mark.parametrize("expr,markers,want", [
    ("", set(), True), ("P0", {"P0"}, True), ("P0", {"P1"}, False), ("P0 or P1", {"P1"}, True),
    ("not P2", {"P1"}, True), ("(P0 or P1) and not P2", {"P0", "P2"}, False),
])
def test_marker_expression(expr, markers, want):
    assert smoke.marker_match(expr, markers) is want


def test_verified_bound_to_config_fingerprint():
    c = smoke.validate(_cfg())
    s = c["services"][0]
    s["verified"] = {"at": "x", "start_ok": True, "health_ok": True, "config_sha": smoke.fingerprint(s)}
    assert smoke.is_verified(s)
    t = copy.deepcopy(s)
    t["start"]["args"].append("--extra")
    assert not smoke.is_verified(t)


class _Ctx(object):
    def __init__(self, root):
        self.ws = str(root)
        self.cfg = {"issues_log": "issues.md"}

    def path(self, rel):
        return str(self.ws) + "/" + rel


def test_issues_append_same_day_goes_to_section_table_tail(tmp_path):
    (tmp_path / "issues.md").write_text(
        "# I\n\n## 2026-01-02\n\n| # | 對應 TC | 嚴重程度 | 問題描述 |\n|---|---|---|---|\n| 1 | A | Minor | a |\n\n"
        "## 2026-01-01\n\n| # | 對應 TC | 嚴重程度 | 問題描述 |\n|---|---|---|---|\n| 1 | OLD | Minor | o |\n",
        encoding="utf-8")
    ctx = _Ctx(tmp_path)
    smoke.append_issues(ctx, "2026-01-02", [("B", "Major", "b|c")])
    smoke.append_issues(ctx, "2026-01-03", [("C", "待判定", "c")])
    lines = (tmp_path / "issues.md").read_text(encoding="utf-8").splitlines()
    i = lines.index("| 1 | A | Minor | a |")
    assert lines[i + 1] == "| 2 | B | Major | b\\|c |"
    assert lines.index("## 2026-01-01") > i + 1
    assert lines[-1] == "| 1 | C | 待判定 | c |" and "## 2026-01-03" in lines


def test_manual_table_parse_and_template():
    text = (TEMPLATES / "SMOKE-manual.example.md").read_text(encoding="utf-8")
    lines, hi, cols, rows = smoke.parse_manual(text)
    assert len(rows) == 2 and all(k in cols for k in ("編號", "功能", "等級", "結果", "證據"))
    with pytest.raises(smoke.SmokeError):
        smoke.parse_manual("| 編號 | 功能 |\n|---|---|\n| a | b |\n")
