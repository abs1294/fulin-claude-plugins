'use strict';
// What the board does by itself for the plugins, so you do not have to go and press for it. Each part has a switch
// (the setting "auto"), and each thing done is written to a short log shown on the settings page.
//   cbm       a project's code index older than its last commit is made again (cbm-guard's own check and its own
//             rebuild command; cheap - about 9 s for 110K lines). Checked every 6 hours per project.        on by default
//   update    once a day, after the time set (default 09:00), every installed plugin of this marketplace is brought
//             up to date with plugin-manager's own tool; you are told which, since those projects' Claude Code
//             must be opened again to use the new version. Off by default: it changes every project's installed plugins
//             without the look-first-then-approve step of /plugin-manager-update.
//   harness   once a day, after 10:00, one project whose harness says it is due gets its health check: a conversation
//             on the board in that folder, its first message /harness:review. Off by default: one check uses about as
//             much as an hour of work (seen 2026-11-17 on one project: about 11 minutes, USD 3.96 at list price).
const DEFAULTS = { cbm: true, update: false, updateAt: '09:00', harness: false };
const LOG_MAX = 40;
const CBM_EVERY = 6 * 3600000;

const dayOf = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const minutesOf = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60; };

class Auto {
  // ops: settings() -> the "auto" setting; recall()/remember(st) -> the state kept between runs;
  //      cbmFolders() -> [folder]; cbmCheck(folder) -> {repos, fixes}; rebuild(fix) -> {ok, error?};
  //      update() -> {ok, summary, error?}; harnessDue() -> [{folder, name}]; startReview(folder) -> {ok, error?};
  //      tell(title, text)
  constructor(ops) { this.ops = ops; this.busy = false; }
  settings() { const v = this.ops.settings ? this.ops.settings() : {}; return Object.assign({}, DEFAULTS, v && typeof v === 'object' ? v : {}); }
  state() { const s = (this.ops.recall && this.ops.recall()) || {}; return { cbmAt: s.cbmAt || {}, updateDay: s.updateDay || '', harnessDay: s.harnessDay || '', log: Array.isArray(s.log) ? s.log : [] }; }
  log() { return this.state().log; }

  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    const cfg = this.settings(), st = this.state();
    const note = (kind, what, ok = true) => { st.log.unshift({ at: now, kind, what, ok }); st.log.length = Math.min(st.log.length, LOG_MAX); };
    const tell = (t, x) => { if (this.ops.tell) { try { this.ops.tell(t, x); } catch (e) {} } };
    try {
      // ── code index ──
      if (cfg.cbm && this.ops.cbmFolders) {
        for (const folder of this.ops.cbmFolders()) {
          if (now - (st.cbmAt[folder] || 0) < CBM_EVERY) continue;
          st.cbmAt[folder] = now;
          const r = await this.ops.cbmCheck(folder);
          const stale = (r && r.repos || []).filter((x) => x.state === 'stale');
          for (const x of stale) {
            const fix = (r.fixes || []).find((f) => f.includes('/' + x.repo + '"'));
            if (!fix) continue;
            const b = await this.ops.rebuild(fix);
            note('cbm', (b.ok ? '重建了 ' : '沒有重建成 ') + x.repo + ' 的程式碼索引（落後最新 commit ' + x.hours + ' 小時）' + (b.ok ? '' : '：' + (b.error || '')), b.ok);
          }
          if (stale.length && this.ops.forget) this.ops.forget(folder);   // the room shows it fresh again
        }
      }
      // ── plugin versions ──
      const today = dayOf(now);
      if (cfg.update && this.ops.update && st.updateDay !== today && minutesOf(now) >= hhmm(cfg.updateAt)) {
        st.updateDay = today;
        const r = await this.ops.update();
        const what = r.ok ? (r.summary || '都已是最新版') : '沒有更新成：' + (r.error || '').slice(0, 200);
        note('update', 'plugin 更新：' + what, r.ok);
        if (!r.ok || /更新|updated|→/.test(r.summary || '')) tell(r.ok ? 'plugin 已更新' : 'plugin 沒有更新成', what + (r.ok ? '。用到它們的專案，Claude Code 要重開才會用新版。' : ''));
      }
      // ── harness health check ──
      if (cfg.harness && this.ops.harnessDue && st.harnessDay !== today && minutesOf(now) >= 10 * 60) {
        const due = this.ops.harnessDue();
        if (due.length) {
          st.harnessDay = today;
          const p = due[0];
          const r = await this.ops.startReview(p.folder);
          note('harness', (r.ok ? '開始健檢 ' : '沒有開始健檢 ') + p.name + (r.ok ? '（看板裡的對話，有問題會停在那裡等你）' : '：' + (r.error || '')), r.ok);
          if (r.ok) tell('開始 harness 健檢：' + p.name, '在看板裡的一個對話跑，有問題要問你時會停在那裡。');
        }
      }
    } finally {
      if (this.ops.remember) this.ops.remember(st);
      this.busy = false;
    }
  }
}

module.exports = { Auto, DEFAULTS, dayOf, hhmm };
