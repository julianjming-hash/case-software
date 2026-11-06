// Slide text helpers shared by the validator and the renderers (card 57). Kept apart from slide-document.mjs so the
// projector, phone and console render slides without loading the whole schema-3 validator.

// Callout tones are presentation names mapped to existing tokens; no colour value is ever stored (BWR20).
export const CALLOUT_TONES = Object.freeze({ plain: null, soft: '--quiet', blue: '--mark-blue', teal: '--mark-teal', green: '--mark-green',
  purple: '--mark-purple', coral: '--mark-red', orange: '--mark-orange', amber: '--mark-yellow', grey: '--mark-grey' });
/** Whole-slide fills (CASE-312): the block tones as the same light/dark --slide-fill-* tokens; absent is the plain ground. */
export const SLIDE_FILLS = Object.freeze(Object.keys(CALLOUT_TONES).filter(tone => tone !== 'plain'));
/** Text colours (CASE-225): the callout tones that read as text; absent is the slide's ink. */
export const INK_TONES = Object.freeze(['blue', 'teal', 'green', 'purple', 'coral', 'orange', 'amber', 'grey']);
/** Run scripts (CASE-225): subscript and superscript. */
export const RUN_SCRIPTS = Object.freeze(['sub', 'sup']);
/** Plain learner text of a paragraph list, for bounds and labels. */
export const paragraphsText = paragraphs => (Array.isArray(paragraphs) ? paragraphs : []).map(item => (Array.isArray(item?.runs) ? item.runs : []).map(run => typeof run?.text === 'string' ? run.text : '').join('')).join('\n');
/**
 * Callout icons (CASE-344): a closed key set drawn from src/shared/icons.mjs; 'none' is a callout with no icon. A callout
 * that carries `icon` (any key, 'none' included) is the centred callout: icon and text centred in its area. Its document
 * declares CALLOUT_ICON_CAPABILITY, so a build that predates it refuses the document by that name.
 */
export const CALLOUT_ICONS = Object.freeze(['none', 'info', 'alert', 'stop', 'check', 'pulse', 'clock', 'pill', 'syringe', 'stethoscope', 'bulb', 'phone', 'users', 'quote']);
export const CALLOUT_ICON_CAPABILITY = 'callout_icon';
