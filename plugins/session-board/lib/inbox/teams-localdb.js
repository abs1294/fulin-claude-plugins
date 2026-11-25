'use strict';
// Reads messages out of the Teams desktop app's local cache (personal account,
// teams.live.com). A personal Teams account has no API at all; this cache is
// the only place its messages can be read from. Ported from customer-hub
// (src/teams-localdb.js), with the two packages it used replaced by lib/inbox/text.js.
//
// Safety: the cache is a LevelDB that Teams itself has open. Opening it as a
// database, even read-only, can trigger a compaction that damages it. So the
// files are only ever COPIED to a temporary folder and parsed by hand there;
// nothing in the original folder is opened for writing.
//
// Layers: LevelDB table file (footer -> index -> data blocks, Snappy-packed)
//   -> the blocks hold IndexedDB records whose values are V8-serialized objects
//   -> the message fields are picked out of those by key name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { htmlToText, snappyUncompress } = require('./text');

function defaultLevelDbDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams',
    'EBWebView', 'WV2Profile_tfl', 'IndexedDB', 'https_teams.live.com_0.indexeddb.leveldb');
}

function available(dir = defaultLevelDbDir()) {
  try { return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.ldb')); } catch (e) { return false; }
}

function readVarint(buf, pos) {
  let r = 0, s = 0, p = pos;
  for (;;) { const b = buf[p++]; if (b === undefined) break; r |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; if (s > 35) break; }
  return [r >>> 0, p];
}
function decompressBlock(buf, off, size) {
  const type = buf[off + size];   // the byte after a block: 0 = stored, 1 = Snappy
  const raw = buf.subarray(off, off + size);
  return type === 1 ? snappyUncompress(raw) : raw;
}
function readSSTableBlocks(buf) {
  if (buf.length < 48) return [];
  const footer = buf.subarray(buf.length - 48);
  let fp = 0, skip, idxOff, idxSize;
  [skip, fp] = readVarint(footer, 0); [skip, fp] = readVarint(footer, fp);
  [idxOff, fp] = readVarint(footer, fp); [idxSize, fp] = readVarint(footer, fp);
  let idx;
  try { idx = decompressBlock(buf, idxOff, idxSize); } catch (e) { return []; }
  const handles = [];
  let pos = 0;
  while (pos < idx.length - 8) {
    let sh, ns, vl, np = pos;
    [sh, np] = readVarint(idx, np); [ns, np] = readVarint(idx, np); [vl, np] = readVarint(idx, np);
    if (ns > 1000 || vl > 20 || vl < 2) { pos++; continue; }
    np += ns;
    let bo, bs, vp = np;
    [bo, vp] = readVarint(idx, vp); [bs, vp] = readVarint(idx, vp);
    if (bo < buf.length && bs > 0 && bs < buf.length) handles.push([bo, bs]);
    pos = np + vl;
  }
  const blocks = [];
  for (const [off, size] of handles) { try { blocks.push(decompressBlock(buf, off, size)); } catch (e) {} }
  return blocks;
}

// V8 serialization, as far as it is needed: a string is '"' + length + one
// byte per character (Latin-1) or 'c' + length + UTF-16LE bytes; a number is
// 'N' + 8-byte double. Latin-1, not UTF-8: read as UTF-8, a non-breaking space
// (byte A0) in an otherwise plain message came out as a broken character
// (seen 2026-11-13 in 6 of 661 messages; customer-hub read these as UTF-8).
function tryReadV8String(block, pos) {
  const tag = block[pos];
  if (tag !== 0x22 && tag !== 0x63) return null;
  const [len, p] = readVarint(block, pos + 1);
  if (len <= 0 || len > 400000 || p + len > block.length) return null;
  return { str: block.subarray(p, p + len).toString(tag === 0x63 ? 'utf16le' : 'latin1'), end: p + len };
}
function tokenizeV8(block) {
  const toks = [];
  let i = 0;
  while (i < block.length) {
    const b = block[i];
    if (b === 0x22 || b === 0x63) {
      const s = tryReadV8String(block, i);
      if (s) {
        toks.push({ type: 'str', v: s.str }); i = s.end;
        if (s.str === 'isSentByCurrentUser' && (block[i] === 0x54 || block[i] === 0x46)) { toks.push({ type: 'bool', v: block[i] === 0x54 }); i++; }   // 'T' / 'F'
        continue;
      }
    }
    else if (b === 0x4e && i + 9 <= block.length) { toks.push({ type: 'num', v: block.readDoubleLE(i + 1) }); i += 9; continue; }
    i++;
  }
  return toks;
}

// Every field name that can sit next to the ones wanted, so that an empty value
// does not make the next field's NAME be taken for the value.
const MSG_KEYS = new Set(['searchKey', 'content', 'creator', 'imDisplayName', 'fromDisplayNameInToken', 'fromFamilyNameInToken', 'fromGivenNameInToken',
  'fromAgentIdentityBlueprintId', 'prioritizeImDisplayName', 'messageType', 'contentType', 'activityType', 'threadType', 'postType', 'type',
  'originalArrivalTime', 'clientArrivalTime', 'composetime', 'contentHash', 'sequenceId', 'skypeGuid', 'skypeeditedid', 'version',
  'clientLieResolvedTime', 'deletionInfo', 'source', 'properties', 'translation']);

// searchKey is "<conversation id>_<per-message suffix>"; the conversation id ends at its thread marker.
function normalizeThreadKey(searchKey) {
  const s = String(searchKey || '');
  const m = s.match(/^(.*?@(?:thread\.v2|thread\.skype|unq\.gbl\.spaces))/);
  return m ? m[1] : s.replace(/_-?\w+$/, '');
}

// The same message always gets the same id: its time plus a hash of its TEXT
// (not its HTML: one message is stored in several HTML variants).
function stableMsgId(ts, text) {
  const body = String(text || '');
  if (!ts && !body) return null;
  return (ts || 0) + ':' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
}

// Where a message ends. What follows it in the same block (the next chain's own originalArrivalTime; a conversation's record,
// whose lastMessage has a content and a creator as well) was taken for this message's: its time became the next one's, its
// words and who said them another's, and the same message was kept several times over (found 2026-11-25; about half of them).
const MSG_END = new Set(['recipientId', 'messageMap', 'lastMessage', 'replyChainId', 'latestDeliveryTime', 'parentMessageVersion']);

function parseMessagesFromBlock(block) {
  const toks = tokenizeV8(block);
  const out = [];
  let cur = null, clientId = '', ver = 0;
  const flush = () => {
    // Only what a person sent: the cache also holds system events that carry the same content.
    if (cur && cur.searchKey && cur.content && /thread\.v2|@thread/.test(cur.searchKey) && /^8:(live|orgid):/.test(cur.creator || '')) {
      out.push({ threadKey: normalizeThreadKey(cur.searchKey), creator: cur.creator || null, fromName: cur.fromName && cur.fromName !== '_' ? cur.fromName : null, contentHtml: cur.content, ts: cur.ts || null, mine: cur.mine, clientId: cur.clientId, ver: cur.ver || 0 });
    }
    cur = null;
  };
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    if (t.type === 'str' && MSG_END.has(t.v)) { flush(); clientId = ''; ver = 0; continue; }
    if (t.type === 'str' && t.v === 'isSentByCurrentUser' && cur && cur.mine === undefined && toks[i + 1].type === 'bool') { cur.mine = toks[i + 1].v; continue; }
    if (t.type === 'str' && t.v === 'clientMessageId') { clientId = toks[i + 1].type === 'str' && /^\d{6,}$/.test(toks[i + 1].v) ? toks[i + 1].v : ''; continue; }   // stands before the searchKey of its message
    // its version too (raised when it is edited): between the two
    if (t.type === 'str' && t.v === 'version' && clientId && toks[i + 1].type === 'str' && /^\d{10,}$/.test(toks[i + 1].v)) { ver = Number(toks[i + 1].v); continue; }
    if (t.type !== 'str' || !MSG_KEYS.has(t.v)) continue;
    const key = t.v, next = toks[i + 1];
    if (key === 'searchKey') { flush(); cur = { clientId, ver }; clientId = ''; ver = 0; }
    if (!cur) continue;   // outside a message
    // (the first of each is the message's own)
    if (key === 'originalArrivalTime') { if (next.type === 'num' && cur.ts === undefined) cur.ts = next.v; }
    else if (next.type === 'str' && !MSG_KEYS.has(next.v)) {
      if (key === 'searchKey') cur.searchKey = next.v;
      else if (key === 'content') {
        // the words may be the name of a field that ends a message: they are words when a field's name follows them
        const after = toks[i + 2], words = !MSG_END.has(next.v) || (after && after.type === 'str' && MSG_KEYS.has(after.v));
        if (words) { if (cur.content === undefined) cur.content = next.v; i++; }
      }
      else if (key === 'creator') { if (cur.creator === undefined) cur.creator = next.v; }
      else if (key === 'fromDisplayNameInToken') { if (!cur.named) { cur.fromName = next.v; cur.named = true; } }
      else if (key === 'imDisplayName' && !cur.fromName) cur.fromName = next.v;
    }
  }
  flush();
  return out;
}

// The write-ahead log is written in blocks of 32 KB, each piece behind a header of 7 bytes (checksum, length, kind): a
// message that runs over the end of a block has a header in the middle of it, and was lost (found 2026-11-25).
function readLogPieces(buf) {
  const out = [], SIZE = 32768;
  for (let at = 0; at < buf.length; at += SIZE) {
    const end = Math.min(at + SIZE, buf.length); let p = at;
    while (p + 7 <= end) {
      const len = buf.readUInt16LE(p + 4), kind = buf[p + 6];
      if (!kind && !len) break;                                  // the rest of the block is empty
      if (kind > 4 || p + 7 + len > end) { out.push(buf.subarray(p, end)); p = end; break; }   // not as expected: as it is
      out.push(buf.subarray(p + 7, p + 7 + len)); p += 7 + len;
    }
  }
  return Buffer.concat(out);
}

function scanFiles(dir = defaultLevelDbDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.ldb') || f.endsWith('.log')).map((f) => { const st = fs.statSync(path.join(dir, f)); return { fname: f, size: st.size, mtime: Math.floor(st.mtimeMs) }; });
}

function parseFile(buf, fname) {
  if (!fname.endsWith('.ldb')) return parseMessagesFromBlock(readLogPieces(buf));   // the write-ahead log is not a table: its pieces put together, and scanned whole
  const out = [];
  for (const block of readSSTableBlocks(buf)) out.push(...parseMessagesFromBlock(block));
  return out;
}

// {dir?, sinceMs?, knownFiles?: {fname: {size, mtime}}, tmpRoot?}
// -> {messages (oldest first), files: fingerprints of the files read without trouble, failed: how many could not be read}.
// Only files that are new or changed since knownFiles are read.
function readTeamsMessages({ dir = defaultLevelDbDir(), sinceMs = 0, knownFiles = null, tmpRoot = os.tmpdir() } = {}) {
  if (!available(dir)) return { messages: [], files: [], failed: 0 };
  const all = scanFiles(dir);
  const todo = knownFiles ? all.filter((f) => { const k = knownFiles[f.fname]; return !k || k.size !== f.size || k.mtime !== f.mtime; }) : all;
  if (!todo.length) return { messages: [], files: all, failed: 0 };
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sb-teams-'));
  try {
    const seen = new Set(), byClient = new Map(), msgs = [], failed = new Set();
    for (const f of todo) {
      const dst = path.join(tmp, f.fname);
      let buf;
      // A file Teams is writing may be locked. It is left out of the fingerprints, so the next run tries it again.
      try { fs.copyFileSync(path.join(dir, f.fname), dst); buf = fs.readFileSync(dst); } catch (e) { failed.add(f.fname); continue; }
      for (const m of parseFile(buf, f.fname)) {
        if (m.ts && m.ts <= sinceMs) continue;
        m.contentText = htmlToText(m.contentHtml);
        delete m.contentHtml;
        // the number the sender's Teams gave it stays the same while it is sent (first with a time of this computer, then the
        // server's): one message, kept once, with the later time
        m.msgId = m.clientId ? 'c' + crypto.createHash('sha1').update(String(m.creator) + '|' + m.clientId).digest('hex').slice(0, 16) : stableMsgId(m.ts, m.contentText);
        if (m.clientId) {
          const k = m.threadKey + '|' + m.msgId, was = byClient.get(k);
          if (was) {
            if (m.ver > was.ver || (m.ver === was.ver && (m.ts || 0) >= (was.ts || 0))) Object.assign(was, { ts: Math.max(m.ts || 0, was.ts || 0) || null, ver: m.ver, contentText: m.contentText || was.contentText, mine: m.mine === undefined ? was.mine : m.mine });
            continue;
          }
          byClient.set(k, m);
        }
        const key = m.threadKey + '|' + (m.msgId || m.ts + '|' + m.contentText.slice(0, 40));
        if (seen.has(key)) continue;
        seen.add(key);
        msgs.push(m);
      }
      try { fs.unlinkSync(dst); } catch (e) {}
    }
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return { messages: msgs, files: all.filter((f) => !failed.has(f.fname)), failed: failed.size };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
}

module.exports = { readTeamsMessages, available, defaultLevelDbDir, stableMsgId, normalizeThreadKey, parseMessagesFromBlock, readLogPieces };
