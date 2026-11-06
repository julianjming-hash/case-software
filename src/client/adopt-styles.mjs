// Styles for a blank same-origin document drawn from this page (the Builder's fit probe and the Run preview, CASE-226).
import { standardsPage } from './shell.mjs';
/**
 * Give another document the Builder's already-loaded styles without any network: same-origin rules are copied into
 * stylesheets constructed in that document's realm, and each loaded font is re-created there from bytes the Builder
 * page fetches (from cache). Nested about:blank windows and frames do not reliably load their own subresources, so
 * nothing here waits on them. Resolves when the fonts are ready.
 */
export async function adoptStyles(target, sourceDocument) {
  standardsPage(target); // R10: a standards-mode page first, as the room's own pages are (CASE-249)
  const view = target.defaultView, sheets = [], fonts = [];
  for (const sheet of sourceDocument.styleSheets) {
    let rules; try { rules = [...sheet.cssRules]; } catch { continue; } // cross-origin sheets are skipped
    const text = [];
    for (const rule of rules) {
      if (rule.type === 5) { const src = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1];
        if (src) fonts.push({ family: rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim(), url: new URL(src, sheet.href ?? sourceDocument.baseURI).href,
          weight: rule.style.getPropertyValue('font-weight') || 'normal', style: rule.style.getPropertyValue('font-style') || 'normal' }); continue; }
      if (rule.type !== 3) text.push(rule.cssText);
    }
    const copy = new view.CSSStyleSheet(); copy.replaceSync(text.join('\n')); sheets.push(copy);
  }
  target.adoptedStyleSheets = sheets;
  if (sourceDocument.documentElement?.dataset?.theme) target.documentElement.dataset.theme = sourceDocument.documentElement.dataset.theme;
  await Promise.all(fonts.map(async font => {
    try { const bytes = await (await sourceDocument.defaultView.fetch(font.url)).arrayBuffer();
      const face = new view.FontFace(font.family, bytes, { weight: font.weight, style: font.style }); await face.load(); target.fonts.add(face); } catch { /* a missing font falls back */ }
  }));
}
