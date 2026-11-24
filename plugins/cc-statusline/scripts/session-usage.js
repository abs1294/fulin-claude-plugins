#!/usr/bin/env node
// Brings one conversation's figures up to date (lib-session-usage.js) without a
// status line. kick() is what the hooks call: it returns at once, the reading
// is done by a process of its own (nobody waits for it). Also brings the usage
// records up to date (lib-records.js) and starts the adding-up behind (all) and
// the usage detail when that one is due: where no terminal is open, no status
// line does.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const SETTLE_MS = 1500;   // the last lines of a reply are written as the hook runs

function kick(input) {
  try {
    if (!input || !input.session_id || typeof input.transcript_path !== 'string' || !input.transcript_path) return false;
    spawn(process.execPath, [__filename, '--update', String(input.session_id), input.transcript_path], { detached: true, stdio: 'ignore', windowsHide: true, cwd: require('os').homedir() }).on('error', () => {}).unref();
    return true;
  } catch (e) { return false; }
}

function run(sid, transcript) {
  const { atomicWrite, stateFile } = require('../hooks/lib-state');
  const priceLib = require('./lib-price');
  const { table, sig, cache } = priceLib.loadTable();
  const key = sid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  if (!key) return null;
  const r = require('./lib-session-usage').update({ transcript, file: stateFile('claude-toksum2-' + key + '.json'), resolvePrice: priceLib.makeResolver(table), priceSig: sig, write: atomicWrite });
  if (r) priceLib.requestLookup(r.missing, cache);
  return r;
}

if (require.main === module && process.argv[2] === '--update') {
  setTimeout(() => {
    try { run(String(process.argv[3] || ''), String(process.argv[4] || '')); } catch (e) {}
    try { let r = null; for (let n = 0; n < 15 && r === null; n++) { if (n) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); r = require('./lib-records').collect({ transcript: path.resolve(String(process.argv[4] || '')) }); } if (r && r.missing.length) { const pl = require('./lib-price'); pl.requestLookup(r.missing, pl.readCache()); } } catch (e) {}
    try { if (!process.env.CC_STATUSLINE_NO_ALL) spawn(process.execPath, [path.join(__dirname, 'all-usage-refresh.js')], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch (e) {}
  }, Number(process.env.CC_STATUSLINE_SETTLE_MS) || SETTLE_MS);
}

module.exports = { kick, run };
