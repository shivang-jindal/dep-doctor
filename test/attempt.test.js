import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptDep } from '../src/attempt.js';
import { runDoctor } from '../src/run.js';
import { buildDigest } from '../src/research.js';
import {
  SAMPLE_APP,
  fixedClock,
  execStub,
  applyAndTestStub,
} from './support.js';

const entry = (over = {}) => ({
  name: 'zod',
  from: '3.22.4',
  wanted: '3.23.8',
  target: '4.1.0',
  major: true,
  policy: 'auto',
  ...over,
});

const researchStub = (dep, from, to) => ({
  dep,
  from,
  to,
  changelog: { found: false, path: null, releasesInRange: 0, versions: [] },
  usage: { sites: [], count: 0, truncated: false, scannedFiles: 3 },
  complete: false,
});

test('attempt: a green bump is already-green after one attempt', () => {
  const r = attemptDep({
    entry: entry({ major: false }),
    clock: fixedClock(),
    applyAndTest: applyAndTestStub({ zod: { kind: 'pass', output: 'ok' } }),
    research: researchStub,
    attemptsPerDep: 3,
    minutesPerDep: 30,
  });
  assert.equal(r.status, 'already-green');
  assert.equal(r.observed, 'pass');
  assert.equal(r.attemptsUsed, 1);
  assert.equal(r.reason, 'tests-pass');
  assert.equal(r.digest, null); // research only runs on failure
  assert.equal(r.flaky, false);
});

test('attempt: tests fail → will-break (one rerun for flakiness), digest attached', () => {
  const r = attemptDep({
    entry: entry(),
    clock: fixedClock(),
    applyAndTest: applyAndTestStub({ zod: { kind: 'fail', ok: false, output: 'ZodError: strict' } }),
    research: researchStub,
    attemptsPerDep: 3,
    minutesPerDep: 30,
  });
  assert.equal(r.status, 'will-break');
  assert.equal(r.reason, 'tests-fail');
  assert.equal(r.attemptsUsed, 2); // fail + single flakiness rerun
  assert.ok(r.digest, 'digest attached to a will-break result');
  assert.equal(r.digest.dep, 'zod');
  assert.equal(r.observed, 'fail');
  assert.equal(r.flaky, false);
});

test('attempt: fail-then-pass counts as flaky but lands already-green', () => {
  let n = 0;
  const r = attemptDep({
    entry: entry({ major: false }),
    clock: fixedClock(),
    applyAndTest: () => (++n === 1 ? { kind: 'fail', ok: false, output: 'flake' } : { kind: 'pass', ok: true, output: 'ok' }),
    research: researchStub,
    attemptsPerDep: 3,
    minutesPerDep: 30,
  });
  assert.equal(r.status, 'already-green');
  assert.equal(r.attemptsUsed, 2);
  assert.equal(r.flaky, true);
  assert.equal(r.reason, 'passed-on-rerun (flaky)');
});

test('attempt: with attempts-per-dep 1 a single red run is conclusive', () => {
  const r = attemptDep({
    entry: entry(),
    clock: fixedClock(),
    applyAndTest: applyAndTestStub({ zod: { kind: 'fail', ok: false, output: 'red' } }),
    research: researchStub,
    attemptsPerDep: 1,
    minutesPerDep: 30,
  });
  assert.equal(r.status, 'will-break');
  assert.equal(r.attemptsUsed, 1);
});

test('attempt: update.majors=needs-human forces the outcome even when green', () => {
  const r = attemptDep({
    entry: entry({ policy: 'needs-human' }),
    clock: fixedClock(),
    applyAndTest: applyAndTestStub({ zod: { kind: 'pass', output: 'ok' } }),
    research: researchStub,
    attemptsPerDep: 3,
    minutesPerDep: 30,
  });
  assert.equal(r.status, 'needs-human');
  assert.equal(r.reason, 'update.majors=needs-human');
  assert.equal(r.observed, 'pass'); // evidence preserved for the human
});

test('attempt: minutes budget stops the loop with needs-human', () => {
  // clock advances 5 minutes per sample; attemptDep samples twice per attempt
  // (start/end) plus one before each retry → attempt 4 would start at 35min.
  const r = attemptDep({
    entry: entry({ major: false }),
    clock: fixedClock({ stepMs: 5 * 60_000 }),
    applyAndTest: applyAndTestStub({ zod: { kind: 'error', ok: false, output: 'spawn failed' } }),
    research: researchStub,
    attemptsPerDep: 10,
    minutesPerDep: 30,
  });
  assert.equal(r.status, 'needs-human');
  assert.equal(r.reason, 'minute-budget-exhausted');
  assert.equal(r.attemptsUsed, 3);
  assert.ok(r.minutesSpent <= 30);
});

test('runDoctor: fixture that never succeeds stops at the attempts budget with needs-human + partial digest', () => {
  const { report, exitCode } = runDoctor(
    {
      root: SAMPLE_APP,
      // isolate the budget fixture on left-pad (which has no changelog)
      exclude: ['zod', 'tiny-lib'],
    },
    {
      exec: execStub({ code: 0, stdout: 'ok - baseline' }),
      clock: fixedClock(),
      applyAndTest: applyAndTestStub({
        'left-pad': { kind: 'error', ok: false, output: 'attempt never succeeds' },
      }),
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(report.results.length, 1);
  const [res] = report.results;
  assert.equal(res.name, 'left-pad');
  assert.equal(res.status, 'needs-human');
  assert.equal(res.reason, 'attempt-budget-exhausted');
  assert.equal(res.attemptsUsed, 3); // attempts-per-dep budget honored
  assert.equal(report.budgets.totals.attempts, 3);
  assert.equal(report.baseline.ok, true);
  assert.ok(res.digest, 'partial digest still attached');
  assert.equal(res.digest.complete, false);
  assert.equal(res.digestPartial, true);
  assert.equal(res.digest.changelog.found, false); // left-pad ships no CHANGELOG
});
