const utf8 = new TextEncoder();
const pointerPart = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');

/** Parse untrusted JSON while rejecting duplicate decoded object keys before JSON.parse. */
export function parseBoundedJson(text, {
  maxBytes = 2 * 1024 * 1024,
  maxDepth = 32,
  maxNodes = 100_000,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 ||
      !Number.isSafeInteger(maxNodes) || maxNodes < 0) return failure('bad_limits', '', 'parser limits are invalid');
  let bytes, source;
  if (typeof text === 'string') { source = text; bytes = utf8.encode(text).byteLength; }
  else if (text instanceof Uint8Array) {
    bytes = text.byteLength;
    if (bytes > maxBytes) return failure('too_large', '', `JSON exceeds ${maxBytes} UTF-8 bytes`, { bytes });
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(text); }
    catch { return failure('invalid_utf8', '', 'JSON body is not valid UTF-8', { bytes }); }
  } else return failure('not_text', '', 'JSON input must be text or UTF-8 bytes');
  if (bytes > maxBytes) return failure('too_large', '', `JSON exceeds ${maxBytes} UTF-8 bytes`, { bytes });

  text = source;
  let at = 0;
  let nodes = 0;
  const whitespace = () => { while (at < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[at])) at++; };
  const fail = (code, path, message) => { throw { code, at: path, message }; };

  function stringToken(path) {
    const start = at++;
    while (at < text.length) {
      const c = text.charCodeAt(at++);
      if (c === 0x22) {
        const raw = text.slice(start, at);
        try { return { raw, value: JSON.parse(raw) }; }
        catch { fail('not_json', path, 'invalid JSON string'); }
      }
      if (c < 0x20) fail('not_json', path, 'unescaped control character in JSON string');
      if (c === 0x5c) {
        if (at >= text.length) fail('not_json', path, 'incomplete JSON escape');
        const escaped = text[at++];
        if (escaped === 'u') {
          const hex = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('not_json', path, 'invalid Unicode escape');
          at += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) fail('not_json', path, 'invalid JSON escape');
      }
    }
    fail('not_json', path, 'unterminated JSON string');
  }

  function value(depth, path) {
    whitespace();
    nodes++;
    if (nodes > maxNodes) fail('too_many_nodes', path, `JSON exceeds ${maxNodes} values`);
    const c = text[at];
    if (c === '{' || c === '[') {
      if (depth + 1 > maxDepth) fail('too_deep', path, `JSON exceeds depth ${maxDepth}`);
      at++;
      whitespace();
      if (c === '{') {
        const keys = new Set();
        if (text[at] === '}') { at++; return; }
        for (;;) {
          whitespace();
          if (text[at] !== '"') fail('not_json', path, 'object member name must be a string');
          const key = stringToken(path);
          if (keys.has(key.value)) fail('duplicate_key', `${path}/${pointerPart(key.value)}`, 'duplicate object member name');
          keys.add(key.value);
          whitespace();
          if (text[at++] !== ':') fail('not_json', path, 'expected colon after object member name');
          value(depth + 1, `${path}/${pointerPart(key.value)}`);
          whitespace();
          const delimiter = text[at++];
          if (delimiter === '}') return;
          if (delimiter !== ',') fail('not_json', path, 'expected comma or closing brace');
        }
      }
      if (text[at] === ']') { at++; return; }
      let index = 0;
      for (;;) {
        value(depth + 1, `${path}/${index++}`);
        whitespace();
        const delimiter = text[at++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail('not_json', path, 'expected comma or closing bracket');
      }
    }
    if (c === '"') { stringToken(path); return; }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) { at += literal.length; return; }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (number) { at += number[0].length; return; }
    fail('not_json', path, 'expected a JSON value');
  }

  try {
    whitespace();
    value(0, '');
    whitespace();
    if (at !== text.length) fail('not_json', '', 'unexpected content after JSON value');
    return { ok: true, value: JSON.parse(text), bytes, nodes };
  } catch (error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return { ok: false, error: { code: error.code, at: error.at, message: error.message }, bytes, nodes };
    }
    return failure('not_json', '', 'invalid JSON', { bytes, nodes });
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

function failure(code, at, message, extra = {}) {
  return { ok: false, error: { code, at, message }, ...extra };
}
