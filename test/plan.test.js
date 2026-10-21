import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPlan, detectLockfiles } from '../src/plan.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SAMPLE_APP, readOutdatedFixture, makeTempDir, rmrf, writeJson } from './support.js';

const outdated = readOutdatedFixture('sample-app');

function cfg(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    update: { ...DEFAULT_CONFIG.update, ...(overrides.update ?? {}) },
    budget: { ...DEFAULT_CONFIG.budget, ...(overrides.budget ?? {}) },
  };
}

test('plan: fixture package.json + outdated JSON → correct classification incl. exclude rules', () => {
  const plan = buildPlan({
    root: SAMPLE_APP,
    outdated,
    config: cfg({ update: { exclude: ['@acme/*', 'left-pad'], majors: 'auto' } }),
    testCommand: 'node verify.js',
  });

  // excluded by rules
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName['@acme/ui'].status, 'skipped');
  assert.equal(byName['@acme/ui'].reason, 'exclude-rule:@acme/*');
  assert.equal(byName['left-pad'].status, 'skipped');
  assert.equal(byName['left-pad'].reason, 'exclude-rule:left-pad');

  // candidates stay pending with an oracle present
  for (const name of ['zod', 'tiny-lib']) {
    assert.equal(byName[name].status, 'pending', `${name} should be pending`);
    assert.equal(byName[name].included, true);
  }

  assert.equal(plan.candidates.length, 2);
  assert.equal(plan.excluded.length, 2);
  assert.equal(plan.testCommand, 'node verify.js');
  // deterministic ordering
  assert.deepEqual(
    plan.entries.map((e) => e.name),
    ['@acme/ui', 'left-pad', 'tiny-lib', 'zod'],
  );
});

test('plan: classification is `unknown` when there is no test command', () => {
  const plan = buildPlan({ root: SAMPLE_APP, outdated, config: cfg(), testCommand: null });
  assert.equal(plan.testCommand, null);
  assert.deepEqual(plan.classification, {
    '@acme/ui': 'unknown',
    'left-pad': 'unknown',
    'tiny-lib': 'unknown',
    zod: 'unknown',
  });
  assert.ok(plan.candidates.every((e) => e.status === 'unknown'));
});

test('plan: include rules narrow the set; majors: skip drops major bumps', () => {
  const plan = buildPlan({
    root: SAMPLE_APP,
    outdated,
    config: cfg({ update: { include: ['tiny-lib', 'left-pad'], exclude: [], majors: 'skip' } }),
    testCommand: 'node verify.js',
  });
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName.zod.status, 'skipped');
  assert.equal(byName.zod.reason, 'majors-skip'); // 3.22.4 → 4.1.0 is a major
  assert.equal(byName['tiny-lib'].status, 'pending');
  assert.equal(byName['@acme/ui'].status, 'skipped');
  assert.equal(byName['@acme/ui'].reason, 'not-included:tiny-lib,left-pad');
  assert.equal(byName['left-pad'].status, 'pending');
});

test('plan: target version, major flag and policy per entry', () => {
  const plan = buildPlan({
    root: SAMPLE_APP,
    outdated,
    config: cfg({ update: { majors: 'needs-human' } }),
    testCommand: 'node verify.js',
  });
  const byName = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
  assert.equal(byName.zod.target, '4.1.0');
  assert.equal(byName.zod.major, true);
  assert.equal(byName.zod.policy, 'needs-human');
  assert.equal(byName['tiny-lib'].target, '1.2.1');
  assert.equal(byName['tiny-lib'].major, false);
  assert.equal(byName['tiny-lib'].policy, 'auto');
  assert.equal(byName['left-pad'].target, '1.0.3');
});

test('plan: lockfile detection (read-only)', () => {
  assert.deepEqual(detectLockfiles(SAMPLE_APP), { manager: null, lockfiles: [] });
  const dir = makeTempDir('dep-doctor-lock-');
  try {
    writeJson(path.join(dir, 'package.json'), { name: 'x' });
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert.deepEqual(detectLockfiles(dir), { manager: 'pnpm', lockfiles: ['pnpm-lock.yaml'] });
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
    assert.deepEqual(detectLockfiles(dir).lockfiles.sort(), ['pnpm-lock.yaml', 'yarn.lock']);
    assert.equal(detectLockfiles(dir).manager, 'pnpm');
  } finally {
    rmrf(dir);
  }
});
