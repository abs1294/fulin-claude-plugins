"""文件與版本、方法論去專案化、條號只增不改。"""
import json
import re
import shutil
import subprocess

import pytest

from conftest import PLUGIN, SKILL

VERSION = "0.9.0"
# 來源專案禁字：與 test_review_fixes.H3_BANNED 同一份（不分大小寫、ASCII 縮寫用字界；拆開寫免得本檔自己命中）
from test_review_fixes import H3_BANNED  # noqa: E402

BANNED = re.compile("|".join(H3_BANNED), re.I)
# 條號只增不改的例外：有意改名且全 plugin 引用已同步者（舊標題 → 新標題）
RENAMED_HEADINGS = {
    # 0.9.0：Phase 2 的步驟清單由「必須 TaskCreate」改為完成判準清單（可用任務工具追蹤，非強制）；
    # 派工範本、qa-run、qa-engineer、Stop hook 訊息的引用已一併改成新標題
    "### 強制步驟追蹤（MANDATORY）": "### 執行清單（完成判準）",
}


def test_plugin_json_version():
    data = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    assert data["version"] == VERSION
    assert "三層" in data["description"] and "qa-webwright.json" in data["description"]


def test_changelog_top_entry():
    text = (PLUGIN / "CHANGELOG.md").read_text(encoding="utf-8")
    first = re.search(r"^## \[(\d+\.\d+\.\d+)\]", text, re.M)
    assert first and first.group(1) == VERSION
    entry = text.split("## [%s]" % VERSION, 1)[1].split("\n## [", 1)[0]
    for sec in ("### Added", "### Changed", "### Fixed"):
        assert sec in entry
    for n in range(1, 7):
        assert re.search(r"^%d\. \*\*" % n, entry, re.M), "六個缺陷第 %d 條" % n


def test_marketplace_entry():
    mp = PLUGIN.parents[1] / ".claude-plugin" / "marketplace.json"
    if not mp.exists():
        pytest.skip("不在 monorepo 內")
    data = json.loads(mp.read_text(encoding="utf-8"))
    entry = [p for p in data["plugins"] if p["name"] == "qa-webwright"][0]
    assert entry["source"] == "./plugins/qa-webwright"
    if "version" in entry:
        assert entry["version"] == VERSION


def test_skill_doc_map_files_exist():
    text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    section = text.split("## 文件地圖", 1)[1]
    paths = set(re.findall(r"`((?:methodology|knowledge|templates|lib|tools)/[\w./-]+|qa-flow\.sh)`", section))
    tools = re.findall(r"`(\w+\.py)`", section.split("`tools/`", 1)[1].split("\n", 1)[0])
    assert len(paths) >= 8 and len(tools) >= 15
    for p in paths:
        assert (SKILL / p).exists(), p
    for t in tools:
        assert (SKILL / "tools" / t).exists(), t
    # 反向：methodology/ 與 tools/ 底下的檔都要列在地圖上
    for f in (SKILL / "methodology").glob("*.md"):
        assert "methodology/%s" % f.name in section, f.name
    for f in (SKILL / "tools").glob("*.py"):
        if f.name != "__init__.py":
            assert f.name in section, f.name


def test_skill_doc_map_lists_all_pitfall_sections():
    pit = (SKILL / "knowledge" / "pitfalls.md").read_text(encoding="utf-8")
    letters = re.findall(r"^## ([A-Z]\d?)\.", pit, re.M)
    section = (SKILL / "SKILL.md").read_text(encoding="utf-8").split("## 文件地圖", 1)[1]
    line = [ln for ln in section.splitlines() if "knowledge/pitfalls.md" in ln][0]
    for letter in letters:
        assert re.search(r"(?<![A-Za-z])%s(?![a-z])" % re.escape(letter), line), letter


def test_readme_sections():
    text = (PLUGIN / "README.md").read_text(encoding="utf-8")
    for h in ("## 三層登記架構", "## 專案參數檔", "## 跳脫機制總表", "## baseline（存量豁免）用法", "## hook 一覽",
              "python3 -m pip install pytest-playwright", "python3 -m playwright install chromium",
              "guard-test-asset-hygiene.js"):
        assert h in text, h


def test_agent_and_command_completion_criterion():
    for rel in ("agents/qa-engineer.md", "commands/qa-run.md"):
        text = (PLUGIN / rel).read_text(encoding="utf-8")
        assert "drift 0/0/0" in text, rel
        assert "COVERAGE.md" in text, rel


def test_hooks_json_registers_hygiene_hook():
    data = json.loads((PLUGIN / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    cmds = [(entry["matcher"], h["command"]) for entry in data["hooks"]["PostToolUse"] for h in entry["hooks"]]
    assert any("Write" in m and "Edit" in m and "guard-test-asset-hygiene.js" in c for m, c in cmds), cmds


def _plugin_text_files():
    for p in sorted(PLUGIN.rglob("*")):
        if p.is_file() and p.suffix in (".md", ".py", ".js", ".mjs", ".json", ".sh") \
                and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts:
            yield p


def test_no_project_names_in_plugin():
    """plugin 內容（含 CHANGELOG）不得出現來源專案名詞。"""
    hits = []
    for p in _plugin_text_files():
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if BANNED.search(line):
                hits.append("%s:%d %s" % (p.relative_to(PLUGIN).as_posix(), i, line.strip()[:80]))
    assert hits == [], "\n".join(hits)


def test_no_ai_attribution():
    pat = re.compile("|".join(["Co-" + "Authored-By", r"Generated with \[?" + "Claude", chr(0x1F916),
                               "noreply@" + "anthropic"]), re.I)
    hits = [p.name for p in _plugin_text_files() if pat.search(p.read_text(encoding="utf-8"))]
    assert hits == [], hits


@pytest.mark.parametrize("rel", ["skills/browser-qa/methodology/critical-points.md",
                                 "skills/browser-qa/methodology/test-plan-design.md",
                                 "skills/browser-qa/knowledge/pitfalls.md",
                                 "skills/browser-qa/SKILL.md"])
def test_headings_only_added_never_changed(rel):
    """條號只增不改：0.8.2 時的每個標題在現版都原樣存在。"""
    git = shutil.which("git")
    if not git:
        pytest.skip("沒有 git，無法取得舊版比對")
    r = subprocess.run([git, "show", "HEAD:plugins/qa-webwright/" + rel], cwd=str(PLUGIN),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        pytest.skip("HEAD 取不到舊版（非 monorepo 工作目錄）：%s" % r.stderr.strip()[:80])
    old = [ln.rstrip("\r") for ln in r.stdout.splitlines() if re.match(r"^#{1,6} ", ln)]
    new = set(ln for ln in (PLUGIN / rel).read_text(encoding="utf-8").splitlines() if re.match(r"^#{1,6} ", ln))
    missing = [h for h in old if h not in new and RENAMED_HEADINGS.get(h) not in new]
    assert missing == [], missing


# ---------------- hook 接線與文件對帳（本輪六支 PreToolUse 閘） ----------------

def _hooks_json_scripts():
    data = json.loads((PLUGIN / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    out = []
    for event, entries in data["hooks"].items():
        for entry in entries:
            for h in entry["hooks"]:
                m = re.search(r"hooks/([\w.-]+\.js)", h["command"])
                assert m, h["command"]
                out.append((event, entry["matcher"], m.group(1)))
    return out


def test_hooks_json_every_hook_file_exists_and_listed_in_readme():
    readme = (PLUGIN / "README.md").read_text(encoding="utf-8")
    table = readme.split("## hook 一覽", 1)[1].split("\n## ", 1)[0]
    scripts = _hooks_json_scripts()
    assert len(scripts) >= 10, scripts
    for _event, _matcher, name in scripts:
        assert (PLUGIN / "hooks" / name).is_file(), name
        assert "`%s`" % name in table, "README「hook 一覽」沒列 %s" % name
    # 反向：hooks/ 底下的 hook 檔（lib 與測試除外）都要接線
    wired = {n for _e, _m, n in scripts}
    for f in (PLUGIN / "hooks").glob("*.js"):
        assert f.name in wired, "hooks/%s 存在卻沒登錄 hooks.json" % f.name


@pytest.mark.parametrize("name,event,needle", [
    ("guard-qa-dispatch.js", "PreToolUse", "Agent"),
    ("guard-qa-before-commit.js", "PreToolUse", "Skill"),
    ("guard-qa-before-commit.js", "PreToolUse", "Bash"),
    ("guard-pretest-env.js", "PreToolUse", "Bash"),
    ("guard-command-rules.js", "PreToolUse", "Bash"),
    ("guard-report-output.js", "PreToolUse", "Write"),
    ("guard-report-output.js", "PreToolUse", "Bash"),
    ("guard-browser-nav.js", "PreToolUse", "mcp__playwright__browser_navigate"),
    ("guard-browser-nav.js", "PreToolUse", "mcp__claude-in-chrome__tabs_create_mcp"),
])
def test_new_gates_wired_with_matchers(name, event, needle):
    hits = [m for e, m, n in _hooks_json_scripts() if n == name and e == event]
    assert any(needle in m.split("|") for m in hits), (name, hits)


def _dispatch_block(rel):
    text = (PLUGIN / rel).read_text(encoding="utf-8").replace("\r\n", "\n")
    m = re.search(r"<!-- qa-dispatch-template:begin -->\s*```text\n(.*?)```\s*<!-- qa-dispatch-template:end -->", text, re.S)
    assert m, "%s 沒有派工範本區塊" % rel
    return m.group(1)


def test_dispatch_template_identical_in_skill_command_agent():
    """加閘沒同步範本＝照範本寫仍被擋：三份範本必須逐字一致。"""
    base = _dispatch_block("skills/browser-qa/SKILL.md")
    for rel in ("commands/qa-run.md", "agents/qa-engineer.md"):
        assert _dispatch_block(rel) == base, rel
    for tag in ("【增量分流】", "【目標環境】", "【測試資料來源】", "【範圍外發現】", "【開工前必讀】", "不得再轉派"):
        assert tag in base, tag


def test_readme_pretool_gate_section():
    text = (PLUGIN / "README.md").read_text(encoding="utf-8")
    sec = text.split("## PreToolUse 閘（參數檔各段與放行語法）", 1)[1].split("\n## ", 1)[0]
    for key in ("dispatch_gate", "commit_gate", "pretest", "command_guards", "report_hygiene", "browser_guard"):
        assert "`%s`" % key in sec, key
    grammar = sec.split("各閘放行語法總表", 1)[1]
    for gate in ("guard-qa-dispatch", "guard-qa-before-commit", "guard-pretest-env", "guard-command-rules",
                 "guard-report-output", "guard-browser-nav"):
        assert "| %s |" % gate in grammar, gate

