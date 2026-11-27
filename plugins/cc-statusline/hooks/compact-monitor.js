const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked read -> increment -> write (lib-state): two PreCompact hooks racing on
// an unlocked read-modify-write would both read N and both write N+1.
const { casMerge, stateFile } = require('./lib-state');
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = stateFile(`claude-compacts-${sid}.json`);
    const stamp = Date.now();
    let target = null;
    // count: this conversation's own; what it carried over from the conversation it was copied from is
    // inherited, written by scripts/lib-compacts.js (the board shows count + inherited)
    casMerge(file, (state) => {
      state.v = 1;
      state.count = (Number(state.count) || 0) + 1;
      state.last = stamp;
      target = state.count;
    }, (after) => after.count === target && after.last === stamp);
  } catch (e) {}
});
