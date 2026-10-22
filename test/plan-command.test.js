import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/cli.js';
import { SAMPLE_APP, makeTempDir, rmrf, writeJson } from './support.js';

const OUTDATED = path.join(SAMPLE_APP, 'dep-doctor.outdated.json');

/** Run the CLI with injectable stdout/stderr — no globals touched. */
function run(argv) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

test('plan: sample-app snapshot → classified table rows (semver, attempts, needs-human)', () => {
  const { code, stdout, stderr } = run(['plan', '--root', SAMPLE_APP, '--outdated', OUTDATED]);
  assert.equal(code, 0);
  assert.equal(stderr, '');

  const lines = stdout.trim().split('\n');
  assert.match(lines[0], /^plan: 4 outdated dep\(s\) from /);
  assert.match(lines[1], /^dep\s+current\s+target\s+class\s+attempts\s+needs-human\s+status$/);

  const row = (name) => lines.find((l) => l.startsWith(name));
  // sample-app config: majors auto → major upgrades are attempted, not flagged
  assert.match(row('zod'), /^zod\s+3\.22\.4\s+4\.1\.0\s+major\s+3\s+no\s+unknown/);
  assert.match(row('@acme/ui'), /^@acme\/ui\s+2\.0\.0\s+2\.1\.0\s+minor\s+3\s+no\s+skipped/); // config exclude
  assert.match(row('left-pad'), /^left-pad\s+1\.0\.0\s+1\.0\.3\s+patch\s+3\s+no\s+unknown/);
  assert.match(row('tiny-lib'), /^tiny-lib\s+1\.2\.0\s+1\.2\.1\s+patch\s+3\s+no\s+unknown/);
  assert.match(
    lines.at(-1),
    /3 included · 1 excluded · 1 major · 0 needs-human · attempts budget: 3\/dep/,
  );
});

test('plan: --json parses with {deps, counts}; needs-human honors majors: needs-human default', () => {
  const dir = makeTempDir('dep-doctor-plan-');
  try {
    writeJson(path.join(dir, 'outdated.json'), {
      zod: { current: '3.22.4', wanted: '3.23.8', latest: '4.1.0' },
      'left-pad': { current: '1.0.0', wanted: '1.0.0', latest: '1.0.3' },
    });
    // no config file → defaults: majors needs-human, attempts 3
    const { code, stdout } = run(['plan', '--root', dir, '--outdated', path.join(dir, 'outdated.json'), '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.deepEqual(Object.keys(payload).sort(), ['counts', 'deps']);
    assert.deepEqual(Object.keys(payload.counts).sort(), [
      'excluded', 'included', 'major', 'needsHuman', 'total',
    ]);
    assert.equal(payload.counts.total, 2);
    assert.equal(payload.counts.major, 1);
    assert.equal(payload.counts.needsHuman, 1);

    const byName = Object.fromEntries(payload.deps.map((d) => [d.name, d]));
    assert.deepEqual(Object.keys(byName.zod).sort(), [
      'attempts', 'current', 'included', 'name', 'needsHuman', 'reason', 'semver', 'status', 'target',
    ]);
    assert.equal(byName.zod.current, '3.22.4');
    assert.equal(byName.zod.target, '4.1.0');
    assert.equal(byName.zod.semver, 'major');
    assert.equal(byName.zod.attempts, 3);
    assert.equal(byName.zod.needsHuman, true);
    assert.equal(byName['left-pad'].semver, 'patch');
    assert.equal(byName['left-pad'].needsHuman, false);
  } finally {
    rmrf(dir);
  }
});

test('plan: --exclude narrows the plan (dep dropped entirely, counts follow)', () => {
  const { code, stdout } = run([
    'plan', '--root', SAMPLE_APP, '--outdated', OUTDATED, '--exclude', 'tiny-lib', '--json',
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  // CLI --exclude drops tiny-lib; the config exclude (@acme/*) rides along in
  // the merged plan filter (same rule as `run`), so neither appears at all.
  assert.equal(payload.counts.total, 2);
  assert.deepEqual(payload.deps.map((d) => d.name), ['left-pad', 'zod']);
  assert.equal(payload.counts.excluded, 0);
});

test('plan: missing --outdated is a usage error (exit 2)', () => {
  const { code, stderr } = run(['plan', '--root', SAMPLE_APP]);
  assert.equal(code, 2);
  assert.match(stderr, /dep-doctor: plan requires --outdated/);
});
