import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog, findChangelog, findUsageSites, buildDigest } from '../src/research.js';
import { FIXTURES, SAMPLE_APP } from './support.js';

const multi = fs.readFileSync(path.join(FIXTURES, 'changelogs', 'multi.md'), 'utf8');

test('research: (from, to] range extraction across multiple versions', () => {
  const { versions, allVersions } = parseChangelog(multi, { from: '3.8.0', to: '4.1.0' });
  assert.deepEqual(
    versions.map((v) => v.version),
    ['3.9.0', '4.0.0', '4.0.1', '4.1.0'],
    'exclusive from, inclusive to, ascending order',
  );
  assert.ok(allVersions.includes('3.8.0'), 'allVersions still lists out-of-range entries');
  assert.ok(!versions.some((v) => v.version === '3.8.0' || v.version === '4.2.0'));
  assert.equal(versions.find((v) => v.version === '4.0.1').date, '2025-01-20');
});

test('research: BREAKING and DEPRECATION subsections are extracted', () => {
  const { versions } = parseChangelog(multi, { from: '3.8.0', to: '4.1.0' });
  const v400 = versions.find((v) => v.version === '4.0.0');
  assert.ok(v400.breaking.some((b) => b.includes('createWidget()')));
  assert.ok(v400.breaking.some((b) => b.includes('Widget.defaults')));
  assert.ok(v400.breaking.some((b) => b.includes('dropped CommonJS builds')), 'inline **BREAKING** line');
  assert.ok(v400.deprecations.some((d) => d.includes('widget.paint()')));
  const v410 = versions.find((v) => v.version === '4.1.0');
  assert.deepEqual(v410.breaking, [], 'Added sections are not breaking');
});

test('research: fixture zod changelog parses the upgrade range', () => {
  const { abs, path: rel } = findChangelog(SAMPLE_APP, 'zod');
  assert.equal(rel, path.posix.join('node_modules', 'zod', 'CHANGELOG.md'));
  const { versions } = parseChangelog(fs.readFileSync(abs, 'utf8'), { from: '3.22.4', to: '4.1.0' });
  assert.deepEqual(
    versions.map((v) => v.version),
    ['3.23.8', '4.0.0', '4.1.0'],
  );
  const v400 = versions.find((v) => v.version === '4.0.0');
  assert.ok(v400.breaking.some((b) => b.includes('passthrough')));
  assert.ok(v400.deprecations.some((d) => d.includes('.passthrough() alias')));
});

test('research: missing changelog is honest — found:false, no fake content', () => {
  assert.deepEqual(findChangelog(SAMPLE_APP, 'left-pad'), { path: null, abs: null });
  const digest = buildDigest({ root: SAMPLE_APP, dep: 'left-pad', from: '1.0.0', to: '1.0.3' });
  assert.equal(digest.changelog.found, false);
  assert.equal(digest.changelog.versions.length, 0);
  assert.equal(digest.complete, false, 'digest is partial without a changelog');
});

test('research: usage-site scanning finds paths + line numbers, no false positives', () => {
  const zod = findUsageSites(SAMPLE_APP, 'zod');
  assert.deepEqual(
    zod.sites.map((s) => `${s.file}:${s.line}`),
    ['src/api/schemas.jsx:3', 'src/usage-esm.jsx:2'],
  );
  assert.match(zod.sites[0].snippet, /require\('zod'\)/);
  assert.equal(zod.truncated, false);

  const tiny = findUsageSites(SAMPLE_APP, 'tiny-lib');
  assert.deepEqual(
    tiny.sites.map((s) => `${s.file}:${s.line}`),
    ['src/usage-esm.jsx:3', 'src/usage-esm.jsx:4'],
    'subpath imports (tiny-lib/sub) count too',
  );

  // `zodish` must never match a scan for `zod`
  const allLines = fs.readFileSync(path.join(SAMPLE_APP, 'src', 'usage-esm.jsx'), 'utf8').split(/\r?\n/);
  const zodishLine = allLines.findIndex((l) => l.includes('zodish')) + 1;
  assert.ok(zodishLine > 0);
  assert.ok(!zod.some((s) => s.file === 'src/usage-esm.jsx' && s.line === zodishLine));
});

test('research: usage-site cap marks truncation', () => {
  const capped = findUsageSites(SAMPLE_APP, 'tiny-lib', { cap: 1 });
  assert.equal(capped.sites.length, 1);
  assert.equal(capped.truncated, true);
});

test('research: full digest for zod 3.22.4 → 4.1.0 is complete and explains the break', () => {
  const digest = buildDigest({ root: SAMPLE_APP, dep: 'zod', from: '3.22.4', to: '4.1.0' });
  assert.equal(digest.complete, true);
  assert.equal(digest.changelog.releasesInRange, 3);
  assert.ok(digest.changelog.versions.some((v) => v.version === '4.0.0' && v.breaking.length > 0));
  assert.ok(digest.usage.count >= 2);
  assert.equal(digest.from, '3.22.4');
  assert.equal(digest.to, '4.1.0');
});
