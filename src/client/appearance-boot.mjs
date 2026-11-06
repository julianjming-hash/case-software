// Classic (non-module) pre-paint script, loaded by src= in <head> before the stylesheets (CSP
// script-src 'self'; no inline code, no Trusted Types sink). It applies the device's own Appearance
// choice (card 29, CASE-166) before first paint, so a stored Light or Dark never flashes the other theme.
// Auto, or no stored value, sets nothing and the tokens follow prefers-color-scheme live. Projector
// documents always follow their own device. Keep in step with APPEARANCE_KEY in appearance.mjs. Motion off
// (device-preference-values.mjs, motion) is this device's choice everywhere, the projector included.
(function applyAppearance(root, path) {
  try {
    if (globalThis.localStorage.getItem('case:preferences:motion') === 'false') root.setAttribute('data-motion', 'false');
    if (/^\/[Dd]\//.test(path) || /^\/sessions\/[^/]+\/(?:display|facilitate)$/.test(path)) return;
    var value = globalThis.localStorage.getItem('case:appearance');
    if (value === 'light' || value === 'dark') root.setAttribute('data-theme', value);
  } catch (error) { /* Storage blocked: the OS theme applies. */ }
})(document.documentElement, location.pathname);
