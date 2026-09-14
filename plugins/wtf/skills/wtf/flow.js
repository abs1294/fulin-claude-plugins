#!/usr/bin/env node
'use strict';
/**
 * flow.js — 照 wtf 的九條硬規則產 archify workflow 圖。
 *
 * 為什麼要這支腳本：
 * 九條規則寫在 SKILL.md 是「自律」——模型讀了會漏、會忘、會自己發明寫法。
 * 把規則寫進程式，模型只要餵一份簡單描述，規則就一定被套用。
 * 這不是 hook（不攔截任何東西），是一支「照規則幫你做完」的工具。
 *
 * 它自動處理的事（模型不必知道細節）：
 *   規則1 主線節點全放同一 lane、col 連號
 *   規則2 主線 edge 補 route:"straight" + fromSide:"right" + toSide:"left"
 *   規則3 全圖不寫 yOffset（撐高所有泳道的元凶）
 *   規則4 col 超過 5 直接報錯
 *   規則5 角色 lane 的線補 variant:"dashed" + role:"async"
 *   規則6 分岔節點與來源同 col
 *   規則7 例外 lane 排在主線 lane 正下方
 *   規則8 垂直線不給 route / fromSide / toSide
 *   規則9 垂直線自動量 via 座標——先 deliver 一次撈實際起點 x 與泳道間 y，填回去重跑
 * 另外：lane variant 只吃 normal|exception；schema 不准額外欄位。
 *
 * 用法：
 *   node flow.js spec.json out.html
 *
 * spec.json 的格式（比 archify 原生格式簡單很多）：
 * {
 *   "title": "圖的標題",
 *   "lanes": { "who": "參與者", "flow": "主線", "gate": "例外" },
 *   "phases": [ {"label":"階段一","from":0,"to":1} ],
 *   "main":  [ {"label":"按下 /wtf","sub":"或說看不懂","type":"frontend"} ],
 *   "side":  [ {"lane":"who","col":0,"label":"使用者","to":"main0","edgeLabel":"…"} ],
 *   "exits": [ {"lane":"gate","col":1,"label":"擋下","from":"main1","edgeLabel":"…"} ],
 *   "exceptionLanes": ["gate"]
 * }
 *   exceptionLanes = 哪幾條泳道要畫成「例外」（紅虛線框）。不給就預設所有 exits 的 lane。
 *                    ⚠ 只有真正的例外／失敗路徑才該標——archify 會在原框內再疊一層紅虛線框，
 *                      正常的分支去向（交付路徑、成功結局）標了會平白多一層紅框。
 *   main  = 主線，陣列順序就是 col 0..5
 *   side  = 旁邊的參與者（自動虛線連到主線）
 *   exits = 分岔（自動垂直落下，自動量 via）
 *
 * ⚠ 分岔節點放哪條泳道，判準是「它是被擋住了，還是走了另一條合法的路」：
 *     被擋住／失敗／不該發生        → 例外泳道（列進 exceptionLanes，畫紅虛線框）
 *     另一條合法的路／降級／豁免    → 自己一條泳道，不要列進 exceptionLanes
 *   兩者混在同一條泳道語意會相反——「豁免」被畫在「擋下與例外」框裡，
 *   讀起來就像它被擋下了。泳道標題也要跟著分清楚。
 *
 * ⚠ sublabel 不要寫長。archify 的可讀性檢查是
 *     projectedFontPx = sourceFontPx × min(1, 930 / viewBoxWidth)，下限 6px
 *     （renderers/shared/desktop-readability.mjs）。sublabel 的 font-size 是 7.5，
 *   所以整張圖的 viewBox 寬度上限約 1162px。主線 6 個節點時 viewBox 很容易超過，
 *   這時任何一句長 sublabel 都會讓 validate 回 "Final artifact check failed"。
 *   實務上 sublabel 控制在 10 個全形字內。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_COL = 5;
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const ARCHIFY_CANDIDATES = [
  path.join(HOME, '.claude', 'skills', 'archify', 'bin', 'archify.mjs'),
  path.join(HOME, '.agents', 'skills', 'archify', 'bin', 'archify.mjs'),
];

function die(msg) {
  process.stderr.write('[flow] ' + msg + '\n');
  process.exit(1);
}

function findArchify() {
  for (const p of ARCHIFY_CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    try {
      execFileSync('node', [p, 'doctor'], { stdio: 'ignore' });
      return p;
    } catch (e) { /* doctor 非 0，換下一個 */ }
  }
  return null;
}

function run(archify, args) {
  try {
    const out = execFileSync('node', [archify, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), status: e.status };
  }
}

// ── 把簡單描述編成 archify 的 workflow JSON ─────────────────────────
function compile(spec, viaMap) {
  const laneIds = Object.keys(spec.lanes || {});
  if (!laneIds.length) die('spec.lanes 不能是空的');
  if (!Array.isArray(spec.main) || !spec.main.length) die('spec.main 不能是空的');
  if (spec.main.length > MAX_COL + 1) {
    die('主線最多 ' + (MAX_COL + 1) + ' 個節點（col 0..' + MAX_COL + '），目前 '
      + spec.main.length + ' 個。拆成兩張圖，或把次要步驟寫進 sub。');
  }

  const mainLane = spec.mainLane || (laneIds.includes('flow') ? 'flow' : laneIds[0]);
  const exitLanes = [...new Set((spec.exits || []).map((e) => e.lane))];
  const sideLanes = [...new Set((spec.side || []).map((e) => e.lane))];

  // 規則7：參與者 → 主線 → 例外 → 其餘。例外緊貼主線下方。
  const ordered = [
    ...sideLanes.filter((l) => l !== mainLane),
    mainLane,
    ...exitLanes.filter((l) => l !== mainLane && !sideLanes.includes(l)),
    ...laneIds.filter((l) => l !== mainLane && !sideLanes.includes(l) && !exitLanes.includes(l)),
  ];

  // 哪幾條泳道要標成「例外」由 spec.exceptionLanes 指定，不是「有 exits 指過來就算」。
  // archify 對 variant:"exception" 的畫法是在原泳道框內縮 6px 再疊一個紅虛線框
  // （workflow-compiler.mjs:4159），所以標錯的泳道會平白多一層紅框。
  // 正常的分支去向（例如「留在終端機／交給 archify」這種交付路徑）不是例外，別標。
  const exceptionLanes = Array.isArray(spec.exceptionLanes) ? spec.exceptionLanes : exitLanes;
  const lanes = ordered.map((id) => {
    const lane = { id: id, label: spec.lanes[id] };
    if (exceptionLanes.includes(id)) lane.variant = 'exception';  // 只吃 normal|exception
    return lane;
  });

  const nodes = [];
  const edges = [];
  const W = spec.nodeWidth || 132;

  // 主線：規則1、規則3（不寫 yOffset）
  spec.main.forEach((n, i) => {
    const node = {
      id: 'main' + i, lane: mainLane, col: i,
      type: n.type || 'backend',
      label: n.label,
      width: n.width || W,
    };
    if (n.sub) node.sublabel = n.sub;
    nodes.push(node);
  });

  // 規則2：主線 edge 三件套
  for (let i = 0; i + 1 < spec.main.length; i++) {
    const e = {
      id: 'm' + i, from: 'main' + i, to: 'main' + (i + 1),
      variant: 'emphasis', route: 'straight', fromSide: 'right', toSide: 'left',
    };
    const lbl = spec.main[i + 1].edgeLabel || spec.main[i].nextLabel;
    if (lbl) e.label = lbl;
    edges.push(e);
  }

  // 參與者：規則5
  (spec.side || []).forEach((n, i) => {
    if (n.col > MAX_COL) die('side[' + i + '] 的 col=' + n.col + ' 超過上限 ' + MAX_COL);
    const id = 'side' + i;
    const node = {
      id: id, lane: n.lane, col: n.col, type: n.type || 'external',
      label: n.label, width: n.width || (W - 10),
    };
    if (n.sub) node.sublabel = n.sub;
    nodes.push(node);
    const eid = 't' + i;
    const e = {
      id: eid,
      from: n.reverse ? n.to : id,
      to: n.reverse ? id : n.to,
      variant: 'dashed', role: 'async',
    };
    if (n.edgeLabel) e.label = n.edgeLabel;
    if (viaMap && viaMap[eid]) e.via = [viaMap[eid]];   // 規則9 也適用參與者線
    edges.push(e);
  });

  // 例外：規則6、規則8（不給 route/fromSide/toSide）、規則9（via）
  (spec.exits || []).forEach((n, i) => {
    if (n.col > MAX_COL) die('exits[' + i + '] 的 col=' + n.col + ' 超過上限 ' + MAX_COL);
    const id = 'exit' + i;
    const node = {
      id: id, lane: n.lane, col: n.col, type: n.type || 'security',
      label: n.label, width: n.width || (W + 8),
    };
    if (n.sub) node.sublabel = n.sub;
    nodes.push(node);
    const eid = 'x' + i;
    const e = {
      id: eid, from: n.from, to: id,
      variant: n.variant || 'security', role: n.role || 'error',
    };
    if (n.edgeLabel) e.label = n.edgeLabel;
    if (viaMap && viaMap[eid]) e.via = [viaMap[eid]];
    edges.push(e);
  });

  const doc = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: { title: spec.title || '流程圖', quality_profile: 'showcase' },
    lanes: lanes,
    mainPath: spec.main.map((_, i) => 'main' + i),
    nodes: nodes,
    edges: edges,
  };
  if (spec.phases) {
    doc.phases = spec.phases.map((p, i) => {
      const ph = { id: 'p' + i, label: p.label, fromCol: p.from, toCol: p.to };
      if (p.variant) ph.variant = p.variant;
      return ph;
    });
  }
  return doc;
}

// ── 規則9：掃出「所有」跨泳道的線，算各自該用的 via 座標 ────────────
// 不分線的類別（主線／參與者／例外）——判準只有一個：
// 這條線的兩個端點是不是落在不同泳道。是就該垂直落下，不管它是誰連誰。
function measureVia(htmlPath, skipIds) {
  const src = fs.readFileSync(htmlPath, 'utf8');

  // 泳道範圍
  const lanes = [];
  const laneRe = /data-composition-frame-id="lane-(\d+)"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g;
  let lm;
  while ((lm = laneRe.exec(src))) {
    lanes[Number(lm[1])] = { y: Number(lm[2]), h: Number(lm[3]) };
  }
  const laneOf = (y) => {
    for (let i = 0; i < lanes.length; i++) {
      if (!lanes[i]) continue;
      if (y >= lanes[i].y - 1 && y <= lanes[i].y + lanes[i].h + 1) return i;
    }
    return -1;
  };

  // 掃全部 edge：id 從 data-edge-id / data-relationship-id 取
  const via = {};
  const viaAlt = {};
  const viaSpread = {};
  const meta = {};
  const edgeRe = /data-(?:edge|relationship)-id="([^"]+)"/g;
  const seen = new Set();
  let em;
  while ((em = edgeRe.exec(src))) {
    const eid = em[1];
    if (seen.has(eid)) continue;
    seen.add(eid);
    if (skipIds && skipIds.has(eid)) continue;      // 主線是左右向，不要動

    const dm = /d="(M[^"]*)"/.exec(src.slice(em.index, em.index + 1200));
    if (!dm) continue;
    const d = dm[1];
    const pts = [...d.matchAll(/([\d.]+)\s+([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    if (pts.length < 2) continue;

    const [sx, sy] = pts[0];
    const [ex, ey] = pts[pts.length - 1];
    const fromLane = laneOf(sy);
    const toLane = laneOf(ey);
    if (fromLane < 0 || toLane < 0 || fromLane === toLane) continue;   // 同泳道不處理

    // 已經是垂直線就不用動
    if (Math.abs(sx - ex) < 0.5) continue;

    // via 的 y：取落在兩端點之間的那道泳道間隙中線
    const loY = Math.min(sy, ey);
    const hiY = Math.max(sy, ey);
    let y = null;
    for (let i = 0; i + 1 < lanes.length; i++) {
      if (!lanes[i] || !lanes[i + 1]) continue;
      const mid = Math.round(((lanes[i].y + lanes[i].h) + lanes[i + 1].y) / 2);
      if (mid > loY && mid < hiY) { y = mid; break; }
    }
    if (y === null) continue;
    // 兩個候選 x：起點與終點。哪個能成立由後面逐條 validate 決定。
    via[eid] = [sx, y];
    viaAlt[eid] = [ex, y];
    // 記錄這條線掛在哪個節點、往哪個方向，供後面分散用
    meta[eid] = { sx: sx, ex: ex, y: y, down: ey > sy, anchorY: sy };
  }

  // ── 同一個節點往同方向出多條線時，沿節點寬度分散 ──────────────────
  // 一個節點出多條垂直線時，archify 為了不讓它們重疊會強制錯開出線位置。
  // 此時給每條相同的 via x 一定違反正交約束，所以各給各的 x：沿節點寬度均分。
  //
  // ⚠ 已知限制（實測）：當 archify 把某條線安排成「從節點側緣出線」
  //   （起點 x = 節點左/右緣而非中心）時，via 救不了——不論給一個點、
  //   兩個點、還是分散後的 x，都會回
  //   "has explicit geometry that violates orthogonal route segments"，
  //   因為從側緣往下拉必然產生斜段。這種線維持自動路由（S 形），
  //   腳本會在 stderr 列出是哪幾條。
  //   ⚠ 把線改掛到別的節點「不是」解法——實測把其中一條從 main5 移到 main4 後，
  //     main4 變成出兩條線，換成它那條也失敗，總數反而從 5 降到 4。
  //     目前沒有可靠的根治法；接受剩下幾條走 S 形即可，它們仍標著 label、
  //     指向正確節點，不影響讀懂。
  // 先把所有節點框掃出來（排除泳道框與小圖示），供反查「這條線掛在哪個節點」
  const nodeRects = [];
  {
    const rectRe = /<rect[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>/g;
    let rm;
    while ((rm = rectRe.exec(src))) {
      const x = Number(rm[1]), y = Number(rm[2]), w = Number(rm[3]), h = Number(rm[4]);
      if (w > 200 || w < 40 || h > 90 || h < 20) continue;   // 節點框的尺寸範圍
      nodeRects.push({ x: x, y: y, w: w, h: h, cx: x + w / 2 });
    }
  }
  const nodeAt = (px, py) => {
    for (const r of nodeRects) {
      if (px >= r.x - 2 && px <= r.x + r.w + 2 && py >= r.y - 2 && py <= r.y + r.h + 2) return r;
    }
    return null;
  };

  // 分組：key = 起點所在「節點」+ 方向。archify 可能已把同節點的多條線
  // 從不同 x 出線（中心、右緣…），所以不能用起點 x 當 key——要用節點。
  const groups = new Map();
  for (const eid of Object.keys(meta)) {
    const m = meta[eid];
    const anchor = nodeAt(m.sx, m.anchorY);
    if (!anchor) continue;
    m.anchor = anchor;
    const key = Math.round(anchor.cx) + '|' + Math.round(anchor.y) + '|' + (m.down ? 'd' : 'u');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(eid);
  }
  for (const [, eids] of groups) {
    if (eids.length < 2) continue;
    const anchor = meta[eids[0]].anchor;
    if (!anchor) continue;
    const cx = anchor.cx;
    const w = anchor.w;
    // 均分：N 條線放在 N+1 等分點上，避開最邊緣
    const usable = w - 24;                                // 兩側各留 12px
    eids.forEach((eid, i) => {
      const offset = usable * ((i + 1) / (eids.length + 1) - 0.5);
      viaSpread[eid] = [Math.round((cx + offset) * 10) / 10, meta[eid].y];
    });
  }

  return { primary: via, alt: viaAlt, spread: viaSpread };
}

// ── 主流程 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const specPath = argv[0];
const outPath = argv[1];
if (!specPath || !outPath) die('用法：node flow.js spec.json out.html');
if (!fs.existsSync(specPath)) die('找不到 spec：' + specPath);

const archify = findArchify();
if (!archify) {
  die('archify 驗活失敗（跑過 doctor，exit 非 0 或找不到）。\n'
    + '       它是產架構圖／流程圖的第三方工具（tt-a1i/archify，MIT、免費）。\n'
    + '       要裝請先問過使用者，指令：npx skills add tt-a1i/archify -g\n'
    + '       不准自己裝——那會連網抓套件並寫進他的家目錄。');
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
} catch (e) {
  die('spec 不是合法 JSON：' + e.message);
}

const outDir = path.dirname(path.resolve(outPath));
const base = path.basename(outPath).replace(/\.html?$/i, '');
const jsonPath = path.join(outDir, base + '.archify.json');

function writeAndValidate(doc) {
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 1), 'utf8');
  const v = run(archify, ['validate', 'workflow', jsonPath, '--quality', 'showcase', '--json']);
  if (v.ok) return true;
  let msg = v.out;
  try {
    const j = JSON.parse(v.out);
    msg = j.error || v.out;
    for (const d of (j.diagnostics || [])) {
      // evidence 常常是唯一「可行動」的資訊——desktop-readability 失敗時
      // j.error 只說 "Final artifact check failed."，但 evidence.text 直接寫著
      // 是哪一句字太小、差幾 px。不帶出來的話使用者只能一輪一輪猜。
      const ev = d.evidence || {};
      if (ev.text) {
        msg += '\n       問題出在這句：「' + ev.text + '」';
      }
      if (ev.projectedFontPx && ev.minimumProjectedFontPx) {
        msg += '\n       字級投影後 ' + Number(ev.projectedFontPx).toFixed(2)
             + 'px，最低要 ' + ev.minimumProjectedFontPx + 'px';
      }
      if (ev.viewBoxWidth) {
        msg += '\n       整張圖 viewBox 寬 ' + ev.viewBoxWidth + 'px（可用 '
             + (ev.availableDiagramWidth || 930) + 'px，縮放 '
             + (ev.scale ? Number(ev.scale).toFixed(2) : '?') + '）'
             + '\n       這是全域耦合：縮短「任何」節點的字都能救，不必只改上面那句';
      }
      if (d.supportedFixes && d.supportedFixes.length) {
        msg += '\n       fix: ' + d.supportedFixes.join(' / ');
      }
    }
  } catch (e) { /* 用原文 */ }
  return msg;
}

// 第一趟：不帶 via，量座標
let doc = compile(spec, null);
let vr = writeAndValidate(doc);
if (vr !== true) die('validate 失敗：\n       ' + vr);

let d1 = run(archify, ['deliver', 'workflow', jsonPath, outPath, '--quality', 'showcase', '--json']);
if (!d1.ok) die('deliver 失敗（exit ' + d1.status + '）：\n' + String(d1.out).slice(0, 600));

// 垂直線：不分類別，掃 HTML 裡所有「兩端在不同泳道」的線。
// 主線（m*）是左右向的，跳過。
const mainEdgeIds = new Set(spec.main.map((_, i) => 'm' + i));
let viaCount = 0;
{
  const measured = measureVia(outPath, mainEdgeIds);
  const viaMap = measured.primary;
  const viaAlt = measured.alt;
  const viaSpread = measured.spread;
  const n = Object.keys(viaMap).length;
  if (n) {
    // 逐條試：某條 via 算不出合法幾何（跨兩層泳道、出線方向不同等）時，只丟掉那一條，
    // 其餘照樣走直線——不要因為一條失敗就整張圖退回 S 形。
    const accepted = {};
    const rejected = [];
    for (const eid of Object.keys(viaMap)) {
      let done = false;
      // 候選順序：起點 x → 終點 x → 分散後的 x（同節點多線時才有）
      for (const cand of [viaMap[eid], viaAlt[eid], viaSpread[eid]]) {
        if (!cand) continue;
        const trial = Object.assign({}, accepted);
        trial[eid] = cand;
        if (writeAndValidate(compile(spec, trial)) === true) {
          accepted[eid] = cand;
          done = true;
          break;
        }
      }
      if (!done) rejected.push(eid);
    }
    viaCount = Object.keys(accepted).length;
    const vrf = writeAndValidate(compile(spec, viaCount ? accepted : null));
    if (vrf !== true) die('最終 validate 失敗：\n       ' + vrf);
    const d2 = run(archify, ['deliver', 'workflow', jsonPath, outPath, '--quality', 'showcase', '--json']);
    if (!d2.ok) die('第二趟 deliver 失敗（exit ' + d2.status + '）：\n' + String(d2.out).slice(0, 600));
    if (rejected.length) {
      process.stderr.write('[flow] 這幾條算不出合法垂直路徑，維持自動路由（S 形）：'
        + rejected.join(', ') + '\n'
        + '       這是已知限制，不必處理——線仍標著 label、指向正確節點，不影響讀懂。\n'
        + '       成因：archify 為了讓同一節點的多條線不重疊，會安排某些線從節點側緣出線，\n'
        + '       從側緣往下拉必然有斜段，via 給任何 x 都會違反正交約束。\n'
        + '       把線改掛到別的節點不是解法（實測反而更糟）。\n');
    }
  }
}

// visual-check：真 Chrome 量測，證明頁面能開能讀
const vc = run(archify, ['visual-check', outPath, '--json']);

// 自我量測回報
const html = fs.readFileSync(outPath, 'utf8');
const laneHs = [...html.matchAll(/data-composition-frame-id="lane-\d+"[^>]*height="([\d.]+)"/g)]
  .map((m) => Number(m[1]));
const allPaths = [...html.matchAll(/d="(M[^"]*L[^"]*)"/g)].map((m) => m[1]);
const straight = allPaths.filter((d) => d.split(' L ').length === 2).length;

process.stdout.write(
  '[flow] 產出：' + outPath + '\n'
  + '       泳道高度：' + [...new Set(laneHs)].join(', ') + 'px（104 = archify 下限，無虛高）\n'
  + '       一段直線：' + straight + ' 條 / 共 ' + allPaths.length + ' 條\n'
  + '       垂直線套用 via：' + viaCount + ' 條\n'
  + '       visual-check：' + (vc.ok ? 'exit 0（頁面能開能讀）' : 'exit 非 0') + '\n'
  + '       中繼 JSON：' + jsonPath + '\n'
);
if (!vc.ok) process.exit(1);
