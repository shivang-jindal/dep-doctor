// Baseline is red on purpose: dep-doctor must refuse to act (exit 3).
'use strict';
if (!process.env.DEP_DOCTOR) {
  // Guard: fixture logic only runs when dep-doctor executes it, so a bare
  // `node --test` sweep over test/fixtures stays green.
  console.log('fixture: red-app suite skipped (DEP_DOCTOR not set)');
  process.exit(0);
}
console.error('not ok - 1 failing test');
console.error('AssertionError: expected main to be green (red-app/verify.js:7)');
process.exit(1);
