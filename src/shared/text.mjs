// Shared human-string sanitizer; legacy room-machine API re-exports this binding.
// C0/C1 controls, bidi overrides/isolates, and lone surrogates are removed from every human
// string. A NUL would also make Postgres jsonb reject the whole archive batch (red team P0-4).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export function cleanText(v, max) {
  return String(v ?? '').normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
