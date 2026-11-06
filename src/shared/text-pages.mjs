// CASE-318 (supersedes the page sizes of CASE-275/276): one packing rule for the free-text reveal. The room machine pages
// with it and the projector checks each page against it, so the two can never disagree. A page holds up to 12 answers,
// 1,500 characters, and an estimated 42 lines: three columns of 14 at the 1280×720 target and the 24px projector floor
// (CASE-211), about 25 characters a line. Larger projectors show the same page in larger type.
export const TEXT_PAGE_ANSWERS = 12;
export const TEXT_PAGE_CHARS = 1500;
const LINE_CHARS = 25, PAGE_TENTHS = 420; // lines in tenths: each answer costs its wrapped lines plus 0.9 for its chip edge

// Wide glyphs (CJK, emoji and other astral or full-width characters) count as two, so the estimate errs towards more pages.
const width = (text) => { let n = 0; for (const ch of text) n += ch.codePointAt(0) >= 0x2e80 ? 2 : 1; return n; };
const tenths = (text) => Math.ceil(width(text) / LINE_CHARS) * 10 + 9;

/** True when these answers fit one projector page. */
export function fitsTextPage(answers) {
  return answers.length <= TEXT_PAGE_ANSWERS
    && answers.reduce((n, t) => n + t.length, 0) <= TEXT_PAGE_CHARS
    && answers.reduce((n, t) => n + tenths(t), 0) <= PAGE_TENTHS;
}

/** Sorted answers → pages, greedily in reading order; every answer (≤ 500 characters) fits a page alone. */
export function packTextPages(answers) {
  const pages = [[]];
  for (const answer of answers) {
    const last = pages.at(-1);
    if (last.length && !fitsTextPage([...last, answer])) pages.push([answer]);
    else last.push(answer);
  }
  return pages;
}
