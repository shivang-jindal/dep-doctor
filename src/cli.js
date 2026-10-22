#!/usr/bin/env node
/**
 * dep-doctor v0 CLI — exit codes:
 *   0 ok · 1 human-action-needed · 2 usage · 3 baseline red
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.js';
import { runDoctor, TOOL_VERSION, renderJSON, renderMarkdown, renderTerminal } from './run.js';
import { buildDigest } from './research.js';
import { SCHEMA_VERSION } from './report.js';
import { loadConfig } from './config.js';
import { createOfflineFetch } from './outdated.js';
import { buildPlan } from './plan.js';
import { parseSemver, bareVersion, matchesAny } from './util.js';

const EXIT_OK = 0;
const EXIT_HUMAN = 1;
const EXIT_USAGE = 2;
const EXIT_BASELINE_RED = 3;

const HELP = `dep-doctor v${TOOL_VERSION} — the upgrade bot that finishes the job (v0: triage & research)

Usage:
  dep-doctor run [options]        triage outdated deps (plan → baseline → attempt → research → report)
  dep-doctor plan --outdated <file> [--json]
                                  planning phase only: classify each outdated dep (no baseline, no attempts)
  dep-doctor report <file> [--format terminal|json|md]
                                  re-render a saved JSON report (exits with the report's exit code)
  dep-doctor explain --root <dir> --dep <name> --from <ver> --to <ver> [--format terminal|json]
                                  print the ResearchDigest for one upgrade (changelog range + usage sites)
  dep-doctor --help | --version

plan options (planning phase only — never installs, never runs tests):
  --root <dir>          target repo (default: cwd)
  --config <file>       JSON config (default: <root>/dep-doctor.config.json; see SPEC §2 subset)
  --outdated <file>     outdated snapshot file (required; \`npm outdated --json\` shape)
  --test-cmd <cmd>      oracle hint: marks testable candidates \`pending\` instead of \`unknown\`
  --attempts <n>        override budget["attempts-per-dep"]
  --include <glob>      add an include rule (repeatable)
  --exclude <glob>      add an exclude rule (repeatable)
  --json                machine-readable output ({deps, counts}) instead of a table

run options:
  --root <dir>          target repo (default: cwd)
  --config <file>       JSON config (default: <root>/dep-doctor.config.json; see SPEC §2 subset)
  --test-cmd <cmd>      authoritative test oracle (required when detection is ambiguous)
  --offline             (default) read a local outdated snapshot; never touches the network
  --registry            live \`npm outdated --json\` (network; off by default)
  --outdated <file>     outdated snapshot file (default: <root>/dep-doctor.outdated.json)
  --live                attempt runner: git worktree + npm install (network; default is temp-copy)
  --attempts <n>        override budget["attempts-per-dep"]
  --minutes <n>         override budget["minutes-per-dep"]
  --include <glob>      add an include rule (repeatable)
  --exclude <glob>      add an exclude rule (repeatable)
  --format <terminal|json>   stdout format (default: terminal)
  --out <file>          write the JSON report to a file
  --md <file>           write a Markdown report (tracking-issue friendly)

Exit codes: 0 ok · 1 human action needed · 2 usage · 3 baseline red
Invariant:  never fixes on red, never writes inside the target repo, explains everything.`;

function parseArgv(argv) {
  const opts = { command: null, positional: [], include: [], exclude: [] };
  const takesValue = new Set([
    '--root', '--config', '--test-cmd', '--outdated', '--attempts', '--minutes',
    '--format', '--out', '--md', '--dep', '--from', '--to', '--include', '--exclude',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--registry') opts.registry = true;
    else if (a === '--live') opts.live = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) {
      const key = a;
      if (!takesValue.has(key)) throw new UsageError(`unknown option: ${a} (try --help)`);
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${a}`);
      switch (key) {
        case '--root': opts.root = value; break;
        case '--config': opts.configPath = value; break;
        case '--test-cmd': opts.testCmd = value; break;
        case '--outdated': opts.outdatedFile = value; break;
        case '--include': opts.include.push(value); break;
        case '--exclude': opts.exclude.push(value); break;
        case '--attempts': opts.attempts = toPositiveInt(value, '--attempts'); break;
        case '--minutes': opts.minutes = toPositiveNumber(value, '--minutes'); break;
        case '--format': opts.format = value; break;
        case '--out': opts.outPath = value; break;
        case '--md': opts.mdPath = value; break;
        case '--dep': opts.dep = value; break;
        case '--from': opts.from = value; break;
        case '--to': opts.to = value; break;
        default: throw new UsageError(`unknown option: ${a}`);
      }
    } else if (opts.command == null && !opts.positional.length && ['run', 'report', 'explain', 'plan'].includes(a)) {
      opts.command = a;
    } else {
      opts.positional.push(a);
    }
  }
  return opts;
}

function toPositiveInt(v, flag) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be an integer >= 1`);
  return n;
}
function toPositiveNumber(v, flag) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
  return n;
}

function validateFormat(format) {
  const f = format ?? 'terminal';
  if (!['terminal', 'json', 'md'].includes(f)) {
    throw new UsageError(`unknown --format "${f}" (expected terminal | json | md)`);
  }
  return f;
}

/** Semver class of an upgrade: major | minor | patch | none | unknown. */
function semverClass(current, target) {
  const a = parseSemver(bareVersion(current));
  const b = parseSemver(bareVersion(target));
  if (!a || !b) return 'unknown';
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  if (b.patch !== a.patch) return 'patch';
  return 'none';
}

/**
 * `plan` — the planning phase only: parse the outdated snapshot, classify
 * semver, apply include/exclude/majors rules and budgets. Never installs,
 * never runs tests, never writes.
 */
function cmdPlan(opts, io) {
  const root = path.resolve(opts.root ?? process.cwd());
  if (!opts.outdatedFile) {
    throw new UsageError(
      'plan requires --outdated <file> (an `npm outdated --json` snapshot; planning never touches the network)',
    );
  }
  const { config } = loadConfig({
    root,
    configPath: opts.configPath ?? null,
    overrides: {
      testCmd: opts.testCmd ?? null,
      attempts: opts.attempts ?? null,
      include: opts.include ?? [],
      exclude: opts.exclude ?? [],
    },
  });

  const fetched = createOfflineFetch({ outdatedFile: opts.outdatedFile })({ root });
  const outdated = fetched.data;

  // same CLI-exclude narrowing as `run`: explicit --exclude drops the dep
  // entirely; config excludes stay visible as skipped placeholders.
  const cliExclude = Array.isArray(opts.exclude) ? opts.exclude : [];
  const planFilter = cliExclude.length ? [...config.update.exclude, ...cliExclude] : [];
  const planOutdated = planFilter.length
    ? Object.fromEntries(
        Object.entries(outdated).filter(([name]) => !matchesAny(planFilter, name)),
      )
    : outdated;
  const plan = buildPlan({
    root,
    outdated: planOutdated,
    config,
    testCommand: opts.testCmd ?? config.ci.test ?? null,
  });

  const attemptsPerDep = config.budget['attempts-per-dep'];
  const deps = plan.entries.map((e) => ({
    name: e.name,
    current: bareVersion(e.current),
    target: e.target,
    semver: semverClass(e.current, e.target),
    attempts: attemptsPerDep,
    needsHuman: e.included && e.policy === 'needs-human',
    included: e.included,
    reason: e.reason,
    status: e.status,
  }));
  const counts = {
    total: deps.length,
    included: deps.filter((d) => d.included).length,
    excluded: deps.filter((d) => !d.included).length,
    major: deps.filter((d) => d.semver === 'major').length,
    needsHuman: deps.filter((d) => d.needsHuman).length,
  };

  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ deps, counts }, null, 2)}\n`);
    return EXIT_OK;
  }

  const headers = ['dep', 'current', 'target', 'class', 'attempts', 'needs-human', 'status'];
  const rows = deps.map((d) => [
    d.name,
    d.current,
    d.target,
    d.semver,
    String(d.attempts),
    d.needsHuman ? 'yes' : 'no',
    d.status,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [
    `plan: ${deps.length} outdated dep(s) from ${fetched.file}`,
    line(headers),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    `${counts.included} included · ${counts.excluded} excluded · ${counts.major} major · ${counts.needsHuman} needs-human · attempts budget: ${attemptsPerDep}/dep`,
  ];
  io.stdout.write(`${out.join('\n')}\n`);
  return EXIT_OK;
}

function cmdRun(opts, io) {
  const format = validateFormat(opts.format);
  const { report, exitCode } = runDoctor({
    root: opts.root ?? process.cwd(),
    configPath: opts.configPath ?? null,
    testCmd: opts.testCmd ?? null,
    registry: !!opts.registry,
    outdatedFile: opts.outdatedFile ?? null,
    live: !!opts.live,
    attempts: opts.attempts ?? null,
    minutes: opts.minutes ?? null,
    include: opts.include,
    exclude: opts.exclude,
    outPath: opts.outPath ?? null,
    mdPath: opts.mdPath ?? null,
  });

  if (format === 'json') io.stdout.write(`${renderJSON(report)}\n`);
  else if (format === 'md') io.stdout.write(`${renderMarkdown(report)}\n`);
  else io.stdout.write(`${renderTerminal(report)}\n`);

  if (exitCode === EXIT_BASELINE_RED) {
    io.stderr.write('dep-doctor: baseline is red — fix main first, then re-run.\n');
  }
  return exitCode;
}

function cmdReport(opts, io) {
  const file = opts.positional[0];
  if (!file) throw new UsageError('usage: dep-doctor report <file.json> [--format terminal|json|md]');
  if (!fs.existsSync(file)) throw new UsageError(`report file not found: ${file}`);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`report file is not valid JSON: ${e.message}`);
  }
  if (report?.schemaVersion !== SCHEMA_VERSION) {
    throw new UsageError(`unsupported report schemaVersion: ${report?.schemaVersion} (expected ${SCHEMA_VERSION})`);
  }
  const format = validateFormat(opts.format);
  if (format === 'json') io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === 'md') io.stdout.write(`${renderMarkdown(report)}\n`);
  else io.stdout.write(`${renderTerminal(report)}\n`);
  // report re-renders carry the original gate so CI can re-check cheaply
  return Number.isInteger(report.exitCode) ? report.exitCode : EXIT_OK;
}

function cmdExplain(opts, io) {
  const root = path.resolve(opts.root ?? process.cwd());
  if (!opts.dep) throw new UsageError('usage: dep-doctor explain --dep <name> --from <ver> --to <ver> [--root <dir>]');
  if (!opts.from || !opts.to) throw new UsageError('explain requires --from <version> and --to <version>');
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new UsageError(`no package.json found in ${root}`);
  }
  const digest = buildDigest({ root, dep: opts.dep, from: opts.from, to: opts.to });
  const format = validateFormat(opts.format);
  if (format === 'json') io.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
  else {
    const out = [];
    out.push(`ResearchDigest: ${digest.dep} ${digest.from} → ${digest.to} (${digest.complete ? 'complete' : 'partial'})`);
    if (digest.changelog.found) {
      out.push(`changelog: ${digest.changelog.path} — ${digest.changelog.releasesInRange} release(s) in (${digest.from}, ${digest.to}]`);
      for (const v of digest.changelog.versions) {
        out.push(`  ## ${v.version}${v.date ? ` — ${v.date}` : ''}`);
        for (const b of v.breaking) out.push(`    BREAKING: ${b}`);
        for (const d of v.deprecations) out.push(`    DEPRECATED: ${d}`);
        if (!v.breaking.length && !v.deprecations.length) for (const n of v.notes.slice(0, 3)) out.push(`    ${n}`);
      }
    } else {
      out.push(`changelog: not found (partial digest)`);
    }
    out.push(`usage sites: ${digest.usage.count}${digest.usage.truncated ? '+' : ''} in ${digest.usage.scannedFiles} scanned file(s)`);
    for (const s of digest.usage.sites) out.push(`  ${s.file}:${s.line}  ${s.snippet}`);
    io.stdout.write(`${out.join('\n')}\n`);
  }
  return EXIT_OK;
}

/**
 * CLI entry. `deps.stdout` / `deps.stderr` are injectable write streams
 * (default: process.stdout/stderr) so tests capture output without
 * monkey-patching globals.
 */
function main(argv, deps = {}) {
  const io = {
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
  };
  try {
    const opts = parseArgv(argv);
    if (opts.help || (opts.command == null && argv.length === 0)) {
      io.stdout.write(`${HELP}\n`);
      return EXIT_OK;
    }
    if (opts.version) {
      io.stdout.write(`dep-doctor ${TOOL_VERSION}\n`);
      return EXIT_OK;
    }
    switch (opts.command) {
      case 'run':
        return cmdRun(opts, io);
      case 'plan':
        return cmdPlan(opts, io);
      case 'report':
        return cmdReport(opts, io);
      case 'explain':
        return cmdExplain(opts, io);
      default:
        throw new UsageError(`unknown command: ${opts.command ?? '(none)'} (expected run | plan | report | explain; try --help)`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`dep-doctor: ${e.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr.write(`dep-doctor: unexpected error: ${e?.stack ?? e}\n`);
    return EXIT_USAGE;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}

export { main, parseArgv, HELP };
