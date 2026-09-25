const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked read -> increment -> write (lib-state): two PreCompact hooks racing on
// an unlocked read-modify-write would both read N and both write N+1.
const { casMerge } = require('./lib-state');
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = path.join(os.tmpdir(), `claude-compacts-${sid}.json`);
    const stamp = Date.now();
    let target = null;
    casMerge(file, (state) => {
      state.count = (Number(state.count) || 0) + 1;
      state.last = stamp;
      target = state.count;
    }, (after) => after.count === target && after.last === stamp);
  } catch (e) {}
});
