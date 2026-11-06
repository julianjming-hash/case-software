// The acceptance-scenario traceability gate (docs/ACCEPTANCE-SCENARIOS.md).
//
// Every AS-NNN row must be either
//   • COVERED: named, as `[AS-NNN]`, in the title of at least one real test that a gate runs:
//       tests/*.test.mjs (npm test), tests/load-gates/*.test.mjs (npm run test:load-gates, CI job load-gates),
//       tests/worker/**/*.test.mjs (npm run test:do),
//       e2e/*.spec.mjs (npm run test:e2e), or an `-- [AS-NNN]` line in db/tests/*.test.sql (npm run test:db);
//     test.todo / test.skip / it.skip titles do not count; or
//   • PENDING: listed below with the reason it cannot be proved yet. Each pending id is reported as a
//     `todo` in the node test output, so the count is visible on every run, never silently skipped.
//
// A pending id that gains a real test fails this gate until it is removed from PENDING, and an
// [AS-NNN] in a test title that is not a row in the doc fails it too.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** id → why it cannot be proved yet. Remove a row when its test lands. AS-021/022/023/025/026 landed
 *  with the client transport (tests/transport.test.mjs, e2e/room-real.spec.mjs). */
export const PENDING = Object.freeze({
  'AS-020': 'Real iPhone captive-portal storage partitioning, token loss and print/PDF behavior remain owner-only pending the docs/DEVELOPMENT.md protocol and recorded device evidence; desktop browser checks do not prove the device contract',
  // Facilitator-UX Access PR (CASE-336 to CASE-338): rows whose proofs later steps build (plan §5).
  // AS-205/207/208/209/211/213 gained their db proofs in step A2 (db/tests/access-invitations-images.test.sql); their
  // unit and e2e parts are todo lines in tests/permissions-matrix.test.mjs.
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'tests/acceptance-coverage.test.mjs';

// Literal aliases preserve the already proved Card25 titles; each exact source body
// is hashed, so a renamed, skipped, weakened or otherwise changed gate cannot gain credit silently.
export const CARD25_ALIASES = Object.freeze({
  "AS-090": [
    {
      "file": "tests/ranked-groups.test.mjs",
      "title": "[AS-090] Card25 grouping counts identical complete orders and every fixed length from two through eight",
      "bodySha256": "e00767456318995e2aab824d46490b6c0bd745276a7bb9bc4bd94c17de86e2fb"
    },
    {
      "file": "tests/ranked-groups.test.mjs",
      "title": "Card25 grouping uses authored-index ties independent of labels and arrival without mutating inputs",
      "bodySha256": "43eb2082a6d34be6fb3299f447de379956a09d7c3120e005f388ae316c5c9def"
    },
    {
      "file": "tests/ranked-groups.test.mjs",
      "title": "Card25 grouping rejects invalid closure payloads rather than shortening or silently excluding an accepted order",
      "bodySha256": "1f30d991752d2e9ded86d0dd501db75369858290f8de5729aaa28e9f01bfdccb"
    },
    {
      "file": "tests/ranked-groups.test.mjs",
      "title": "Card25 grouping and validation preserve a one-item legacy order and proven empty zero-eligible closure",
      "bodySha256": "dd8ec74e921e9cdb6322a0e6f3a95c5e86a0522fc3fdbea5ecd8d762f8430630"
    },
    {
      "file": "tests/ranked-groups.test.mjs",
      "title": "Card25 compact inventory retains all three hundred distinct legal eight-position orders",
      "bodySha256": "9bc500fc65840c4e8ab97cb28ecad3f0b42618bde8e06ec2dbc95e6bf6c44ac0"
    },
    {
      "file": "tests/ranked-groups.test.mjs",
      "title": "Card25 inventory validation refuses corrupt tuple dimensions, eligibility, totals, sorting and duplicate groups",
      "bodySha256": "64097b71a6a8f196a9113b51894b6f16fbd5d99677065e87761cba624c7aba4c"
    },
    {
      "file": "tests/worker/ranked-groups.test.mjs",
      "title": "Card25 native complete orders persist at lock and fenced selection survives cold HTTP and receipts",
      "bodySha256": "c3e985f1e36ef2af7566784cc7693b8661e03473753b17f6bfb94cee3c91e707"
    },
    {
      "file": "tests/ranked-presentation.test.mjs",
      "title": "Card25 authority freezes latest complete orders, excludes removal before lock and retains post-lock removal",
      "bodySha256": "c1eedd6d23d10a73d5cf1f316b583162d8548fe43dbb706059e9bb830ee0d348"
    }
  ],
  "AS-091": [
    {
      "file": "e2e/ranked-projector.spec.mjs",
      "title": "[AS-091] Card25 actual authenticated Other Back direct selection and pending focus preserve anonymous closed authority",
      // Reviewed Room-only setup driver returns to Run; popup identity/focus survive a real join snapshot and commit its fresh revision.
      // Console layout v2 (reviewed 2026-10-18): the setup driver dismisses the display reminder through Use another screen and the
      // room count is read from the rail; every prior Card25 authority, pending-focus and private/public assertion remains.
      // CASE-327 (reviewed 2026-11-01): five ranked positions a page (three under a long prompt), one footer total, a column count only
      // when the room gave more than one order; paging steps and footer strings follow, every prior authority assertion remains.
      // CASE-353 (2026-11-03): only the negative phone-region locator changes Room result → Group result;
      // closed-authority, pending-focus and privacy assertions remain unchanged.
      "bodySha256": "07aa14744df7245cca47e0dafc022e182a2d605a6137cbd62139281570a4790d"
    },
    {
      "file": "e2e/ranked-projector.spec.mjs",
      "title": "Card25 loaded-font full labels count ${count} ${kind} fit both real projector shells and themes with aligned ranks and totals",
      // CASE-327 (reviewed 2026-11-01): five ranked positions a page (three under a long prompt), one footer total, a column count only
      // when the room gave more than one order; paging steps and footer strings follow, every prior authority assertion remains.
      "bodySha256": "8cb5246363bc4a1cd9dfa7c1daee4dbdaa73b16f7ef25f9a216dcc916ae2dedc"
    },
    {
      "file": "tests/ranked-renderer.test.mjs",
      "title": "[AS-195] Card25 shared renderer draws complete vertical columns with authored marks, one footer and a count per order (CASE-327)",
      // CASE-327 (reviewed 2026-11-01): five ranked positions a page (three under a long prompt), one footer total, a column count only
      // when the room gave more than one order; paging steps and footer strings follow, every prior authority assertion remains.
      "bodySha256": "30364e6d88eb58efde0b78e3c104172964495634fb4048c4902820af1f8843f8"
    },
    {
      "file": "tests/ranked-renderer.test.mjs",
      "title": "Card25 shared renderer preserves original ranks in continuations, explicit meaning and honest empty or legacy results",
      // CASE-327 (reviewed 2026-11-01): five ranked positions a page (three under a long prompt), one footer total, a column count only
      // when the room gave more than one order; paging steps and footer strings follow, every prior authority assertion remains.
      "bodySha256": "12e61f29d0a21c879d22f47aed2ae222fc5a08e645f0f62988201cc3bfe3fba3"
    },
    {
      "file": "tests/ranked-controls.test.mjs",
      "title": "Card25 console model distinguishes Other Back direct orders and position navigation with revision fences",
      "bodySha256": "e51423ef12f5aadf104b8700fd55423024bd4d38a6c04ee0b2447b65f18d0d7b"
    },
    {
      "file": "tests/ranked-controls.test.mjs",
      "title": "Card25 console model has no authority when hidden replayed or empty and every compact group remains directly reachable",
      "bodySha256": "3744eaf5c9054f7db68f427825097ed81f79d2aa07c94f631eda21c5dbfc6483"
    }
  ],
  "AS-092": [
    {
      "file": "tests/ranked-presentation.test.mjs",
      "title": "Card25 group authority requires facilitator, exact observed revision and bounded strict wire payloads",
      "bodySha256": "092403bd7ec63144a0ce02e3f7ec71dc30e23fb9ba3f26ee7b5dfea8122bc8b5"
    },
    {
      "file": "tests/ranked-presentation.test.mjs",
      "title": "[AS-092] Card25 public selected tuples are strict anonymous closure-only data and legacy marginals never fabricate groups",
      "bodySha256": "475c1133c90561d73ef549c83892369e7a5b6f8ce16479488d67659a670037ef"
    },
    {
      "file": "tests/ranked-presentation.test.mjs",
      "title": "Card25 navigation survives replay and stable manual but resets on new rounds and end without altering phone result timing",
      "bodySha256": "54fa4a8e0dc0fe1276cbc596115a20fb0c2fb6c314b83b91404ba461775bfbcc"
    },
    {
      "file": "tests/ranked-presentation.test.mjs",
      "title": "Card25 manual ranked selection replays after an otherwise legal server participant arrival",
      "bodySha256": "dc2762c73d8268761da92719207eeb688dcfcb33dc9b02d06c04ab42470ae464"
    },
    {
      "file": "tests/ranked-presentation.test.mjs",
      "title": "Card25 closed-round targeting rejects a different closure even with a current online revision",
      "bodySha256": "1439428b736c1fce4722eb3e3819ca4cda07ff9471cfe8245bac27be0d8a41a0"
    },
    {
      "file": "tests/worker/ranked-manual.test.mjs",
      "title": "Card25 authenticated native manual selection recovers after participant arrival and remains cold and replay safe",
      "bodySha256": "7b628005f87977c06642f8175d927f9e412aabf10f2ba02986beb9ea1ee9b360"
    }
  ]
});
const aliasFailures = [];
const aliasSeen = new Set();
const literalCard25Witnesses = new Set();


function scenarioIds() {
  const ids = [];
  let inTable = false;
  for (const line of readFileSync(join(ROOT, 'docs/ACCEPTANCE-SCENARIOS.md'), 'utf8').split('\n')) {
    if (/^\| ID \| Scenario \|/.test(line)) { inTable = true; continue; }
    if (inTable && !line.startsWith('|')) { inTable = false; continue; }
    const m = inTable && line.match(/^\| (AS-\d{3}) \|/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function walk(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = `${dir}/${name}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p];
  });
}

/** The test files the gates actually run, mapped to the AS ids their real test titles name. */
export function coverage() {
  const files = [
    ...walk('tests').filter((f) => /^tests\/(?:load-gates\/)?[^/]+\.test\.mjs$/.test(f) || /^tests\/worker\/.+\.test\.mjs$/.test(f)),
    ...walk('e2e').filter((f) => /\.spec\.mjs$/.test(f)),
    ...walk('db/tests').filter((f) => /\.test\.sql$/.test(f)),
  ].filter((f) => f !== SELF);
  const covered = new Map(); // id → [file]
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const titles = file.endsWith('.sql')
      ? [...text.matchAll(/^\s*--\s*((?:\[AS-\d{3}\]\s*)+)/gm)].map((m) => m[1])
      // `test(` / `it(` only: `test.todo(`, `test.skip(` and `it.skip(` never match.
      : [...text.matchAll(/(?<![.\w])(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
    for (const title of titles) {
      for (const [, id] of title.matchAll(/\[(AS-\d{3})\]/g)) {
        covered.set(id, [...(covered.get(id) ?? []), file]);
        if (!file.endsWith('.sql') && /^AS-09[012]$/.test(id)) literalCard25Witnesses.add(id);
      }
    }
    const realTitles = [...text.matchAll(/(?<![.\w])(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)];
    for (const [id, aliases] of Object.entries(CARD25_ALIASES)) for (const alias of aliases) {
      if (alias.file !== file) continue;
      const index = realTitles.findIndex(match => match[2] === alias.title);
      if (index < 0) { aliasFailures.push(`${id}: missing real literal title in ${file}`); continue; }
      const body = text.slice(realTitles[index].index, realTitles[index + 1]?.index ?? text.length);
      if (createHash('sha256').update(body).digest('hex') !== alias.bodySha256) {
        aliasFailures.push(`${id}: changed test body in ${file}: ${alias.title}`); continue;
      }
      aliasSeen.add(alias);
      covered.set(id, [...(covered.get(id) ?? []), file]);
    }
  }
  return covered;
}

const ids = scenarioIds();
const covered = coverage();

test('acceptance scenarios: every AS id has a real test or an explicit pending reason', (t) => {
  assert.deepEqual([...literalCard25Witnesses].sort(), ['AS-090', 'AS-091', 'AS-092'], 'each Card25 row requires a genuine literal runtime-title prefix independently of alias credit');
  assert.deepEqual(aliasFailures, [], 'literal acceptance alias bodies must remain exact');
  assert.equal(aliasSeen.size, Object.values(CARD25_ALIASES).flat().length, 'every literal alias names a gate-run file');
  assert.ok(ids.length > 0, 'no scenario rows parsed from docs/ACCEPTANCE-SCENARIOS.md');
  assert.deepEqual(ids, ids.map((_, i) => `AS-${String(i + 1).padStart(3, '0')}`), 'AS ids are contiguous from AS-001');
  const missing = ids.filter((id) => !covered.has(id) && !PENDING[id]);
  assert.deepEqual(missing, [], 'scenarios with neither a test nor a pending reason');
  const stale = Object.keys(PENDING).filter((id) => covered.has(id));
  assert.deepEqual(stale, [], 'pending scenarios that now have a test: remove them from PENDING');
  const unknown = [...new Set([...covered.keys(), ...Object.keys(PENDING)])].filter((id) => !ids.includes(id));
  assert.deepEqual(unknown, [], 'AS ids referenced by tests or PENDING that are not rows in the doc');
  for (const [id, why] of Object.entries(PENDING)) assert.ok(why.length > 20, `${id} needs a real pending reason`);
  t.diagnostic(`${ids.length} scenarios: ${ids.length - Object.keys(PENDING).length} covered, ${Object.keys(PENDING).length} pending`);
});

for (const [id, why] of Object.entries(PENDING)) test.todo(`[pending] ${id}: ${why}`);
