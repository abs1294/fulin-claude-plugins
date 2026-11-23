#!/usr/bin/env node
'use strict';
// node said-scan.js <db file> <projects dir>: what you said in every conversation, put where a search finds it (lib/saidindex.js)
const r = require('../lib/saidindex').scan(process.argv[2], process.argv[3]);
process.stdout.write(JSON.stringify(r) + '\n');
