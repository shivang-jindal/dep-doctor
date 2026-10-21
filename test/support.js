import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE = path.dirname(HERE);
export const SRC = path.join(BASE, 'src');
export const FIXTURES = path.join(HERE, 'fixtures');
export const SAMPLE_APP = path.join(FIXTURES, 'sample-app');
export const RED_APP = path.join(FIXTURES, 'red-app');
export const AMBIGUOUS_APP = path.join(FIXTURES, 'ambiguous-app');
export const NO_TESTS_APP = path.join(FIXTURES, 'no-tests-app');

/** Fixed clock: constant time by default, optionally advancing `stepMs` per read. */
export function fixedClock({ start = 1_700_000_000_000, stepMs = 0 } = {}) {
  let now = start;
  return {
    now() {
      const v = now;
      now += stepMs;
      return v;
    },
  };
}

/** exec stub: fn({command, cwd, timeoutMs}) → {code, stdout, stderr, timedOut?} */
export function execStub(handler) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const res = typeof handler === 'function' ? handler(args, calls) : handler;
    return { code: 0, stdout: '', stderr: '', ...(res ?? {}) };
  };
  fn.calls = calls;
  return fn;
}

/** Deterministic applyAndTest stub keyed by dep name. */
export function applyAndTestStub(resultsByDep, { clock = null } = {}) {
  const calls = [];
  const fn = (dep, version) => {
    calls.push({ dep, version });
    if (clock) clock.now();
    const r = resultsByDep[dep] ?? { ok: true, kind: 'pass', output: 'ok' };
    const out = typeof r === 'function' ? r(dep, version) : r;
    return {
      ok: out.kind === 'pass',
      tempDir: path.join(os.tmpdir(), 'dep-doctor-stub', `${dep}-${version}`),
      appliedRange: `^${version}`,
      durationMs: 0,
      ...out,
    };
  };
  fn.calls = calls;
  return fn;
}

/** Fresh temp workspace strictly inside os.tmpdir() (cleaned by caller). */
export function makeTempDir(prefix = 'dep-doctor-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Read the fixture outdated snapshot (npm outdated --json shape). */
export function readOutdatedFixture(name = 'sample-app') {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'dep-doctor.outdated.json'), 'utf8'));
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}
