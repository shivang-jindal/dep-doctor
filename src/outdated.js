import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';
import { isFile } from './util.js';

/** Normalize `npm outdated --json` shaped data into a sorted plain object. */
export function parseOutdated(raw, { sourceLabel = 'outdated data' } = {}) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return {};
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`${sourceLabel}: invalid JSON (${e.message})`);
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsageError(`${sourceLabel}: expected a JSON object of {dep: {current, wanted, latest}}`);
  }
  const out = {};
  for (const name of Object.keys(raw).sort()) {
    const entry = raw[name] ?? {};
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UsageError(`${sourceLabel}: entry for "${name}" is not an object`);
    }
    const current = String(entry.current ?? '');
    const wanted = String(entry.wanted ?? current);
    const latest = String(entry.latest ?? wanted ?? current);
    out[name] = { current, wanted, latest, dependent: String(entry.dependent ?? '') };
  }
  return out;
}

/**
 * Offline (default): read a local outdated snapshot — either an explicit
 * `--outdated <file>` or `<root>/dep-doctor.outdated.json`. Never touches
 * the network. Missing file is a usage error (exit 2) with a clear hint.
 */
export function createOfflineFetch({ outdatedFile = null } = {}) {
  return function fetchOutdated({ root }) {
    const file = outdatedFile ?? path.join(root, 'dep-doctor.outdated.json');
    if (!isFile(file)) {
      throw new UsageError(
        `offline mode: no outdated snapshot found (${file}).\n` +
          '  Provide one with --outdated <file> (npm outdated --json shape), or run with --registry to query npm live.',
      );
    }
    const data = parseOutdated(fs.readFileSync(file, 'utf8'), { sourceLabel: `outdated snapshot ${file}` });
    return { source: 'offline-file', file, data };
  };
}

/** Live: `npm outdated --json` via the injected exec runner (behind --registry). */
export function createRegistryFetch(exec, { timeoutMs = 300_000 } = {}) {
  return function fetchOutdated({ root }) {
    const res = exec({ command: 'npm outdated --json --depth 0', cwd: root, timeoutMs });
    const text = String(res.stdout ?? '').trim();
    let data;
    if (text === '') {
      if (res.timedOut) throw new UsageError('npm outdated timed out');
      if (res.code !== 0 && res.code !== 1) {
        throw new UsageError(`npm outdated failed (exit ${res.code}): ${String(res.stderr ?? '').trim().slice(0, 500)}`);
      }
      data = {};
    } else {
      data = parseOutdated(text, { sourceLabel: 'npm outdated --json' });
    }
    return { source: 'registry', file: null, data };
  };
}
