// Presentation themes (CASE-227), apart from slide-text.mjs so the served slide renderer carries none of it.
/**
 * Presentation themes (CASE-227): one per case, named, never a stored colour. Each is a token set in tokens.css scoped
 * by the `slide-theme-<name>` class, checked at 7:1 by the design gates. Absent (or 'case') follows the room's own light or dark.
 */
export const SLIDE_THEMES = Object.freeze({ case: 'Case', clinic: 'Clinic', night: 'Night', print: 'Print' });
/** Scope a drawn slide to a theme by class; 'case', absent and unknown names leave it as it is. */
export const applySlideTheme = (node, theme) => { if (node && theme !== 'case' && Object.hasOwn(SLIDE_THEMES, theme ?? '')) node.classList.add(`slide-theme-${theme}`); return node; };
/** The theme a document asks for, or null for the default. */
export const slideTheme = document => Object.hasOwn(SLIDE_THEMES, document?.theme) && document.theme !== 'case' ? document.theme : null;
