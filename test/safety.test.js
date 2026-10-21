import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../src/run.js';
import { renderJSON, renderMarkdown, renderTerminal } from '../src/report.js';
import { hashTree } from '../src/util.js';
import {
  SAMPLE_APP,
  fixedClock,
  execStub,
  applyAndTestStub,
  makeTempDir,
  rmrf,
  readJson,
} from './support.js';

test('safety: a full run never touches the target repo; all writes land under os.tmpdir()', () => {
  const tmpBase = makeTempDir('dep-doctor-safety-'); // inside os.tmpdir()
  const outPath = path.join(tmpBase, 'report.json');
  const mdPath = path.join(tmpBase, 'report.md');
  const writes = [];
  const onWrite = (p) => writes.push(path.resolve(p));

  const before = hashTree(SAMPLE_APP); // includes node_modules — byte level
  const beforeListing = fs.readdirSync(SAMPLE_APP).sort();

  const { report, exitCode } = runDoctor(
    { root: SAMPLE_APP, outPath, mdPath },
    { onWrite, tmpDir: tmpBase },
  );

  try {
    const after = hashTree(SAMPLE_APP);
    assert.equal(after, before, 'target repo bytes are identical before/after');
    assert.deepEqual(fs.readdirSync(SAMPLE_APP).sort(), beforeListing, 'no files added or removed');

    // every write dep-doctor performed is under os.tmpdir()
    assert.ok(writes.length >= 3, `expected temp + out + md writes, saw ${writes.length}`);
    const tmpRoot = path.resolve(os.tmpdir());
    for (const w of writes) {
      assert.ok(
        w.startsWith(tmpRoot + path.sep) || w === tmpRoot,
        `write outside os.tmpdir(): ${w}`,
      );
    }

    // attempt temp dirs were cleaned up
    const attemptDirs = report.results.flatMap((r) => r.attempts.map((a) => a.tempDir).filter(Boolean));
    assert.ok(attemptDirs.length >= 2);
    for (const d of attemptDirs) {
      assert.ok(path.resolve(d).startsWith(tmpRoot + path.sep));
      assert.equal(fs.existsSync(d), false, `temp dir not cleaned: ${d}`);
    }

    // outputs were really written (into the temp workspace, not the repo)
    assert.equal(readJson(outPath).schemaVersion, 1);
    assert.match(fs.readFileSync(mdPath, 'utf8'), /## dep-doctor triage report/);

    // and the triage itself is real
    assert.equal(exitCode, 1);
    const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
    assert.equal(byName['left-pad'].status, 'already-green');
    assert.equal(byName.zod.status, 'will-break');
    assert.equal(byName['tiny-lib'].status, 'will-break');
    assert.equal(byName['@acme/ui'].status, undefined); // excluded at plan time
    assert.ok(byName.zod.digest.changelog.found, 'will-break carries the research digest');
    assert.ok(byName.zod.attempts.some((a) => /passthrough|ZodError|strict/.test(a.output)));
  } finally {
    rmrf(tmpBase);
  }
});

test('determinism: same fixtures + fixed clock → byte-identical JSON report', () => {
  const deps = () => ({
    exec: execStub((args) =>
      /git rev-parse/.test(args.command) ? { code: 0, stdout: '0badc0de4b21ac9f\n' } : { code: 0, stdout: 'ok' },
    ),
    clock: fixedClock({ start: 1_700_000_000_000 }),
    applyAndTest: applyAndTestStub({
      zod: { kind: 'fail', ok: false, output: 'ZodError: "strict" is not a valid SchemaType option' },
      'tiny-lib': { kind: 'fail', ok: false, output: 'TypeError: default padding changed' },
      'left-pad': { kind: 'pass', output: 'ok - 3 checks passed' },
    }),
  });

  const a = runDoctor({ root: SAMPLE_APP }, deps());
  const b = runDoctor({ root: SAMPLE_APP }, deps());

  const jsonA = renderJSON(a.report);
  const jsonB = renderJSON(b.report);
  assert.equal(jsonA, jsonB, 'JSON reports must be byte-identical');
  assert.equal(a.exitCode, b.exitCode);

  // frozen schema keys present
  const parsed = JSON.parse(jsonA);
  for (const key of [
    'schemaVersion',
    'tool',
    'version',
    'generatedAt',
    'root',
    'config',
    'baseline',
    'plan',
    'results',
    'budgets',
    'summary',
    'exitCode',
    'notes',
  ]) {
    assert.ok(key in parsed, `report missing ${key}`);
  }
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.baseline.sha, '0badc0de4b21ac9f');
  assert.ok(parsed.baseline.treeHash.length === 64);
  assert.deepEqual(
    { ...parsed.summary },
    { 'already-green': 1, 'will-break': 2, 'needs-human': 0, unknown: 0, skipped: 1, total: 4 },
  );
  assert.equal(parsed.budgets['attemptsPerDep'], 3);

  // markdown + terminal renderers are pure functions of the report
  const mdA = renderMarkdown(a.report);
  assert.equal(mdA, renderMarkdown(b.report));
  assert.match(mdA, /PR opening deferred in v0/);
  assert.equal(renderTerminal(a.report), renderTerminal(b.report));
});
