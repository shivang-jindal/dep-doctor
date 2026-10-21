/**
 * Test loader for `node --test test/` (the mandated npm script).
 *
 * Why this file exists: Node's test runner treats positional args as glob
 * patterns; `test/` matches the *directory* itself, which the runner executes
 * as a single test file (Node resolves a directory to its index.js). So this
 * index.js imports every `*.test.js` sibling when — and only when — it is the
 * entry point of that directory run. When a bare `node --test` sweep reaches
 * this file directly (argv[1] is index.js itself), it stays inert so the test
 * files aren't executed twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectoryEntry = entry === path.resolve(here);

if (isDirectoryEntry) {
  const files = fs
    .readdirSync(here)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const f of files) {
    await import(pathToFileURL(path.join(here, f)).href);
  }
}
