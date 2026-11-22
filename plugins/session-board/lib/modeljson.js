'use strict';
// The JSON object in a model's answer: from its first "{" to its last "}" (anything said around it, a ```json fence,
// left out). -> the object | null
//
// It is not mended. A Windows path written with single backslashes cannot be told back from the JSON: "C:\temp\bin"
// even reads as valid JSON, with a tab and a backspace in it (review 2026-11-22: two rounds of mending kept turning up
// another such case). So the prompts keep paths out of what is read by the board - a file is named by its id (f0, f1)
// and a path asked for is written with forward slashes - and an answer that does not read is kept as it came.
function parse(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
// said in every prompt whose answer is read as JSON: a path of its own with forward slashes; text copied from a file
// exactly as it is, its backslashes written as JSON has them (\\) - review 2026-11-22: "forward slashes" alone told a
// tweak to change the file's own paths, and an edit's copied original no longer matched the file
const PATHS = '答案是 JSON：你自己寫到的檔案路徑用正斜線（例如 C:/Users/x/a.md）。';
// and where text is copied from a file (an edit's original, a tweaked section) - only there
const COPY = '從檔案照抄的原文一字不改，原文裡的反斜線照 JSON 規定寫成兩個（\\\\）。';
module.exports = { parse, PATHS, COPY };
