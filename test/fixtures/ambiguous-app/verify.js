// Present, but the CI workflow disagrees with scripts.test → ambiguity (exit 2).
'use strict';
if (!process.env.DEP_DOCTOR) {
  console.log('fixture: ambiguous-app suite skipped (DEP_DOCTOR not set)');
  process.exit(0);
}
console.log('ok - fixture suite');
