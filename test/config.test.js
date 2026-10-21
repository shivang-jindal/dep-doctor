import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';
import { UsageError } from '../src/errors.js';
import { SAMPLE_APP, NO_TESTS_APP, makeTempDir, rmrf, writeJson } from './support.js';

test('config: defaults when no file exists (SPEC §2 subset)', () => {
  const { config, source, warnings } = loadConfig({ root: NO_TESTS_APP });
  assert.equal(source, 'defaults');
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.ecosystems, ['npm']);
  assert.equal(config.ci.timeout, 900);
  assert.equal(config.update.majors, 'needs-human');
  assert.deepEqual(config.update.include, ['*']);
  assert.equal(config.budget['attempts-per-dep'], 3);
  assert.equal(config.budget['minutes-per-dep'], 30);
  assert.deepEqual(config.pr.labels, ['deps', 'automated']);
});

test('config: dep-doctor.config.json in the target repo is loaded', () => {
  const { config, source } = loadConfig({ root: SAMPLE_APP });
  assert.equal(source, path.join(SAMPLE_APP, 'dep-doctor.config.json'));
  assert.deepEqual(config.update.exclude, ['@acme/*']);
  assert.equal(config.update.majors, 'auto'); // fixture opts in to majors
  assert.equal(config.ci.timeout, 60);
});

test('config: flags override file values; include/exclude are additive', () => {
  const { config } = loadConfig({
    root: SAMPLE_APP,
    overrides: { testCmd: 'custom-test', attempts: 5, exclude: ['tiny-lib'], include: ['extra-pkg'] },
  });
  assert.equal(config.ci.test, 'custom-test');
  assert.equal(config.budget['attempts-per-dep'], 5);
  assert.deepEqual(config.update.exclude, ['@acme/*', 'tiny-lib']);
  assert.ok(config.update.include.includes('*'));
  assert.ok(config.update.include.includes('extra-pkg'));
});

test('config: camelCase budget keys are normalized; invalid values are usage errors', () => {
  const dir = makeTempDir('dep-doctor-config-');
  try {
    writeJson(path.join(dir, 'dep-doctor.config.json'), {
      budget: { attemptsPerDep: 7, minutesPerDep: 12 },
    });
    const { config } = loadConfig({ root: dir });
    assert.equal(config.budget['attempts-per-dep'], 7);
    assert.equal(config.budget['minutes-per-dep'], 12);

    writeJson(path.join(dir, 'dep-doctor.config.json'), { update: { majors: 'whenever' } });
    assert.throws(() => loadConfig({ root: dir }), UsageError);

    writeJson(path.join(dir, 'dep-doctor.config.json'), { budget: { 'attempts-per-dep': 0 } });
    assert.throws(() => loadConfig({ root: dir }), UsageError);

    writeJson(path.join(dir, 'dep-doctor.config.json'), { ecosystems: ['pypi'] });
    assert.throws(() => loadConfig({ root: dir }), UsageError);
  } finally {
    rmrf(dir);
  }
});

test('config: invalid JSON and missing --config path are usage errors', () => {
  const dir = makeTempDir('dep-doctor-config-');
  try {
    const bad = path.join(dir, 'dep-doctor.config.json');
    fs.writeFileSync(bad, '{ nope');
    assert.throws(() => loadConfig({ root: dir }), UsageError);
    assert.throws(() => loadConfig({ configPath: path.join(dir, 'missing.json') }), UsageError);
  } finally {
    rmrf(dir);
  }
});

test('config: defaults are frozen — tests cannot mutate shared state', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.throws(() => {
    DEFAULT_CONFIG.update.majors = 'auto';
  }, TypeError);
});
