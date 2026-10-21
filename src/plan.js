import fs from 'node:fs';
import path from 'node:path';
import { isFile, matchGlob, majorOf, bareVersion } from './util.js';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json'];

/**
 * Package-name glob matching. Unlike path globs, a bare `*` spans a whole
 * package name, so it also matches scoped names like `@acme/ui`.
 */
function matchesName(patterns, name) {
  return Array.isArray(patterns) && patterns.some((p) => p === '*' || matchGlob(p, name));
}

function firstMatch(patterns, name) {
  return (Array.isArray(patterns) ? patterns : []).find((p) => p === '*' || matchGlob(p, name));
}

/** Detect which lockfiles are present in the target repo (read-only). */
export function detectLockfiles(root) {
  const present = LOCKFILES.filter((f) => isFile(path.join(root, f)));
  const manager = present.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : present.includes('yarn.lock')
      ? 'yarn'
      : present.includes('package-lock.json') || present.includes('npm-shrinkwrap.json')
        ? 'npm'
        : null;
  return { manager, lockfiles: present };
}

/**
 * Build the upgrade plan: outdated entries → include/exclude/majors rules →
 * per-dep classification.
 *
 * Classification vocabulary (filled in by the attempt phase for pending deps):
 *   `pending`    — will be attempted (tests exist)
 *   `unknown`    — no test command available → cannot classify honestly
 *   `skipped`    — excluded by config rules (include/exclude/majors: skip)
 *
 * Outcomes after attempts: `already-green` | `will-break` | `needs-human`.
 */
export function buildPlan({ root, outdated, config, testCommand = null, pkg = null }) {
  if (!pkg && root) {
    const pkgPath = path.join(root, 'package.json');
    if (isFile(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    }
  }
  const lockfiles = detectLockfiles(root ?? process.cwd());
  const update = config.update;

  const entries = [];
  for (const name of Object.keys(outdated).sort()) {
    const { current, wanted, latest } = outdated[name];
    const target = latest || wanted || current;
    const targetMajor = majorOf(target);
    const currentMajor = majorOf(current);
    const isMajor = targetMajor != null && currentMajor != null && targetMajor > currentMajor;

    let included = true;
    let reason = 'include';
    if (matchesName(update.exclude, name)) {
      included = false;
      reason = `exclude-rule:${firstMatch(update.exclude, name)}`;
    } else if (isMajor && update.majors === 'skip') {
      included = false;
      reason = 'majors-skip';
    } else if (!matchesName(update.include, name)) {
      included = false;
      reason = `not-included:${update.include.join(',')}`;
    }

    let status;
    if (!included) status = 'skipped';
    else if (!testCommand) status = 'unknown';
    else status = 'pending';

    entries.push({
      name,
      current,
      wanted,
      target,
      from: bareVersion(current),
      major: isMajor,
      policy: isMajor ? update.majors : 'auto',
      included,
      reason,
      status,
    });
  }

  return {
    testCommand: testCommand ?? null,
    pkgName: pkg?.name ?? null,
    lockfiles: lockfiles.lockfiles,
    packageManager: lockfiles.manager,
    entries,
    candidates: entries.filter((e) => e.included),
    excluded: entries.filter((e) => !e.included),
    classification: Object.fromEntries(entries.map((e) => [e.name, e.status])),
  };
}
