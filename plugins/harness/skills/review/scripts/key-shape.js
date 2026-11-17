'use strict';
// What a secret looks like when it is written as "a name = a quoted value" (K='mb_…', $c.ApiKey = '…', c['ApiKey']='…').
// One definition for both sides of review-collect.js: finding such a command (SECRET_KINDS) and hiding the value in
// everything written out (REDACT_RULES). Two copies of this pattern once drifted apart: a form the finder knew
// (c['ApiKey']='…') went out unhidden.

// The name: a variable or property ($c.ApiKey, K, TOK) or a subscript (['ApiKey']). Not anchored at a word start, so a
// longer name is matched by its last 41 characters - the same on both sides.
const NAME = String.raw`(?:\$?[A-Za-z_][\w.]{0,40}|\[\s*['"][\w-]{1,40}['"]\s*\])`;
// name = 'value' (16+ characters, no quote or space inside), the same quote on both ends
const ASSIGN = new RegExp(NAME + String.raw`\s*=\s*(['"])[^'"\s]{16,}\1`);
const ASSIGN_REDACT = new RegExp('(' + NAME + String.raw`\s*=\s*(['"]))([^'"\s]{16,})(?=\2)`, 'g');

// Well-known key prefixes (Metabase mb_, OpenAI / Stripe sk-, GitHub ghp_, GitLab glpat-, Slack xox?-, AWS AKIA,
// Google AIza / ya29., JWT eyJ, Hugging Face hf_, npm_, PyPI, SendGrid SG., Shopify shpat_, DigitalOcean dop_v1_).
const KEY_PREFIX = /^(?:mb_|sk-|sk_(?:live|test)_|[pr]k_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|ya29\.|eyJ|hf_|npm_|pypi-|SG\.|shpat_|dop_v1_)/;

// Is this value a key? In this order, each step only able to say no until the last two:
//   1 only characters keys are made of (base64 / base64url / dots); nothing starting with / or .   (a grep pattern with
//     brackets, a path)
//   2 not ending in a file extension                     (apbmt_export_v1.0.0/src/MappingDefinition.php, sk-notes.json)
//   3 not all hexadecimal, whatever the case             (a git SHA, a hash; a name with key/token in it is found by
//                                                         another kind)
//   4 a well-known prefix, at least 16 long, with a digit after the prefix   (npm_config_cache_dir_x is a setting)
//   5 else: 20+ letters and digits, upper, lower and digits all there, and changing between the three often (>= 0.3):
//     random text does, MyVeryLongClassName2024 does not
function looksLikeKey(v) {
  v = String(v || '');
  if (!/^[A-Za-z0-9_\-+\/=.]+$/.test(v) || /^[\/.]/.test(v)) return false;
  if (/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(v)) return false;
  if (/^[0-9a-f]+$/i.test(v)) return false;
  const pre = KEY_PREFIX.exec(v);
  if (pre) return v.length >= 16 && /\d/.test(v.slice(pre[0].length));
  const a = v.replace(/[^A-Za-z0-9]/g, '');
  if (a.length < 20 || !/[A-Z]/.test(a) || !/[a-z]/.test(a) || !/\d/.test(a)) return false;
  const cls = (ch) => (/[A-Z]/.test(ch) ? 'U' : /[a-z]/.test(ch) ? 'l' : 'd');
  let sw = 0; for (let i = 1; i < a.length; i++) if (cls(a[i]) !== cls(a[i - 1])) sw++;
  return sw / (a.length - 1) >= 0.3;
}

// One matched "name = 'value'" segment: is its value a key?
function assignHasKey(seg) { const m = String(seg).match(/=\s*(['"])([^'"\s]+)\1\s*$/); return !!m && looksLikeKey(m[2]); }

// The value hidden wherever the finder would have found it.
function redactAssign(text) { return String(text).replace(ASSIGN_REDACT, (all, pre, q, v) => (looksLikeKey(v) ? pre + '***' : all)); }

module.exports = { NAME, ASSIGN, ASSIGN_REDACT, KEY_PREFIX, looksLikeKey, assignHasKey, redactAssign };
