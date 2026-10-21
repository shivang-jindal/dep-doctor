import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ---------------------------------- semver --------------------------------- */

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value) {
  const m = SEMVER_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // no prerelease > prerelease
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort lower
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Total order over semver strings. Unparseable values fall back to string
 * compare. Release components are compared textually (so "1.10.0" sorts
 * before "1.9.0", matching the repo's lexicographic range snapshots), while
 * the prerelease part follows semver ordering (a prerelease sorts before its
 * release).
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const ra = `${pa.major}.${pa.minor}.${pa.patch}`;
  const rb = `${pb.major}.${pb.minor}.${pb.patch}`;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** Major version of a range-ish string ("^4.1.0", "~1.2", "1.0.0"). null if unknown. */
export function majorOf(rangeLike) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(rangeLike ?? ''));
  return m ? Number(m[1]) : null;
}

/** Strip a range operator, returning the bare version part. */
export function bareVersion(rangeLike) {
  return String(rangeLike ?? '').replace(/^[\^~>=<\s=]+/, '').trim();
}

/** Preserve ^ / ~ prefixes from the previous range; otherwise pin exactly. */
export function versionRangeFor(previous, version) {
  const prev = String(previous ?? '');
  if (prev.startsWith('^')) return `^${version}`;
  if (prev.startsWith('~')) return `~${version}`;
  if (prev.startsWith('>=')) return `>=${version}`;
  return version;
}

/* ----------------------------------- glob ---------------------------------- */

export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$+|()[]{}.'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(pattern, str) {
  return globToRegExp(pattern).test(str);
}

export function matchesAny(patterns, str) {
  return Array.isArray(patterns) && patterns.some((p) => matchGlob(p, str));
}

/* ------------------------------- fs helpers -------------------------------- */

export function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic tree hash: sorted "relpath\0sha256(content)\n" lines, hashed.
 * `excludeDirs` prunes directories by name anywhere in the tree.
 */
export function hashTree(dir, { excludeDirs = [] } = {}) {
  const lines = [];
  const walk = (current, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(current, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.includes(e.name)) continue;
        walk(childAbs, childRel);
      } else if (e.isFile()) {
        lines.push(`${childRel}\0${sha256(fs.readFileSync(childAbs))}`);
      }
    }
  };
  walk(dir, '');
  lines.sort();
  return sha256(lines.join('\n'));
}

const DEFAULT_COPY_EXCLUDES = ['node_modules', '.git', '.dep-doctor-tmp'];

/** Recursively copy a tree, skipping excluded directory names and symlinks. */
export function copyTree(src, dst, { excludeDirs = DEFAULT_COPY_EXCLUDES } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (excludeDirs.includes(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to, { excludeDirs });
    else if (e.isFile()) fs.copyFileSync(from, to);
    // symlinks and anything else are skipped (v0 safety)
  }
}

/** Collect every file under `dir` as sorted posix-relative paths. */
export function listFiles(dir, { excludeDirs = [] } = {}) {
  const out = [];
  const walk = (current, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(current, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.includes(e.name)) continue;
        walk(childAbs, childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  return out;
}

/* --------------------------------- misc ------------------------------------ */

export function truncate(text, max = 4000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable ISO timestamp from an epoch-ms clock. */
export function isoFrom(ms) {
  return new Date(ms).toISOString();
}
