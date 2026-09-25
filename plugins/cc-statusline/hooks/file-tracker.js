const fs = require('fs');
const os = require('os');
const path = require('path');
// Locked read -> reorder -> write (lib-state). The file holds an ARRAY, which
// lib-state's casMerge would reset to {}, so the lock is used directly. Parallel
// Edit/Write hooks racing unlocked would drop each other's file from the list.
const { atomicWrite, withFileLock } = require('./lib-state');
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);
    const fp = i.tool_input?.file_path;
    if (!fp) return;
    const sid = (i.session_id || 'default').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const file = path.join(os.tmpdir(), `claude-files-${sid}.json`);
    const name = path.basename(fp);
    withFileLock(file, () => {
      let files = [];
      try { files = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      if (!Array.isArray(files)) files = [];
      files = [name, ...files.filter(f => f !== name)].slice(0, 8);
      atomicWrite(file, JSON.stringify(files));
    });
  } catch (e) {}
});
