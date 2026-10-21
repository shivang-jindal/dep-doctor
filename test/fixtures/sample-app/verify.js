// dep-doctor fixture "test suite". Deliberately reads only package.json so it
// runs inside temp copies that exclude node_modules (no npm install in v0).
'use strict';
if (!process.env.DEP_DOCTOR) {
  // Guard: fixture suite only runs when dep-doctor executes it (bare
  // `node --test` must stay green without executing fixture logic).
  console.log('fixture: sample-app suite skipped (DEP_DOCTOR not set)');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const failures = [];

function major(range) {
  const m = /^[\^~>=<\s=]*(\d+)/.exec(String(range));
  return m ? Number(m[1]) : null;
}

if (major(pkg.dependencies.zod) >= 4) {
  failures.push('ZodError: "strict" is not a valid SchemaType option (src/api/schemas.js)');
  failures.push('  at src/api/schemas.js:4');
}

if (pkg.dependencies['tiny-lib'] !== '^1.2.0') {
  failures.push('TypeError: tiny-lib 1.2.1 changed the default padding behavior');
}

if (failures.length) {
  console.error('not ok - dependency bump broke the suite');
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`ok - 3 checks passed (zod ${pkg.dependencies.zod})`);
