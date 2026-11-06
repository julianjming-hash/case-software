import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// CASE-327: Chrome serialises a `font:` shorthand made of var()s that a font longhand follows as empty longhands, so every
// adopted copy of the sheet (adopt-styles.mjs: the console's Room sees, the Builder's fit check and Run preview) lost the
// font (the projector's mono vitals drew in the body font and fitted fewer rows). Such a rule is written as longhands.
test('no stylesheet follows a var() font shorthand with a font longhand in the same rule', () => {
  const found = [];
  for (const file of readdirSync('src/client').filter(name => name.endsWith('.css'))) {
    const text = readFileSync(`src/client/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = body.split(';').map(part => part.trim()).filter(Boolean);
      const at = declarations.findIndex(part => /^font\s*:/.test(part) && part.includes('var('));
      if (at >= 0 && declarations.slice(at + 1).some(part => /^font-[a-z-]+\s*:/.test(part))) found.push(`${file}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(found, []);
});
