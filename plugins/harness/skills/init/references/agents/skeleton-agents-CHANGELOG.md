# agent 定義變更紀錄

<!-- init 填空紀律（實例化後整段刪除）：
  - 落點＝`<落點>/.claude/agents/CHANGELOG.md`。本檔沒有 frontmatter；實測 Claude Code 2.1.288 不會把它列進 subagent 清單（/agents、/doctor 會不會報解析警告未驗證，有警告就改放 `.claude/harness/CHANGELOG.md` 的 `## agents/<檔名>` 節）。
  - 每支 init 實際建立的 agent 留一節（被 Phase 3 Q1 裁掉的不留）；沿用原有 agent 時，節名用原檔名，那一行寫「沿用原有定義，init 補上 <補了什麼>」。
-->

> 本目錄各 agent 定義的變更紀錄，依檔名分節。agent 定義每次派工都整份載入，所以紀錄不放在定義檔裡（規格見 `.claude/harness/05-knowledge-protocol.md` §4）。
> 格式：`- <YYYY-MM-DD> <改了什麼一句話>（<經使用者同意｜黃區自主｜綠區>）`。agent 定義屬紅區，改前先徵得使用者同意。

## backend-architect.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## backend-engineer.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## frontend-engineer.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## qa-engineer.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）

## code-reviewer.md
- {{YYYY-MM-DD}} 建立（harness plugin /harness:init 實例化）
