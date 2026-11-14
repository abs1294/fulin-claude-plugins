'use strict';
// Small pieces the fetchers share, written here so the plugin needs no packages.

// HTML to plain text: enough for mail bodies and chat messages. Block elements
// become line breaks, links keep their address, the rest of the markup goes.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    return !t || t === href || /^(mailto:|#)/i.test(href) ? (t || href) : t + ' (' + href + ')';
  });
  s = s.replace(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["'][^>]*>/gi, '$1');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section)>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ').replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCp(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => safeCp(Number(d))).replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
  return s.replace(/\r/g, '').replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t ]{2,}/g, ' ').trim();
}
function safeCp(n) { try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch (e) { return ''; } }

// Raw Snappy decompression (the format LevelDB blocks use). Throws on damaged input.
function snappyUncompress(src) {
  let pos = 0, len = 0, shift = 0;
  for (;;) { const b = src[pos++]; if (b === undefined) throw new Error('snappy: no length'); len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; if (shift > 32) throw new Error('snappy: bad length'); }
  len >>>= 0;
  if (len > 256 * 1024 * 1024) throw new Error('snappy: length too large');
  const out = Buffer.allocUnsafe(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++], type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) { const bytes = n - 59; n = 0; for (let i = 0; i < bytes; i++) n |= src[pos++] << (8 * i); n >>>= 0; }
      n += 1;
      if (pos + n > src.length || o + n > len) throw new Error('snappy: literal overruns');
      src.copy(out, o, pos, pos + n); pos += n; o += n;
    } else {
      let n, off;
      if (type === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[pos++]; }
      else if (type === 2) { n = (tag >> 2) + 1; off = src[pos] | (src[pos + 1] << 8); pos += 2; }
      else { n = (tag >> 2) + 1; off = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0; pos += 4; }
      if (!off || off > o || o + n > len) throw new Error('snappy: bad copy');
      for (let i = 0; i < n; i++) out[o + i] = out[o - off + i];   // may overlap itself: byte by byte
      o += n;
    }
  }
  if (o !== len) throw new Error('snappy: length mismatch');
  return out;
}

// ── signatures ──
// Takes the signature blocks out of a mail's text: closing lines ("Best Regards,"), the name-and-contact
// block under them, a block fenced by rules, a legal notice. A mail that quotes earlier mails has one per
// quoted mail, so the text is cut into parts at the quote headers ("From: …", "… 於 … 寫道：", a long rule)
// and each part loses its own tail. Used when a mail is handed to a conversation or copied - what is stored
// and shown stays whole. Guesswork by shape: it is careful (a block is only taken when what follows it to
// the end of the part looks like a signature), and the count of blocks removed is given back so it can be said.
const QUOTE_HEAD = /^(-{2,}\s*(original message|forwarded message|原始郵件|原始訊息|轉寄的郵件).*|from:\s.+|寄件者[:：].+|發件人[:：].+|on .{5,100} wrote:|.{0,80}於 .{5,80}(寫道|寫入)[:：]?|_{10,})$/i;
const CLOSING = /^(best regards|kind regards|warm regards|with regards|regards|b\.?r\.?|thanks\s*(&|and)\s*(best\s*)?regards|sincerely( yours)?|yours sincerely|cheers|敬祝.{0,10}|順頌.{0,10}|耑此.{0,10}|祝\s*(好|安好|順心|順利|工作順利|商祺).{0,4})[\s,，.。!！~]*$/i;
const CONTACT = /^[*_\s]*(tel|fax|mobile|phone|cell|e-?mail|mail|address|addr|website|web|line|[tmfe]|電話|分機|手機|行動|傳真|地址|信箱|電郵|網址|統編)\s*[:：.]\s*\S/i;
const PHONE = /^[+(]?\d[\d\s().#+\-]{6,}((分機|ext\.?|#)\s*\d+)?$/i;
const URL_ONLY = /^<?(https?:\/\/|www\.)\S+>?$/i;
const RULE = /^[=\-_*~]{8,}$/;
const DASHES = /^--\s?$/;
const NOTICE = /(confidential|privileged|intended recipient|機密|保密|本(電子)?(郵|信)件.{0,30}(收件人|僅供))/i;
const SIG_MAX_LINES = 25;
function stripSignatures(text) {
  const raw = String(text || '').split(/\r?\n/);
  const bare = raw.map((l) => l.replace(/^(\s*>)+\s?/, '').trim());
  // A line of contact details. A bare link counts towards "this is a contact block" but never starts one:
  // a link on a line of its own is usually what the mail is about.
  const contact = (l) => CONTACT.test(l) || PHONE.test(l);
  const contactish = (l) => contact(l) || URL_ONLY.test(l);
  // A sentence of the mail itself: long, or (Chinese says more per character) twenty characters and a full stop.
  const prose = (x) => !NOTICE.test(x) && !contactish(x) && (x.length > 60 || ((x.match(/[\u4e00-\u9fff]/g) || []).length >= 14 && /[。？！?!]$/.test(x)));
  const listItem = (l) => /^(\d{1,2}[.、)）]|[-*•‧·]\s|[（(]\d{1,2}[)）])/.test(l);
  const out = [];
  let removed = 0, lines = 0, from = 0;
  const part = (a, b) => {                         // lines a..b-1 are one part; its own tail is looked at
    let cut = -1;
    for (let i = a; i < b && cut < 0; i++) {
      const l = bare[i];
      if (!l) continue;
      const rest = []; for (let j = i + 1; j < b; j++) if (bare[j]) rest.push(bare[j]);
      if (rest.length > SIG_MAX_LINES) continue;
      // After the start of a signature there is no more prose: no long sentence that is not a legal notice.
      if (rest.some((x) => prose(x) && /[。？！?!]$/.test(x))) continue;
      const contacts = rest.filter(contact).length + (contact(l) ? 1 : 0);
      if (CLOSING.test(l) || DASHES.test(l)) cut = i;
      // a contact block with no closing line above it: short (a name, a few numbers), and at the very end of the part
      else if (contact(l) && contacts >= 2 && rest.length <= 10 && !rest.some(prose)) {
        cut = i;
        // the name and the company above the first contact line belong to it (two short lines at most; not a sentence, a list item or a link)
        for (let k = 0; k < 2 && cut - 1 >= a && bare[cut - 1] && bare[cut - 1].length <= 40 && !/[。？！?!，,：:]/.test(bare[cut - 1]) && !listItem(bare[cut - 1]) && !URL_ONLY.test(bare[cut - 1]) && !/https?:\/\//i.test(bare[cut - 1]) && !QUOTE_HEAD.test(bare[cut - 1]); k++) cut--;
      }
      else if (RULE.test(l) && contacts >= 2) cut = i;
      else if (NOTICE.test(l) && l.length > 40 && rest.length <= 8) cut = i;
    }
    if (cut < 0) { for (let i = a; i < b; i++) out.push(raw[i]); return; }
    // nothing but a signature in the part (a header and then only contact lines): leave it alone rather than empty it
    let kept = 0; for (let i = a; i < cut; i++) if (bare[i] && !/^(from|sent|to|cc|subject|date|寄件者|寄件日期|收件者|副本|主旨|日期)[:：]/i.test(bare[i]) && !QUOTE_HEAD.test(bare[i])) kept++;
    if (!kept && a === 0) { for (let i = a; i < b; i++) out.push(raw[i]); return; }
    for (let i = a; i < cut; i++) out.push(raw[i]);
    while (out.length && !out[out.length - 1].replace(/^(\s*>)+\s?/, '').trim()) out.pop();
    for (let i = cut; i < b; i++) if (bare[i]) lines++;
    removed++;
    if (b < raw.length) out.push('');
  };
  for (let i = 1; i < raw.length; i++) if (QUOTE_HEAD.test(bare[i])) { part(from, i); from = i; }
  part(from, raw.length);
  return { text: out.join('\n'), removed, lines };
}

module.exports = { htmlToText, snappyUncompress, stripSignatures };
