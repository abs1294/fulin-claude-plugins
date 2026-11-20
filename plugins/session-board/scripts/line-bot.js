#!/usr/bin/env node
'use strict';
// The LINE secretary on its own (lib/line.js), for when the board was started before it existed. Normally the board
// starts it itself when ~/.claude/session-board/line.json is filled in. Talks to the board on its port with its key.
const path = require('path');
const fs = require('fs');
const L = require('../lib/line');
const DATA = path.join(require('os').homedir(), '.claude', 'session-board');
const key = fs.readFileSync(path.join(DATA, 'token'), 'utf8').trim();
const s = L.start({ boardPort: 4317, boardKey: key, log: (x) => console.log(new Date().toISOString(), x) });
if (!s) { console.error('line.json 沒有填完（要 channelSecret、channelToken；userId 可以之後用 line-setup.js claim 綁定）：' + L.CONF); process.exit(1); }
