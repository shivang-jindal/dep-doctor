import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTestCommand, parseWorkflowTestCommands, runBaseline } from '../src/baseline.js';
import { UsageError } from '../src/errors.js';
import {
  SAMPLE_APP,
  RED_APP,
  AMBIGUOUS_APP,
  NO_TESTS_APP,
  fixedClock,
  execStub,
  makeTempDir,
  rmrf,
} from './support.js';

test('resolveTestCommand: --test-cmd flag is authoritative', () => {
  const r = resolveTestCommand({ root: NO_TESTS_APP, flag: 'custom oracle', config: { ci: { test: 'cfg' } } });
  assert.deepEqual(r, { command: 'custom oracle', source: 'flag' });
});

test('resolveTestCommand: config ci.test beats auto-detection', () => {
  const r = resolveTestCommand({ root: SAMPLE_APP, config: { ci: { test: 'pnpm test' } } });
  assert.deepEqual(r, { command: 'pnpm test', source: 'config' });
});

test('resolveTestCommand: package.json scripts.test is used when unambiguous', () => {
  const r = resolveTestCommand({ root: SAMPLE_APP, config: { ci: { test: null } } });
  assert.deepEqual(r, { command: 'node verify.js', source: 'package.json' });
});

test('resolveTestCommand: a CI workflow that wraps `test` agrees with scripts.test', () => {
  const dir = makeTempDir('dep-doctor-oracle-');
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n',
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    );
    assert.deepEqual(parseWorkflowTestCommands(dir), ['npm test']);
    const r = resolveTestCommand({ root: dir, config: { ci: { test: null } } });
    assert.deepEqual(r, { command: 'node --test', source: 'package.json' });
  } finally {
    rmrf(dir);
  }
});

test('resolveTestCommand: workflow-only repos fall back to the workflow command', () => {
  const dir = makeTempDir('dep-doctor-oracle-');
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'test.yml'),
      'name: CI\non: [push]\njobs:\n  unit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test-unit\n',
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const r = resolveTestCommand({ root: dir, config: { ci: { test: null } } });
    assert.equal(r.command, 'make test-unit');
    assert.equal(r.source, 'workflow');
  } finally {
    rmrf(dir);
  }
});

test('resolveTestCommand: CI workflow disagreeing with scripts.test → exit-2 usage error', () => {
  assert.throws(
    () => resolveTestCommand({ root: AMBIGUOUS_APP, config: { ci: { test: null } } }),
    (err) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /ambiguous test command/);
      assert.match(err.message, /node verify.js/);
      assert.match(err.message, /make check/);
      assert.match(err.message, /--test-cmd/);
      return true;
    },
  );
});

test('resolveTestCommand: no oracle anywhere → usage error, never a guess', () => {
  assert.throws(
    () => resolveTestCommand({ root: NO_TESTS_APP, config: { ci: { test: null } } }),
    (err) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /no test command detected/);
      assert.match(err.message, /refusing to guess/);
      return true;
    },
  );
});

test('runBaseline: green and red outcomes from the injected exec', () => {
  const clock = fixedClock({ stepMs: 5 });
  const green = runBaseline({
    root: SAMPLE_APP,
    testCommand: 'node verify.js',
    exec: execStub({ code: 0, stdout: 'ok - 3 checks passed' }),
    clock,
    timeoutMs: 1000,
  });
  assert.equal(green.ok, true);
  assert.equal(green.durationMs, 5);

  const red = runBaseline({
    root: RED_APP,
    testCommand: 'node verify.js',
    exec: execStub({ code: 1, stderr: 'AssertionError: expected main to be green' }),
    clock,
    timeoutMs: 1000,
  });
  assert.equal(red.ok, false);
  assert.match(red.output, /AssertionError/);

  const timedOut = runBaseline({
    root: SAMPLE_APP,
    testCommand: 'node verify.js',
    exec: execStub({ code: null, timedOut: true, stdout: 'partial' }),
    clock,
    timeoutMs: 1000,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.output, /timed out after 1s/);
});
