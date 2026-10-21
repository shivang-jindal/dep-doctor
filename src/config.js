import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';
import { pathExists } from './util.js';

/**
 * v0 config: JSON only (`.dep-doctor.yml` is SPEC §2, deferred — see README
 * "v0 status"). Same field names as the SPEC YAML subset.
 */
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

export const DEFAULT_CONFIG = deepFreeze({
  version: 1,
  ecosystems: ['npm'],
  ci: { test: null, timeout: 900 },
  update: { include: ['*'], exclude: [], majors: 'needs-human' },
  budget: { 'attempts-per-dep': 3, 'minutes-per-dep': 30 },
  pr: { labels: ['deps', 'automated'], draft: true },
});

const MAJORS_VALUES = new Set(['auto', 'needs-human', 'skip']);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

function deepMerge(base, extra) {
  const out = clone(base);
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) continue;
    if (v === null) {
      out[k] = null;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v;
    } else if (typeof v === 'object' && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const BUDGET_KEYS = [
  ['attemptsPerDep', 'attempts-per-dep'],
  ['minutesPerDep', 'minutes-per-dep'],
  ['tokensPerDep', 'tokens-per-dep'],
];

function normalizeBudget(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const b = { ...raw };
  for (const [camel, kebab] of BUDGET_KEYS) {
    if (!(kebab in b) && camel in b) b[kebab] = b[camel];
    delete b[camel];
  }
  return b;
}

function validate(config) {
  if (!Array.isArray(config.ecosystems) || config.ecosystems.length === 0) {
    throw new UsageError('config: "ecosystems" must be a non-empty array (v0 supports: npm)');
  }
  for (const eco of config.ecosystems) {
    if (eco !== 'npm') throw new UsageError(`config: unsupported ecosystem "${eco}" in v0 (only npm)`);
  }
  if (config.ci.test != null && typeof config.ci.test !== 'string') {
    throw new UsageError('config: ci.test must be a string command or null');
  }
  if (typeof config.ci.timeout !== 'number' || config.ci.timeout <= 0) {
    throw new UsageError('config: ci.timeout must be a positive number of seconds');
  }
  if (!Array.isArray(config.update.include) || !Array.isArray(config.update.exclude)) {
    throw new UsageError('config: update.include / update.exclude must be arrays of glob patterns');
  }
  if (!MAJORS_VALUES.has(config.update.majors)) {
    throw new UsageError('config: update.majors must be one of auto | needs-human | skip');
  }
  const attempts = config.budget['attempts-per-dep'];
  const minutes = config.budget['minutes-per-dep'];
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new UsageError('config: budget["attempts-per-dep"] must be an integer >= 1');
  }
  if (typeof minutes !== 'number' || minutes <= 0) {
    throw new UsageError('config: budget["minutes-per-dep"] must be a positive number');
  }
  if (!Array.isArray(config.pr.labels) || config.pr.labels.some((l) => typeof l !== 'string')) {
    throw new UsageError('config: pr.labels must be an array of strings');
  }
  return config;
}

/**
 * Load `dep-doctor.config.json` (or --config), merge over defaults, apply
 * flag overrides, validate. Never guesses — bad config is a usage error (2).
 */
export function loadConfig({ root, configPath = null, overrides = {} } = {}) {
  const warnings = [];
  let source = 'defaults';

  let raw = {};
  let resolvedPath = null;
  if (configPath) {
    resolvedPath = configPath;
    if (!isFileSafe(configPath)) throw new UsageError(`config file not found: ${configPath}`);
  } else if (root) {
    const candidate = path.join(root, 'dep-doctor.config.json');
    if (pathExists(candidate)) {
      resolvedPath = candidate;
      source = candidate;
    }
  }

  if (resolvedPath) {
    let text;
    try {
      text = fs.readFileSync(resolvedPath, 'utf8');
    } catch (e) {
      throw new UsageError(`config: cannot read ${resolvedPath}: ${e.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`config: ${resolvedPath} is not valid JSON: ${e.message}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UsageError(`config: ${resolvedPath} must contain a JSON object`);
    }
    source = resolvedPath;
  }

  if (root && !configPath && pathExists(path.join(root, '.dep-doctor.yml')) && !resolvedPath) {
    warnings.push(
      'found .dep-doctor.yml but v0 reads JSON only — create dep-doctor.config.json (see README "v0 status")',
    );
  }

  const merged = deepMerge(DEFAULT_CONFIG, {
    ...raw,
    budget: normalizeBudget(raw.budget ?? {}),
  });

  // flag overrides (highest precedence)
  const ov = { ...overrides };
  if (ov.testCmd != null) merged.ci = { ...merged.ci, test: ov.testCmd };
  if (ov.attempts != null) merged.budget = { ...merged.budget, 'attempts-per-dep': ov.attempts };
  if (ov.minutes != null) merged.budget = { ...merged.budget, 'minutes-per-dep': ov.minutes };
  if (ov.include && ov.include.length) merged.update = { ...merged.update, include: [...merged.update.include, ...ov.include] };
  if (ov.exclude && ov.exclude.length) merged.update = { ...merged.update, exclude: [...merged.update.exclude, ...ov.exclude] };

  return { config: validate(merged), source, warnings };
}

function isFileSafe(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
