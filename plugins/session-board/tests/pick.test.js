'use strict';
// The board's own pop-ups in place of the browser's (public/index.html, the part marked <pick>): a choice list, a date,
// a time and suggestions, pressed, typed into and touched in a real browser - headless Chromium, no window opened.
// Needs Playwright with its Chromium (here: installed globally); where there is none, said as skipped, not passed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function playwright() {
  try { return require('playwright'); } catch (e) {}
  try { const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim(); return require(path.join(root, 'playwright')); } catch (e) { return null; }
}
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const part = /\/\/ <pick>[^\n]*\n([\s\S]*?)\/\/ <\/pick>/.exec(page);

const HTML = `<!doctype html><meta charset="utf-8"><style>.pickbox{position:fixed}.pick-time .pt-col{height:220px;overflow-y:auto}</style>
<body style="margin:40px">
<select id="e"><option value="0" disabled>Zero</option><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option><option value="h">Chili</option><option value="ny">New York</option><option value="nd">New Delhi</option></select>
<select id="s"><option value="a">甲</option><option value="b">乙</option><option value="c" disabled>丙</option><option value="d">丁</option></select>
<input id="d" type="date" value="2027-02-10"> <input id="t" type="time" value="09:00"> <input id="n" type="number">
<input id="f" type="text" list="dl"><datalist id="dl"><option value="C:\\work\\alpha"><option value="C:\\work\\beta"><option value="D:\\gamma"></datalist>
<p style="height:2000px"></p>
<script>
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
window.changes = 0; document.getElementById('s').addEventListener('change', () => window.changes++);
</script></body>`;

test('the board\'s own pop-ups: a choice list, a date, a time and suggestions, by mouse, keys, typing and touch', async (t) => {
  assert.ok(part, 'the page marks the part this test runs');
  const pw = playwright();
  if (!pw) { t.skip('這台電腦沒有 Playwright，選單面板的瀏覽器測試沒跑'); return; }
  // its own Chromium, else this computer's Chrome or Edge (Playwright's download may be of another version) - headless
  let browser, why = '';
  for (const o of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await pw.chromium.launch(Object.assign({ headless: true }, o)); break; } catch (e) { why = String(e.message || e).split('\n')[0]; }
  }
  if (!browser) { t.skip('開不起瀏覽器（Playwright 的 Chromium、Chrome、Edge 都試過）：' + why); return; }
  try {
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 700 } });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
    await p.setContent(HTML);
    await p.addScriptTag({ content: part[1] });
    const val = (id) => p.$eval('#' + id, (x) => x.value);
    const open = () => p.locator('.pickbox').count();

    // made the board's: the same values, the browser's list gone; and a field made later too
    assert.deepStrictEqual(await p.evaluate(() => ['d', 't', 'f'].map((id) => { const x = document.getElementById(id); return [x.type, x.dataset.pick || x.dataset.sugg || '', x.value, x.hasAttribute('list')]; })),
      [['text', 'date', '2027-02-10', false], ['text', 'time', '09:00', false], ['text', 'dl', '', false]]);
    await p.evaluate(() => { const i = document.createElement('input'); i.type = 'time'; i.value = '18:15'; i.id = 'later'; document.body.prepend(i); });
    await p.waitForFunction(() => document.getElementById('later').dataset.pick === 'time');
    assert.strictEqual(await val('later'), '18:15');

    // a choice list: pressed, its rows; a row clicked: chosen, told, closed, the focus back on it
    await p.click('#s');
    assert.deepStrictEqual(await p.locator('.pick-list .pick-opt').allTextContents(), ['甲', '乙', '丙', '丁']);
    await p.locator('.pick-opt', { hasText: '丁' }).click();
    assert.deepStrictEqual([await val('s'), await p.evaluate(() => window.changes), await open(), await p.evaluate(() => document.activeElement.id)], ['d', 1, 0, 's']);
    // by the keys: up past the one that cannot be chosen, Enter
    await p.keyboard.press('ArrowUp'); assert.strictEqual(await open(), 1, 'the arrows open it');
    await p.keyboard.press('ArrowUp'); await p.keyboard.press('Enter');
    assert.deepStrictEqual([await val('s'), await p.evaluate(() => window.changes)], ['b', 2], '丙 cannot be chosen: skipped');
    // the pointer over a row lights it only: Enter takes the one the arrows are on
    await p.keyboard.press('ArrowDown'); await p.locator('.pick-opt', { hasText: '丁' }).hover(); await p.keyboard.press('Enter');
    assert.strictEqual(await val('s'), 'b', 'not the row the pointer passed over');
    // Escape and a press elsewhere close it
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Escape'); assert.strictEqual(await open(), 0);
    await p.click('#s'); await p.mouse.click(5, 650); assert.strictEqual(await open(), 0);

    // as the browser's list: a letter goes to the row starting with it, Space chooses, Home skips the one that cannot
    // be chosen; the browser's own jump does not change the value behind the list (review 2026-11-20)
    await p.focus('#e'); await p.keyboard.press('ArrowDown');
    // (the first row cannot be chosen: the browser starts on Apple)
    await p.keyboard.press('c'); assert.deepStrictEqual([await val('e'), await p.locator('.pick-opt.at').textContent()], ['a', 'Cherry'], 'only the row marked: nothing chosen yet');
    await p.waitForTimeout(800);   // (a space right after a letter is part of a name being typed, below)
    await p.keyboard.press('Space'); assert.deepStrictEqual([await val('e'), await open()], ['c', 0]);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Home'); await p.keyboard.press('Enter');
    assert.strictEqual(await val('e'), 'a', 'Home: the first that can be chosen');
    // Alt+arrow closes it, the value as it was (review 2026-11-20: it moved the marked row instead); F4 too; and a date's
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Alt+ArrowDown');
    assert.deepStrictEqual([await open(), await val('e')], [0, 'a']);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Alt+ArrowUp'); assert.strictEqual(await open(), 0);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('F4'); assert.strictEqual(await open(), 0);
    // letters typed together add up: "chi" is Chili, not the next row with a c; a lone c later goes on to the next
    await p.keyboard.press('ArrowDown'); await p.keyboard.type('chi');
    assert.strictEqual(await p.locator('.pick-opt.at').textContent(), 'Chili');
    await p.waitForTimeout(800); await p.keyboard.press('c');
    assert.strictEqual(await p.locator('.pick-opt.at').textContent(), 'Cherry', 'a while later: a new word, the next row with a c');
    await p.keyboard.press('Escape');
    // the same letter again: round the rows starting with it - from Apple, c is Cherry, c again Chili (review 2026-11-20)
    await p.keyboard.press('ArrowDown'); await p.keyboard.type('cc');
    assert.strictEqual(await p.locator('.pick-opt.at').textContent(), 'Chili');
    await p.keyboard.press('Escape'); await p.waitForTimeout(800);
    // a space in the middle of typing a name is part of it, not "choose" (review 2026-11-20: "new d" chose New York)
    await p.keyboard.press('ArrowDown'); await p.keyboard.type('new d');
    assert.deepStrictEqual([await open(), await p.locator('.pick-opt.at').textContent()], [1, 'New Delhi']);
    await p.keyboard.press('Enter'); assert.strictEqual(await val('e'), 'nd');

    // a date: its month, a day picked; the arrows; typed while it is open - what is typed stays
    await p.click('#d');
    assert.strictEqual(await p.locator('.pd-head b').textContent(), '2027 年 2 月');
    await p.locator('.pd-d', { hasText: /^15$/ }).click();
    assert.deepStrictEqual([await val('d'), await open()], ['2027-02-15', 0]);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter');
    assert.strictEqual(await val('d'), '2027-02-16');
    await p.keyboard.press('F4'); assert.strictEqual(await open(), 1, 'F4 opens a date as well');
    await p.keyboard.press('F4'); assert.strictEqual(await open(), 0, '... and closes it (review 2026-11-20)');
    await p.click('#d'); assert.strictEqual(await open(), 1);
    await p.fill('#d', ''); await p.type('#d', '2027-03-04');
    assert.strictEqual(await open(), 0, 'typing closes it');
    await p.keyboard.press('Enter');
    assert.strictEqual(await val('d'), '2027-03-04', 'Enter keeps what was typed (review 2026-11-20)');

    // a phone's keyboard coming up (the window only shorter): still open; narrower: closed
    await p.click('#d'); await p.setViewportSize({ width: 900, height: 400 }); await p.waitForTimeout(100);
    assert.strictEqual(await open(), 1, 'only shorter: kept open');
    await p.setViewportSize({ width: 700, height: 400 }); await p.waitForTimeout(100);
    assert.strictEqual(await open(), 0, 'narrower: closed');
    await p.setViewportSize({ width: 900, height: 700 });
    // typed on a phone as the hint says: a keyboard with "-" and ":"
    assert.deepStrictEqual(await p.evaluate(() => ['d', 't'].map((id) => document.getElementById(id).inputMode)), ['', '']);

    // a time: an hour and a minute; typed while open - what is typed stays
    await p.click('#t');
    await p.locator('.pick-time .pt-col').first().getByText('07', { exact: true }).click();
    await p.locator('.pick-time .pt-col').nth(1).getByText('45', { exact: true }).click();
    assert.deepStrictEqual([await val('t'), await open()], ['07:45', 0]);
    await p.click('#t'); await p.fill('#t', ''); await p.type('#t', '14:30'); await p.keyboard.press('Enter');
    assert.strictEqual(await val('t'), '14:30', 'Enter keeps what was typed (review 2026-11-20)');

    // suggestions: the ones containing what is typed, picked with the keys
    await p.click('#f'); await p.type('#f', 'work');
    assert.deepStrictEqual(await p.locator('.pick-sugg .pick-opt').allTextContents(), ['C:\\work\\alpha', 'C:\\work\\beta']);
    // an input method choosing a word: its arrows are not taken
    await p.evaluate(() => document.getElementById('f').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })));
    assert.strictEqual(await p.locator('.pick-sugg .pick-opt.at').count(), 0);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
    assert.deepStrictEqual([await val('f'), await open()], ['C:\\work\\beta', 0]);

    // a touch: the browser's own list stopped on the tap, the board's opened
    await p.evaluate(() => { window.tapStopped = null; window.addEventListener('touchend', (e) => { window.tapStopped = e.defaultPrevented; }); });
    await p.tap('#s');
    assert.deepStrictEqual([await p.evaluate(() => window.tapStopped), await open()], [true, 1]);
    await p.locator('.pick-opt', { hasText: '甲' }).tap();
    assert.deepStrictEqual([await val('s'), await open()], ['a', 0]);

    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); }
});
