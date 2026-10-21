import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';
import { isFile, truncate } from './util.js';

/**
 * Commands that merely *wrap* package.json's scripts.test count as agreeing
 * with it (npm/yarn/pnpm test). Anything else that plausibly runs tests and
 * comes from CI is a competing oracle → ambiguity → exit 2.
 */
const WRAPPER_RE = /^(npm|pnpm|yarn)\s+(run\s+)?test(\s|$)/;
const CMD_TESTISH = /test|vitest|jest|mocha/i;
const CONTEXT_TESTISH = /test/i;
const BOOTSTRAP_RE =
  /^(npm\s+(ci|install|audit)|yarn(\s+(install|add|bi(b|n)liography)?)?|pnpm\s+(i|install|add)|bun\s+(install|add)|git\s+(ci|checkout|clone)|checkout|setup-|curl\b|echo\b)/i;

/** Parse .github/workflows/*.{yml,yaml} for plausible test commands. */
export function parseWorkflowTestCommands(root) {
  const dir = path.join(root, '.github', 'workflows');
  let files;
  try {
    files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const cmds = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    let inJobs = false;
    let job = '';
    let stepName = '';
    for (const rawLine of text.split(/\r?\n/)) {
      if (/^jobs:\s*$/.test(rawLine)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      const jobMatch = /^ {2}([\w.-]+):\s*$/.exec(rawLine);
      if (jobMatch) {
        job = jobMatch[1];
        stepName = '';
        continue;
      }
      const nameMatch = /^\s*(?:-\s+)?name:\s*(.+?)\s*$/.exec(rawLine);
      if (nameMatch) {
        stepName = nameMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }
      const runMatch = /^\s*(?:-\s+)?run:\s*(.+?)\s*$/.exec(rawLine);
      if (runMatch) {
        let cmd = runMatch[1].replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
        if (!cmd) continue;
        // A run: line is an oracle candidate when it looks like a test command
        // itself, or when it belongs to a test-named job/step and isn't a
        // bootstrap step (npm ci & friends are not oracles).
        const context = `${job} ${stepName}`;
        const isCandidate =
          CMD_TESTISH.test(cmd) || (CONTEXT_TESTISH.test(context) && !BOOTSTRAP_RE.test(cmd));
        if (isCandidate) cmds.push(cmd);
      }
    }
  }
  // dedupe, keep deterministic order
  return [...new Set(cmds)];
}

/**
 * Resolve the authoritative oracle. Precedence: --test-cmd flag →
 * config ci.test → package.json scripts.test → CI workflow parse.
 * Guessing the oracle is forbidden: missing or conflicting sources throw
 * UsageError (exit 2) naming every candidate found.
 */
export function resolveTestCommand({ root, flag = null, config = null }) {
  if (flag != null && String(flag).trim() !== '') {
    return { command: String(flag), source: 'flag' };
  }
  if (config?.ci?.test != null && String(config.ci.test).trim() !== '') {
    return { command: String(config.ci.test), source: 'config' };
  }

  let scriptsTest = null;
  const pkgPath = path.join(root, 'package.json');
  if (isFile(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim() !== '') {
        scriptsTest = pkg.scripts.test.trim();
      }
    } catch {
      throw new UsageError(`cannot parse ${pkgPath} — fix package.json first`);
    }
  }

  const workflowCmds = parseWorkflowTestCommands(root);
  const wrappers = workflowCmds.filter((c) => WRAPPER_RE.test(c));
  const others = workflowCmds.filter((c) => !WRAPPER_RE.test(c));

  if (scriptsTest && others.length === 0) {
    return { command: scriptsTest, source: 'package.json' };
  }
  if (!scriptsTest && workflowCmds.length === 1) {
    return { command: workflowCmds[0], source: 'workflow' };
  }
  if (!scriptsTest && workflowCmds.length > 1) {
    const distinct = [...new Set(workflowCmds)].sort();
    if (distinct.length === 1) return { command: distinct[0], source: 'workflow' };
    throw new UsageError(ambiguityMessage(distinct, [], 'multiple CI test commands disagree'));
  }
  if (scriptsTest && others.length > 0) {
    throw new UsageError(
      ambiguityMessage([scriptsTest], others, 'CI workflows disagree with package.json scripts.test'),
    );
  }
  if (!scriptsTest && wrappers.length > 0) {
    throw new UsageError(
      ambiguityMessage(wrappers, [], 'CI runs `test` but package.json has no scripts.test'),
    );
  }

  throw new UsageError(
    'no test command detected — refusing to guess the oracle (a wrong test command means false greens).\n' +
      '  Set it explicitly: dep-doctor run --test-cmd "npm test"   (or add scripts.test / ci.test in dep-doctor.config.json)',
  );
}

function ambiguityMessage(primary, secondary, why) {
  const lines = [
    `ambiguous test command: ${why}.`,
    '  Candidates:',
    ...primary.map((c) => `    - ${c}`),
    ...secondary.map((c) => `    - ${c}   (CI workflow)`),
    '  Pick one: dep-doctor run --test-cmd "<command>"',
  ];
  return lines.join('\n');
}

/** Run the oracle against the current (unmodified) tree. Never writes. */
export function runBaseline({ root, testCommand, exec, clock, timeoutMs }) {
  const start = clock.now();
  let res;
  try {
    res = exec({ command: testCommand, cwd: root, timeoutMs });
  } catch (e) {
    return {
      ok: false,
      command: testCommand,
      startedAt: new Date(start).toISOString(),
      durationMs: clock.now() - start,
      output: `[exec failed] ${e.message}`,
      timedOut: false,
    };
  }
  const timedOut = !!res.timedOut || res.error === 'timeout';
  const output = truncate(
    `${timedOut ? `[timed out after ${Math.round(timeoutMs / 1000)}s]\n` : ''}${res.stdout ?? ''}${
      res.stderr ?? ''
    }`.trim(),
    20_000,
  );
  const ok = !timedOut && Number(res.code) === 0;
  return {
    ok,
    command: testCommand,
    startedAt: new Date(start).toISOString(),
    durationMs: clock.now() - start,
    output: ok ? truncate(output, 4000) : output,
    timedOut,
    exitCode: res.code ?? null,
  };
}
