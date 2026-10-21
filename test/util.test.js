import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareSemver,
  parseSemver,
  majorOf,
  versionRangeFor,
  matchGlob,
  matchesAny,
  hashTree,
  truncate,
} from '../src/util.js';
import { makeTempDir, rmrf } from './support.js';

test('compareSemver orders releases and prereleases', () => {
  assert.ok(compareSemver('1.2.3', '1.2.4') < 0);
  assert.ok(compareSemver('1.10.0', '1.9.0') < 0); // numeric, not lexicographic
  assert.ok(compareSemver('2.0.0', '10.0.0') > 0);
  assert.equal(compareSemver('4.1.0', '4.1.0'), 0);
  assert.ok(compareSemver('4.0.0-rc.1', '4.0.0') < 0);
  assert.ok(compareSemver('4.0.0-alpha', '4.0.0-beta') < 0);
  assert.ok(compareSemver('4.0.0', '4.0.0-rc.1') > 0);
});

test('parseSemver and majorOf handle range-ish strings', () => {
  assert.deepEqual(parseSemver('v3.22.4'), { major: 3, minor: 22, patch: 4, prerelease: [] });
  assert.equal(parseSemver('latest'), null);
  assert.equal(majorOf('^4.1.0'), 4);
  assert.equal(majorOf('~1.2'), 1);
  assert.equal(majorOf('>=3.0.0'), 3);
  assert.equal(majorOf('workspace:*'), null);
});

test('versionRangeFor preserves ^ and ~ prefixes, otherwise pins', () => {
  assert.equal(versionRangeFor('^3.22.4', '4.1.0'), '^4.1.0');
  assert.equal(versionRangeFor('~1.2.0', '1.2.1'), '~1.2.1');
  assert.equal(versionRangeFor('1.0.0', '1.0.3'), '1.0.3');
});

test('glob matching: * stays within a path segment, ** crosses segments', () => {
  assert.ok(matchGlob('@acme/*', '@acme/ui'));
  assert.ok(!matchGlob('@acme/*', '@acme/ui/deep'));
  assert.ok(matchGlob('@acme/**', '@acme/ui/deep'));
  assert.ok(matchGlob('left-pad', 'left-pad'));
  assert.ok(!matchGlob('left-pad', 'left-pad-2'));
  assert.ok(matchGlob('*', 'anything'));
  assert.ok(matchesAny(['@acme/*', 'left-pad'], 'left-pad'));
  assert.ok(!matchesAny(['@acme/*', 'left-pad'], 'zod'));
});

test('hashTree is deterministic and changes when content changes', () => {
  const dir = makeTempDir('dep-doctor-hash-');
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'beta');
    const h1 = hashTree(dir);
    const h2 = hashTree(dir);
    assert.equal(h1, h2);
    const hNoSrc = hashTree(dir, { excludeDirs: ['src'] });
    assert.notEqual(hNoSrc, h1);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha!');
    assert.notEqual(hashTree(dir), h1);
  } finally {
    rmrf(dir);
  }
});

test('truncate keeps output bounded with an explicit marker', () => {
  assert.equal(truncate('short', 100), 'short');
  const t = truncate('x'.repeat(50), 10);
  assert.ok(t.length < 50);
  assert.match(t, /\[truncated 40 chars\]/);
});
