// Demo module with an intentional bug so the pipeline's self-healing Coder
// loop has something real to fix. See demo/math.test.js.
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a + b; // BUG: should be a * b
}

export function divide(a, b) {
  if (b === 0) throw new RangeError('division by zero');
  return a / b;
}
