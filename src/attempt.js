import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTree, isoFrom, truncate, versionRangeFor, bareVersion } from './util.js';

/** Apply a bump to an in-memory package.json object. Returns {section, range}. */
export function applyBumpToPkg(pkg, dep, version) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const section of sections) {
    const table = pkg[section];
    if (table && Object.prototype.hasOwnProperty.call(table, dep)) {
      const previous = table[dep];
      const range = versionRangeFor(previous, version);
      table[dep] = range;
      return { section, range, previous };
    }
  }
  return null;
}

export function applyBumpFile(packageJsonPath, dep, version) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const applied = applyBumpToPkg(pkg, dep, version);
  if (!applied) throw new Error(`${dep} not found in ${packageJsonPath}`);
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return applied;
}

function classifyResult({ code, timedOut, spawnError, output }) {
  if (spawnError) return 'error';
  if (timedOut) return 'error';
  if (Number(code) === 0) return 'pass';
  return 'fail';
}

/**
 * v0 default attempt runner (no network): copy the target tree (minus
 * node_modules/.git) into a fresh dir under os.tmpdir(), apply the bump to
 * the COPY only, run the test command there, then remove the temp dir.
 * The target repo is never written to.
 */
export function createCopyApplyAndTest({
  root,
  testCommand,
  exec,
  clock,
  tmpDir = os.tmpdir(),
  timeoutMs = 900_000,
  onWrite = null,
  keepTemp = false,
}) {
  return function applyAndTest(dep, version) {
    const start = clock.now();
    const dir = fs.mkdtempSync(path.join(tmpDir, 'dep-doctor-'));
    if (onWrite) onWrite(dir);
    let output = '';
    let kind = 'error';
    let code = null;
    let appliedRange = null;
    let spawnError = null;
    let timedOut = false;
    try {
      copyTree(root, dir);
      const applied = applyBumpFile(path.join(dir, 'package.json'), dep, version);
      appliedRange = applied.range;
      const res = exec({ command: testCommand, cwd: dir, timeoutMs });
      code = res.code ?? null;
      timedOut = !!res.timedOut || res.error === 'timeout';
      spawnError = res.error === 'spawn-failed' || res.error === 'ENOENT' ? String(res.error) : null;
      output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    } catch (e) {
      spawnError = e.message;
      output = `[attempt infrastructure error] ${e.message}`;
    }
    kind = classifyResult({ code, timedOut, spawnError, output });
    const durationMs = clock.now() - start;
    if (!keepTemp) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup; the record keeps the path for auditing
      }
    }
    return {
      ok: kind === 'pass',
      kind,
      output: truncate(output, 6000),
      tempDir: dir,
      appliedRange,
      durationMs,
      error: spawnError,
      timedOut,
    };
  };
}

/**
 * Live attempt runner (opt-in --live): git worktree in os.tmpdir() (the
 * target repo's working tree is untouched; git writes only its own metadata),
 * edit package.json, `npm install`, run tests, remove the worktree.
 */
export function createLiveApplyAndTest({
  root,
  testCommand,
  exec,
  clock,
  tmpDir = os.tmpdir(),
  timeoutMs = 900_000,
  onWrite = null,
}) {
  return function applyAndTest(dep, version) {
    const start = clock.now();
    const dir = fs.mkdtempSync(path.join(tmpDir, 'dep-doctor-live-'));
    if (onWrite) onWrite(dir);
    fs.rmSync(dir, { recursive: true, force: true }); // git worktree add wants an empty/nonexistent path
    let output = '';
    let kind = 'error';
    let code = null;
    let appliedRange = null;
    let worktreeAdded = false;
    try {
      const add = exec({ command: `git -C "${root}" worktree add --detach "${dir}" HEAD`, cwd: root, timeoutMs: 120_000 });
      if (Number(add.code) !== 0) {
        output = `[git worktree add failed]\n${add.stdout ?? ''}${add.stderr ?? ''}`;
      } else {
        worktreeAdded = true;
        const applied = applyBumpFile(path.join(dir, 'package.json'), dep, version);
        appliedRange = applied.range;
        const install = exec({ command: 'npm install --no-audit --no-fund', cwd: dir, timeoutMs });
        if (Number(install.code) !== 0) {
          output = `[npm install failed]\n${install.stdout ?? ''}${install.stderr ?? ''}`;
          kind = 'error';
        } else {
          const res = exec({ command: testCommand, cwd: dir, timeoutMs });
          code = res.code ?? null;
          const timedOut = !!res.timedOut || res.error === 'timeout';
          output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          kind = classifyResult({ code, timedOut, spawnError: null, output });
        }
      }
    } catch (e) {
      output = `[attempt infrastructure error] ${e.message}`;
      kind = 'error';
    }
    if (worktreeAdded) {
      try {
        exec({ command: `git -C "${root}" worktree remove --force "${dir}"`, cwd: root, timeoutMs: 60_000 });
        exec({ command: `git -C "${root}" worktree prune`, cwd: root, timeoutMs: 60_000 });
      } catch {
        // best effort
      }
    } else {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    return {
      ok: kind === 'pass',
      kind,
      output: truncate(output, 6000),
      tempDir: dir,
      appliedRange,
      durationMs: clock.now() - start,
      error: null,
      timedOut: false,
    };
  };
}

/**
 * Attempt loop for one dep, honoring budgets with an injected clock:
 *   - pass                       → already-green (flaky if a prior run failed)
 *   - fail (suite ran, red)      → one rerun; still red → will-break
 *   - error (couldn't run tests) → retry until attempts/minutes budget →
 *                                  needs-human (partial digest, never silent)
 */
export function attemptDep({
  entry,
  clock,
  applyAndTest,
  research,
  attemptsPerDep,
  minutesPerDep,
}) {
  const start = clock.now();
  const maxMs = minutesPerDep * 60_000;
  const attempts = [];
  let digest = null;
  let status = null;
  let reason = null;
  let observed = null;
  let failCount = 0;
  let errorCount = 0;
  let hadFail = false;
  let lastSample = start;

  for (let n = 1; n <= attemptsPerDep && !status; n++) {
    const attemptStart = clock.now();
    if (n > 1 && attemptStart - start >= maxMs) {
      status = 'needs-human';
      reason = 'minute-budget-exhausted';
      break;
    }
    const res = applyAndTest(entry.name, entry.target);
    const attemptEnd = clock.now();
    lastSample = attemptEnd;
    const record = {
      attempt: n,
      ok: !!res.ok,
      kind: res.kind ?? (res.ok ? 'pass' : 'fail'),
      startedAt: isoFrom(attemptStart),
      durationMs: res.durationMs ?? attemptEnd - attemptStart,
      tempDir: res.tempDir ?? null,
      appliedRange: res.appliedRange ?? null,
      output: truncate(res.output ?? '', 6000),
      error: res.error ?? null,
    };
    attempts.push(record);

    if (record.kind === 'pass') {
      observed = 'pass';
      status = 'already-green';
      reason = hadFail ? 'passed-on-rerun (flaky)' : 'tests-pass';
      break;
    }
    if (!digest) digest = research(entry.name, entry.from, entry.target);

    if (record.kind === 'fail') {
      observed = 'fail';
      hadFail = true;
      failCount++;
      if (failCount >= 2) {
        status = 'will-break';
        reason = 'tests-fail';
        break;
      }
    } else {
      errorCount++;
    }
  }

  if (!status) {
    const last = attempts[attempts.length - 1];
    if (failCount > 0 && last && last.kind === 'fail') {
      observed = 'fail';
      status = 'will-break';
      reason = 'tests-fail';
    } else if (attempts.length >= attemptsPerDep) {
      status = 'needs-human';
      reason = 'attempt-budget-exhausted';
    } else {
      status = 'needs-human';
      reason = 'minute-budget-exhausted';
    }
  }

  // update.majors: needs-human ⇒ human sign-off regardless of observed outcome
  if (entry.policy === 'needs-human' && entry.major && status !== 'skipped') {
    if (status !== 'needs-human') {
      status = 'needs-human';
      reason = 'update.majors=needs-human';
    } else if (!reason) {
      reason = 'update.majors=needs-human';
    }
  }

  // time actually spent on attempts (the budget-check sample that stopped the
  // loop is deliberately not counted — spent time never exceeds the budget)
  const durationMs = lastSample - start;
  return {
    name: entry.name,
    from: entry.from,
    wanted: entry.wanted,
    to: entry.target,
    major: entry.major,
    policy: entry.policy,
    status,
    observed,
    reason,
    attempts,
    attemptsUsed: attempts.length,
    durationMs,
    minutesSpent: Math.round((durationMs / 60_000) * 1000) / 1000,
    flaky: hadFail && observed === 'pass',
    digest,
    digestPartial: digest ? !digest.complete : true,
  };
}
