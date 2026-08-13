export function addMoney(a, b) {
  // BUG: floating-point addition on currency; 0.1 + 0.2 !== 0.3.
  return a + b;
}
