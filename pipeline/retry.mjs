// Failure classification for agent invocations.
//
// The pipeline previously halted on the first non-zero exit, which made a
// provider 529 indistinguishable from a genuinely broken run — an autonomous
// loop that dies on a retryable blip isn't autonomous. Transient failures get a
// bounded retry with backoff; everything else halts immediately, because
// retrying an auth failure or a bad model id just burns wall-clock.

const TRANSIENT_PATTERNS = [
  /\b(429|500|502|503|504|529)\b/,
  /overloaded/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /internal server error/i,
  /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/,
  /socket hang up/i,
  /connection (reset|closed|error)/i,
  /network error/i,
  /stream (error|interrupted)/i,
];

// Checked first: these strings can co-occur with transient-looking noise, and
// retrying any of them is guaranteed to fail again the same way.
const FATAL_PATTERNS = [
  /authentication required/i,
  /not authenticated/i,
  /failed to authenticate/i,
  /(session|token|credential)s? (has )?expired/i,
  /please (run|log ?in)\b/i,
  /please run .* login/i,
  /invalid api key/i,
  /unauthorized/i,
  /permission denied/i,
  /(unknown|invalid|unsupported) model/i,
  /model .* (not found|does not exist)/i,
  /quota exceeded/i,
  /insufficient (credit|funds|balance)/i,
];

/**
 * @param {{ ok?: boolean, timedOut?: boolean, error?: string, exitCode?: number }} res
 * @param {string} logTail
 * @returns {{ transient: boolean, reason: string }}
 */
export function classifyFailure(res, logTail = '') {
  const haystack = `${res?.error || ''}\n${logTail}`;
  for (const p of FATAL_PATTERNS) {
    if (p.test(haystack)) return { transient: false, reason: 'fatal: authentication, quota, or model configuration' };
  }
  // A timeout is a capacity/latency symptom, not a broken invocation — the same
  // stage often completes on a retry.
  if (res?.timedOut) return { transient: true, reason: 'agent timed out' };
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(haystack)) return { transient: true, reason: 'transient: provider or network error' };
  }
  // A spawn failure (bin missing) is fatal; a plain non-zero exit with no
  // recognisable cause is treated as fatal so real bugs surface fast.
  return { transient: false, reason: res?.error ? 'fatal: could not spawn agent' : 'fatal: agent exited non-zero' };
}

/** Exponential backoff with a cap, in ms. */
export function backoffMs(attempt, base = 2000, cap = 30000) {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
