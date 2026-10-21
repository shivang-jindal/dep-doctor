import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { resolveTestCommand, runBaseline } from './baseline.js';
import { createOfflineFetch, createRegistryFetch } from './outdated.js';
import { buildPlan } from './plan.js';
import { attemptDep, createCopyApplyAndTest, createLiveApplyAndTest } from './attempt.js';
import { buildDigest } from './research.js';
import { SCHEMA_VERSION, renderJSON, renderMarkdown, renderTerminal, summarize } from './report.js';
import { hashTree, isFile, truncate, bareVersion, matchesAny } from './util.js';
import { UsageError } from './errors.js';

export const TOOL_VERSION = '0.1.0';

/* ------------------------- injected defaults (live) ------------------------- */

export function defaultClock() {
  return { now: () => Date.now() };
}

/** node:child_process based exec runner; every call is (command, cwd, timeout). */
export function createExec() {
  return function exec({ command, cwd, timeoutMs = 900_000 }) {
    const r = spawnSync(command, {
      shell: true,
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DEP_DOCTOR: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    if (r.error && r.error.code === 'ENOENT') {
      return { code: 127, stdout: '', stderr: String(r.error.message), error: 'spawn-failed' };
    }
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return { code: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: true, error: 'timeout' };
    }
    const timedOut = r.signal === 'SIGTERM' || r.signal === 'SIGKILL';
    return {
      code: r.status == null ? (timedOut ? null : 1) : r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      signal: r.signal ?? null,
      timedOut,
      error: r.error ? String(r.error.message) : null,
    };
  };
}

/* ------------------------------ git provenance ----------------------------- */

function readBaselineSha(root, exec) {
  try {
    const r = exec({ command: 'git rev-parse HEAD', cwd: root, timeoutMs: 15_000 });
    if (Number(r.code) === 0) {
      const sha = String(r.stdout ?? '').trim();
      if (/^[0-9a-f]{7,40}$/.test(sha)) return sha;
    }
  } catch {
    // not a git repo (or git missing) → provenance falls back to treeHash
  }
  return null;
}

/* -------------------------------- orchestrator ----------------------------- */

/**
 * Full pipeline: config → oracle resolution (usage gate) → plan → baseline →
 * attempts → report. Never writes inside `root`; every internal write goes to
 * a temp dir (reported through deps.onWrite for auditing).
 *
 * Returns { report, exitCode }. Usage problems throw UsageError (exit 2).
 */
export function runDoctor(options = {}, deps = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!isFile(path.join(root, 'package.json'))) {
    throw new UsageError(`no package.json found in ${root} — is --root a Node repo?`);
  }

  const clock = deps.clock ?? defaultClock();
  const exec = deps.exec ?? createExec();
  const onWrite = deps.onWrite ?? null;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const notes = [];

  /* 1. config */
  const { config, source: configSource, warnings } = loadConfig({
    root,
    configPath: options.configPath ?? null,
    overrides: {
      testCmd: options.testCmd ?? null,
      attempts: options.attempts ?? null,
      minutes: options.minutes ?? null,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
    },
  });
  notes.push(...warnings);

  /* 2. oracle — never guess: missing/conflicting ⇒ UsageError (exit 2) */
  const oracle = resolveTestCommand({ root, flag: options.testCmd ?? null, config });

  /* 3. outdated set */
  let fetchOutdated = deps.fetchOutdated;
  if (!fetchOutdated) {
    fetchOutdated =
      options.registry === true
        ? createRegistryFetch(exec, { timeoutMs: 300_000 })
        : createOfflineFetch({ outdatedFile: options.outdatedFile ?? null });
  }
  const fetched = fetchOutdated({ root });
  const outdated = fetched.data;

  /* 4. plan — explicit `--exclude` flags narrow the plan (those deps are
     dropped entirely); config excludes stay visible as skipped placeholders. */
  const cliExclude = Array.isArray(options.exclude) ? options.exclude : [];
  const planFilter = cliExclude.length ? [...config.update.exclude, ...cliExclude] : [];
  const planOutdated = planFilter.length
    ? Object.fromEntries(
        Object.entries(outdated).filter(([name]) => !matchesAny(planFilter, name)),
      )
    : outdated;
  const plan = buildPlan({ root, outdated: planOutdated, config, testCommand: oracle.command });
  if (plan.candidates.length === 0 && Object.keys(planOutdated).length === 0) {
    notes.push('nothing outdated — nothing to do');
  }

  const attemptsPerDep = config.budget['attempts-per-dep'];
  const minutesPerDep = config.budget['minutes-per-dep'];
  const timeoutMs = Math.max(1, Number(config.ci.timeout)) * 1000;

  const reportBase = () => ({
    schemaVersion: SCHEMA_VERSION,
    tool: 'dep-doctor',
    version: TOOL_VERSION,
    generatedAt: new Date(clock.now()).toISOString(),
    root,
    config: {
      source: configSource,
      ecosystems: config.ecosystems,
      ci: { test: config.ci.test, timeout: config.ci.timeout },
      update: {
        include: config.update.include,
        exclude: config.update.exclude,
        majors: config.update.majors,
      },
      budget: {
        'attempts-per-dep': attemptsPerDep,
        'minutes-per-dep': minutesPerDep,
      },
      pr: { labels: config.pr.labels },
    },
    notes,
  });

  /* 5. baseline — never fix on red */
  const treeHash = hashTree(root, { excludeDirs: ['node_modules', '.git'] });
  const sha = readBaselineSha(root, exec);
  const baseline = runBaseline({ root, testCommand: oracle.command, exec, clock, timeoutMs });

  if (!baseline.ok) {
    const report = {
      ...reportBase(),
      baseline: {
        ok: false,
        testCommand: oracle.command,
        testSource: oracle.source,
        sha,
        treeHash,
        startedAt: baseline.startedAt,
        durationMs: baseline.durationMs,
        timedOut: baseline.timedOut,
        output: truncate(baseline.output, 20_000),
      },
      plan: planPayload(plan, fetched),
      results: [],
      budgets: {
        attemptsPerDep,
        minutesPerDep,
        totals: { attempts: 0, minutesSpent: 0 },
      },
      summary: summarize([], plan),
      exitCode: 3,
    };
    writeOutputs(report, options, onWrite);
    return { report, exitCode: 3 };
  }

  /* 6. attempts (per candidate; budgets enforced inside attemptDep) */
  const applyAndTest =
    deps.applyAndTest ??
    (options.live
      ? createLiveApplyAndTest({ root, testCommand: oracle.command, exec, clock, tmpDir, timeoutMs, onWrite })
      : createCopyApplyAndTest({ root, testCommand: oracle.command, exec, clock, tmpDir, timeoutMs, onWrite }));

  const research =
    deps.research ??
    ((dep, from, to) => buildDigest({ root, dep, from: bareVersion(from), to }));

  const results = [];
  for (const entry of plan.entries) {
    if (entry.included) {
      results.push(
        attemptDep({
          entry,
          clock,
          applyAndTest,
          research,
          attemptsPerDep,
          minutesPerDep,
        }),
      );
    } else {
      results.push({
        name: entry.name,
        from: entry.from,
        wanted: entry.wanted,
        to: entry.target,
        major: entry.major,
        policy: entry.policy,
        status: undefined,
        observed: undefined,
        reason: entry.reason,
        attempts: [],
        attemptsUsed: 0,
        durationMs: 0,
        minutesSpent: 0,
        flaky: false,
        digest: null,
        digestPartial: true,
      });
    }
  }

  /* 7. report */
  const summary = summarize(results, plan);
  const exitCode =
    summary['will-break'] > 0 || summary['needs-human'] > 0 || summary.unknown > 0 ? 1 : 0;

  const report = {
    ...reportBase(),
    baseline: {
      ok: true,
      testCommand: oracle.command,
      testSource: oracle.source,
      sha,
      treeHash,
      startedAt: baseline.startedAt,
      durationMs: baseline.durationMs,
      timedOut: false,
      output: truncate(baseline.output, 4000),
    },
    plan: planPayload(plan, fetched),
    results,
    budgets: {
      attemptsPerDep,
      minutesPerDep,
      totals: {
        attempts: results.reduce((n, r) => n + r.attemptsUsed, 0),
        minutesSpent:
          Math.round(results.reduce((n, r) => n + r.minutesSpent, 0) * 1000) / 1000,
      },
    },
    summary,
    exitCode,
  };

  writeOutputs(report, options, onWrite);
  return { report, exitCode };
}

function planPayload(plan, fetched) {
  return {
    outdatedSource: fetched.source,
    outdatedFile: fetched.file,
    packageManager: plan.packageManager,
    lockfiles: plan.lockfiles,
    testCommand: plan.testCommand,
    entries: plan.entries,
  };
}

function writeOutputs(report, options, onWrite) {
  if (options.outPath) {
    const p = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${renderJSON(report)}\n`);
    if (onWrite) onWrite(p);
  }
  if (options.mdPath) {
    const p = path.resolve(options.mdPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${renderMarkdown(report)}\n`);
    if (onWrite) onWrite(p);
  }
}

export { renderJSON, renderMarkdown, renderTerminal };
