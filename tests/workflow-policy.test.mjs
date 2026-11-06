import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const verify = readFileSync(`${workflows}/verify.yml`, 'utf8');

// CASE-160 (2026-10-06) replaced "no secret references anywhere" with an allowlist: only the three
// deploy workflows may read secrets, only the plan's names, only in a step-level env
// (scripts/ci-workflow-policy.mjs; every rule is proven in tests/ci-workflow-policy.test.mjs).
test('GitHub workflows reference secrets only where CASE-160 allows', async () => {
  const { SECRET_WORKFLOWS, checkWorkflow } = await import('../scripts/ci-workflow-policy.mjs');
  for (const file of readdirSync(workflows).filter((name) => name.endsWith('.yml'))) {
    const source = readFileSync(`${workflows}/${file}`, 'utf8');
    const expressions = [...source.matchAll(/\$\{\{([\s\S]*?)\}\}/g)];
    if (!Object.hasOwn(SECRET_WORKFLOWS, file)) assert.equal(expressions.some((match) => /\bsecrets\b/i.test(match[1])), false, `${file} references the GitHub Actions secrets context`);
    assert.equal(/^\s*secrets\s*:/m.test(source), false, `${file} grants secrets to a workflow or job`);
    assert.deepEqual(checkWorkflow(file, source).filter((v) => /secret/.test(v.rule)).map((v) => v.message), [], file);
  }
});

test('dependency changes block on audit, while other PRs report failures', () => {
  assert.match(verify, /audit:\s*\n\s+- 'package\*\.json'/, 'dependency files must set the audit path output');
  const auditJob = verify.split('\n  audit:\n')[1]?.split('\n  actionlint:\n')[0];
  assert.ok(auditJob, 'audit job must exist');
  assert.match(auditJob, /if: github\.event_name != 'schedule' \|\| github\.event\.schedule == '0 4 \* \* 1'/);
  assert.match(auditJob, /continue-on-error: \$\{\{ github\.event_name == 'pull_request' && needs\.changes\.outputs\.audit != 'true' \}\}/);
  assert.match(auditJob, /steps\.dependencies\.outcome == 'failure' && steps\.dependencies\.conclusion == 'success'/);
});

test('nightly runs the full local browser suite and Worker PRs still trigger it', () => {
  assert.match(verify, /cron: '0 3 \* \* \*'/);
  assert.match(verify, /cron: '0 4 \* \* 1'/);
  assert.match(verify, /- 'src\/worker\/\*\*'/);
  const browserJob = verify.split('\n  browser-harness:\n')[1]?.split('\n  audit:\n')[0];
  assert.ok(browserJob, 'browser job must exist');
  assert.match(browserJob, /github\.event_name == 'schedule' && github\.event\.schedule == '0 3 \* \* \*'/);
  assert.match(browserJob, /run: npm run test:e2e/);
});
