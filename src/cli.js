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

const EXIT_OK = 0;
const EXIT_HUMAN = 1;
const EXIT_USAGE = 2;
const EXIT_BASELINE_RED = 3;

const HELP = `dep-doctor v${TOOL_VERSION} — the upgrade bot that finishes the job (v0: triage & research)

Usage:
  dep-doctor run [options]        triage outdated deps (plan → baseline → attempt → research → report)
  dep-doctor report <file> [--format terminal|json|md]
                                  re-render a saved JSON report (exits with the report's exit code)
  dep-doctor explain --root <dir> --dep <name> --from <ver> --to <ver> [--format terminal|json]
                                  print the ResearchDigest for one upgrade (changelog range + usage sites)
  dep-doctor --help | --version

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
    } else if (opts.command == null && !opts.positional.length && ['run', 'report', 'explain'].includes(a)) {
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

function cmdRun(opts) {
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

  if (format === 'json') process.stdout.write(`${renderJSON(report)}\n`);
  else if (format === 'md') process.stdout.write(`${renderMarkdown(report)}\n`);
  else process.stdout.write(`${renderTerminal(report)}\n`);

  if (exitCode === EXIT_BASELINE_RED) {
    process.stderr.write('dep-doctor: baseline is red — fix main first, then re-run.\n');
  }
  return exitCode;
}

function cmdReport(opts) {
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
  if (format === 'json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === 'md') process.stdout.write(`${renderMarkdown(report)}\n`);
  else process.stdout.write(`${renderTerminal(report)}\n`);
  // report re-renders carry the original gate so CI can re-check cheaply
  return Number.isInteger(report.exitCode) ? report.exitCode : EXIT_OK;
}

function cmdExplain(opts) {
  const root = path.resolve(opts.root ?? process.cwd());
  if (!opts.dep) throw new UsageError('usage: dep-doctor explain --dep <name> --from <ver> --to <ver> [--root <dir>]');
  if (!opts.from || !opts.to) throw new UsageError('explain requires --from <version> and --to <version>');
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new UsageError(`no package.json found in ${root}`);
  }
  const digest = buildDigest({ root, dep: opts.dep, from: opts.from, to: opts.to });
  const format = validateFormat(opts.format);
  if (format === 'json') process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
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
    process.stdout.write(`${out.join('\n')}\n`);
  }
  return EXIT_OK;
}

function main(argv) {
  try {
    const opts = parseArgv(argv);
    if (opts.help || (opts.command == null && argv.length === 0)) {
      process.stdout.write(`${HELP}\n`);
      return EXIT_OK;
    }
    if (opts.version) {
      process.stdout.write(`dep-doctor ${TOOL_VERSION}\n`);
      return EXIT_OK;
    }
    switch (opts.command) {
      case 'run':
        return cmdRun(opts);
      case 'report':
        return cmdReport(opts);
      case 'explain':
        return cmdExplain(opts);
      default:
        throw new UsageError(`unknown command: ${opts.command ?? '(none)'} (expected run | report | explain; try --help)`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`dep-doctor: ${e.message}\n`);
      return EXIT_USAGE;
    }
    process.stderr.write(`dep-doctor: unexpected error: ${e?.stack ?? e}\n`);
    return EXIT_USAGE;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}

export { main, parseArgv, HELP };
