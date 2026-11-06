// src/worker/snapshot-text.mjs: a snapshot body as JSON text for the Durable Object's broadcasts (CASE-281).
// Worker-only, so the bytes stay out of the client bundle that imports src/shared/wire.mjs.

/**
 * A snapshot body as JSON text, with a phone timeline shared across one broadcast serialised once (CASE-281).
 * `shared` is `{ timeline, text }`, where `text` is JSON.stringify(timeline). It is spliced in only when the view
 * carries that very array; otherwise this is plain JSON.stringify. The parsed result is identical either way: only
 * the key order differs (`timeline` becomes the view's last key).
 */
export function snapshotText(body, shared = null) {
  const timeline = body?.view?.timeline;
  if (!shared || !Array.isArray(timeline) || timeline !== shared.timeline || typeof shared.text !== 'string') return JSON.stringify(body);
  const { view: { timeline: _timeline, ...view }, ...outer } = body;
  return withRawMember(JSON.stringify(outer), 'view', withRawMember(JSON.stringify(view), 'timeline', shared.text));
}

/** `objectText` is a serialised plain object; `raw` is already-serialised JSON for the added key. */
function withRawMember(objectText, key, raw) {
  return `${objectText.slice(0, -1)}${objectText === '{}' ? '' : ','}${JSON.stringify(key)}:${raw}}`;
}
