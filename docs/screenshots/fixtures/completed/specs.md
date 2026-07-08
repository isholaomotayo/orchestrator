# Specification: Fix demo/math.js multiply

## Problem
`multiply(a, b)` incorrectly returns `a + b`. The unit test in `demo/math.test.js` fails.

## Acceptance criteria
- `multiply(2, 3)` returns `6`
- `multiply(0, 5)` returns `0`
- All existing `npm test` checks pass
- No changes to unrelated exports

## Approach
1. Open `demo/math.js`
2. Replace addition with multiplication in `multiply`
3. Re-run tests until green
