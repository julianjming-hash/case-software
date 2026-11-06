import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkWorkflow } from '../scripts/ci-workflow-policy.mjs';

// AUTONOMOUS-DEPLOY §8: the line-based workflow policy. Each case breaks exactly one rule of a
// compliant secret-holding fixture, so every rule is shown to fail on its own.
const dir = new URL('../.github/workflows/', import.meta.url);
const PIN = '11d5960a326750d5838078e36cf38b85af677262';

test('every committed workflow satisfies the policy', () => {
  const files = readdirSync(dir).filter(f => f.endsWith('.yml'));
  assert.ok(files.includes('verify.yml'));
  for (const f of files) assert.deepEqual(checkWorkflow(f, readFileSync(new URL(f, dir), 'utf8')).map(v => v.message), [], f);
});

const GOOD = `name: deploy-staging
on:
  workflow_dispatch:
    inputs:
      sha:
        required: true
permissions: {}
concurrency:
  group: case-staging
  cancel-in-progress: false
defaults:
  run:
    shell: bash
jobs:
  admit:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${PIN} # v4
        with:
          persist-credentials: false
      - run: node scripts/ci-admit-deploy.mjs
        env:
          SHA: \${{ inputs.sha }}
  deploy:
    needs: admit
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${PIN} # v4
        with:
          persist-credentials: true
      - run: npm ci --ignore-scripts
      - name: Deploy
        run: node scripts/ci-deploy.mjs --env staging
        env:
          SHA: \${{ inputs.sha }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CASE_STAGING_DEPLOY_GUARD_TOKEN: \${{ secrets.CASE_STAGING_DEPLOY_GUARD_TOKEN }}
`;

test('the compliant secret-holding fixture passes', () => {
  assert.deepEqual(checkWorkflow('deploy-staging.yml', GOOD).map(v => v.message), []);
});

const swap = (from, to) => { assert.ok(GOOD.includes(from), `fixture lacks ${from}`); return GOOD.replace(from, to); };
const DEPLOY_HEAD = `    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@${PIN} # v4\n        with:\n          persist-credentials: true`;
for (const [rule, file, make] of [
  ['top-permissions', 'deploy-staging.yml', () => swap('permissions: {}\n', '')],
  ['pinned-actions', 'deploy-staging.yml', () => swap(`actions/checkout@${PIN} # v4\n        with:\n          persist-credentials: false`, 'actions/checkout@v4\n        with:\n          persist-credentials: false')],
  ['no-pull-request-target', 'deploy-staging.yml', () => swap('  workflow_dispatch:\n', '  pull_request_target:\n  workflow_dispatch:\n')],
  ['no-secrets-key', 'deploy-staging.yml', () => swap('    needs: admit\n', '    needs: admit\n    secrets: inherit\n')],
  ['no-guard-overrides', 'deploy-staging.yml', () => swap('--env staging', '--env staging --allow-live')],
  ['no-guard-overrides', 'deploy-staging.yml', () => swap('--env staging', '--env staging --first-deploy')],
  ['no-production-dispatch', 'verify.yml', () => 'permissions: {}\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: gh workflow run deploy-production.yml -f sha=abc\n'],
  ['no-input-interpolation', 'deploy-staging.yml', () => swap('run: node scripts/ci-deploy.mjs --env staging', 'run: node scripts/ci-deploy.mjs --env staging --sha ${{ inputs.sha }}')],
  ['no-input-interpolation', 'deploy-staging.yml', () => swap('run: node scripts/ci-deploy.mjs --env staging', 'run: |\n          echo start\n          git checkout ${{ github.event.inputs.sha }}')],
  ['secret-workflows', 'verify.yml', () => GOOD],
  ['secret-names', 'deploy-staging.yml', () => swap('secrets.CASE_STAGING_DEPLOY_GUARD_TOKEN', 'secrets.CASE_LOAD_PASSWORD')],
  ['step-level-secrets', 'deploy-staging.yml', () => swap("    if: github.ref == 'refs/heads/main'\n", "    if: github.ref == 'refs/heads/main'\n    env:\n      LEAK: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n")],
  ['step-level-secrets', 'deploy-staging.yml', () => swap('defaults:\n', 'env:\n  LEAK: ${{ secrets.CLOUDFLARE_API_TOKEN }}\ndefaults:\n')],
  ['dispatch-only', 'deploy-staging.yml', () => swap('on:\n  workflow_dispatch:\n', 'on:\n  push:\n  workflow_dispatch:\n')],
  ['concurrency', 'deploy-staging.yml', () => swap('cancel-in-progress: false', 'cancel-in-progress: true')],
  ['concurrency', 'deploy-staging.yml', () => swap('group: case-staging', 'group: case-production')],
  ['staging-not-production', 'deploy-staging.yml', () => swap('--env staging', '--env production')],
  ['persist-credentials', 'deploy-staging.yml', () => swap(DEPLOY_HEAD, DEPLOY_HEAD.replace('contents: read', 'contents: write'))],
  ['hosted-runner', 'deploy-staging.yml', () => swap("    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-24.04", "    if: github.ref == 'refs/heads/main'\n    runs-on: [self-hosted, iatro-mac-1]")],
  ['main-only', 'deploy-staging.yml', () => swap("    if: github.ref == 'refs/heads/main'\n", '')],
  ['bash-shell', 'deploy-staging.yml', () => swap('defaults:\n  run:\n    shell: bash\n', '')],
  ['no-npm-cache', 'deploy-staging.yml', () => swap('      - run: npm ci --ignore-scripts', `      - uses: actions/setup-node@${PIN}\n        with:\n          cache: npm\n      - run: npm ci --ignore-scripts`)],
  ['ignore-scripts', 'deploy-staging.yml', () => swap('npm ci --ignore-scripts', 'npm ci')],
]) test(`policy rule ${rule} fails a violating workflow`, () => {
  const rules = checkWorkflow(file, make()).map(v => v.rule);
  assert.ok(rules.includes(rule), `expected ${rule}, got ${JSON.stringify(rules)}`);
});

// AUTONOMOUS-DEPLOY §2.2: Claude sessions in Case cannot start a production deploy, approve one,
// deploy or roll back with wrangler, or set a repository secret. (AGENTS.md binds every agent.)
test('Case Claude settings deny deployment approval, local deploys and secret writes (CASE-314)', () => {
  const deny = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8')).permissions?.deny ?? [];
  for (const rule of [
    // CASE-314: production dispatch is no longer denied; an agent dispatches it only for a deploy Julian authorises.
    'Bash(gh api *deploy-production*)',
    'Bash(gh api *pending_deployments*)', 'Bash(*wrangler deploy*)', 'Bash(*wrangler rollback*)', 'Bash(*wrangler secret*)',
    'Bash(*wrangler versions deploy*)', 'Bash(*npm run deploy*)', 'Bash(gh secret set*)', 'Bash(gh secret delete*)',
  ]) assert.ok(deny.includes(rule), `missing deny ${rule}`);
});
