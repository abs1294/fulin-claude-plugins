# msproject-wbs

**產生 MS Project 可直接匯入的 WBS 專案時程 XML（MSPDI 格式）**——第一層功能模組、第二層工項，含工期、負責資源、前置依賴、資源指派；日期照依賴鏈自動展開成甘特圖。

手刻 MSPDI XML 極易踩雷（檔案打不開 / 日期全塌到起始日 / 工期顯示 0），本 plugin 把七個實戰踩過的雷全部編碼進生成腳本 `scripts/generate-wbs.mjs`（含 Task 子元素順序白名單＋生成期自檢），照 SKILL 流程走一次到位。

## 安裝

```
/plugin marketplace add abs1294/fulin-claude-plugins
/plugin install msproject-wbs@fulin-plugins
```

觸發詞：「WBS」「工作分解」「專案時程」「甘特圖」「MS Project 檔」「排一份 N 天 / N 人的開發計畫」。

## 前置依賴

- **Node.js** — 生成腳本 `generate-wbs.mjs` 用 node 執行。
- **PowerShell**（Windows）— 產出後的 XML 結構驗證用 PowerShell `[xml]` parser（SKILL 步驟 3；bash grep / 簡易正則驗不準 MSPDI）。非 Windows 環境可改用任何嚴格 XML parser 對照 SKILL 的檢查點。
- **MS Project**（使用者端）— 最終匯入驗收在收件人的 MS Project 做；本 plugin 只負責產出合規 XML。

## 用法

跟 Claude 說需求（模組、工項、工期、人力、依賴），它會照 `skills/msproject-wbs/SKILL.md` 的流程：填 `generate-wbs.mjs` 的「使用者輸入區」→ 跑腳本產出 XML → PowerShell 驗證元素順序與結構 → 交付。

## 結構

```
msproject-wbs/
├─ .claude-plugin/plugin.json
└─ skills/msproject-wbs/
    ├─ SKILL.md                  方法論＋七雷清單＋驗證步驟
    └─ scripts/generate-wbs.mjs  生成腳本（排程演算法＋MSPDI 框架＋順序自檢）
```
