import fs from 'node:fs';
import path from 'node:path';
import { compareSemver, escapeRegExp, isFile, listFiles, truncate } from './util.js';

const CHANGELOG_CANDIDATES = (pkg) => [
  `node_modules/${pkg}/CHANGELOG.md`,
  `node_modules/${pkg}/changelog.md`,
  `node_modules/${pkg}/HISTORY.md`,
  `node_modules/${pkg}/docs/CHANGELOG.md`,
  `node_modules/${pkg}/CHANGES.md`,
  `docs/changelogs/${pkg}.md`,
  `docs/${pkg}.CHANGELOG.md`,
];

export function findChangelog(root, pkg) {
  for (const rel of CHANGELOG_CANDIDATES(pkg)) {
    const abs = path.join(root, rel);
    if (isFile(abs)) return { path: rel, abs };
  }
  return { path: null, abs: null };
}

const VERSION_HEADING_RE = /^#{2,4}\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s*[-–—]\s*(.*))?$/;
const BREAKING_RE = /breaking/i;
const DEPRECATION_RE = /deprecat/i;
const INLINE_BOLD_RE = /^\s*(?:[-*]\s*)?\*\*(BREAKING|DEPRECATED|Deprecation[^*]*)\*\*[:\s]*/i;

/**
 * Parse `## [4.1.0]` / `## 4.1.0 - date` style changelogs and extract the
 * (from, to] version range, with Breaking / Deprecation subsections pulled out.
 */
export function parseChangelog(markdown, { from = null, to = null } = {}) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const versions = [];
  let current = null;
  let section = null; // 'breaking' | 'deprecation' | 'body'

  const pushLine = (text) => {
    if (!current) return;
    const t = text.trim().replace(/`/g, '');
    if (!t || /^<!--/.test(t) || /^\[unreleased\]/i.test(t)) return;
    if (section === 'breaking') current.breaking.push(t);
    else if (section === 'deprecation') current.deprecations.push(t);
    else if (current.body.length < 40) current.body.push(t);
  };

  for (const line of lines) {
    const h = VERSION_HEADING_RE.exec(line);
    if (h) {
      current = { version: h[1], date: (h[2] ?? '').trim(), breaking: [], deprecations: [], body: [] };
      versions.push(current);
      section = null;
      continue;
    }
    if (!current) continue;
    const heading = /^(#{2,4})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const title = heading[2];
      if (BREAKING_RE.test(title)) section = 'breaking';
      else if (DEPRECATION_RE.test(title)) section = 'deprecation';
      else section = 'body';
      continue;
    }
    const bold = INLINE_BOLD_RE.exec(line);
    if (bold) {
      const kind = bold[1].toLowerCase();
      const rest = (line.slice(bold[0].length).trim() || line.trim()).replace(/`/g, '');
      if (kind.startsWith('break')) current.breaking.push(rest);
      else current.deprecations.push(rest);
      if (!current.breaking.length && !current.deprecations.length) current.body.push(line.trim());
      continue;
    }
    pushLine(line);
  }

  const inRange = versions.filter((v) => {
    if (from != null && compareSemver(v.version, from) <= 0) return false;
    if (to != null && compareSemver(v.version, to) > 0) return false;
    return true;
  });
  inRange.sort((a, b) => compareSemver(a.version, b.version));
  for (const v of inRange) {
    v.breaking = dedupe(v.breaking);
    v.deprecations = dedupe(v.deprecations);
  }
  return { versions: inRange, allVersions: versions.map((v) => v.version) };
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/* ------------------------------ usage sites -------------------------------- */

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.vue', '.svelte']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'out', '.next']);

/**
 * Scan source for `from "pkg"`, `require("pkg")`, `import("pkg")`,
 * `import "pkg"` (incl. subpaths). Returns sorted {file, line, snippet},
 * capped.
 */
export function findUsageSites(root, pkg, { cap = 50, skipDirs = SKIP_DIRS } = {}) {
  const escaped = escapeRegExp(pkg);
  const patterns = [
    new RegExp(`\\bfrom\\s*(['"])${escaped}(?:/[^'"]*)?\\1`),
    new RegExp(`\\brequire\\s*\\(\\s*(['"])${escaped}(?:/[^'"]*)?\\1\\s*\\)`),
    new RegExp(`\\bimport\\s*\\(\\s*(['"])${escaped}(?:/[^'"]*)?\\1\\s*\\)`),
    new RegExp(`\\bimport\\s+(['"])${escaped}(?:/[^'"]*)?\\1`),
  ];
  const files = listFiles(root, { excludeDirs: [...skipDirs] }).filter((f) =>
    SOURCE_EXTS.has(path.posix.extname(f)),
  );
  const sites = [];
  let truncated = false;
  for (const rel of files) {
    if (sites.length >= cap) {
      truncated = true;
      break;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (sites.length >= cap) {
        truncated = true;
        break;
      }
      const line = lines[i];
      if (patterns.some((p) => p.test(line))) {
        sites.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 160) });
      }
    }
  }
  return {
    sites,
    count: sites.length,
    truncated,
    scannedFiles: files.length,
    /** Convenience delegate so callers can test sites without reaching for `.sites`. */
    some(fn) {
      return sites.some(fn);
    },
  };
}

/* --------------------------------- digest ---------------------------------- */

/**
 * ResearchDigest for (dep, from, to]:
 * { dep, from, to, changelog: {found, path, versions[]}, usage: {...}, complete }
 * `complete` false ⇒ "partial digest" (missing changelog, nothing scanned).
 */
export function buildDigest({ root, dep, from, to, usageCap = 50 }) {
  const found = findChangelog(root, dep);
  let changelog;
  if (found.abs) {
    const parsed = parseChangelog(fs.readFileSync(found.abs, 'utf8'), { from, to });
    changelog = {
      found: true,
      path: found.path,
      releasesInRange: parsed.versions.length,
      versions: parsed.versions.map((v) => ({
        version: v.version,
        date: v.date,
        breaking: v.breaking,
        deprecations: v.deprecations,
        notes: v.body.slice(0, 10),
      })),
    };
  } else {
    changelog = { found: false, path: null, releasesInRange: 0, versions: [] };
  }
  const usage = findUsageSites(root, dep, { cap: usageCap });
  return {
    dep,
    from,
    to,
    changelog,
    usage,
    complete: changelog.found && usage.scannedFiles > 0,
  };
}

export function truncateDigestOutput(text) {
  return truncate(text, 4000);
}
