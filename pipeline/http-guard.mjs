// Origin/Host validation for the localhost dashboard's state-changing endpoints.
// The dashboard binds to 127.0.0.1, but a browser page on any site can still
// POST to http://127.0.0.1:<port>/... (CSRF) or reach it via DNS rebinding
// (the Host header is attacker-controlled). We defend by requiring that:
//   - the Host header names a loopback authority on our own port, and
//   - when an Origin header is present, it is same-origin loopback on our port.
// This is a pure function so it can be unit-tested without starting a server.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(authority) {
  if (typeof authority !== 'string' || !authority) return null;
  // Strip a trailing :port (handles IPv6 forms like [::1]:4600 and 127.0.0.1:4600).
  const lastColon = authority.lastIndexOf(':');
  const bracketEnd = authority.lastIndexOf(']');
  if (lastColon > bracketEnd) return authority.slice(0, lastColon);
  return authority;
}

function portOf(authority) {
  if (typeof authority !== 'string' || !authority) return null;
  const lastColon = authority.lastIndexOf(':');
  const bracketEnd = authority.lastIndexOf(']');
  if (lastColon > bracketEnd) return authority.slice(lastColon + 1);
  return null;
}

/**
 * @param {Record<string,string|undefined>} headers - lower-cased request headers
 * @param {number} port - the port the server is bound to
 * @returns {boolean} whether the request may perform a state-changing action
 */
export function isTrustedRequest(headers = {}, port) {
  const host = headers.host;
  if (!host) return false;
  const hostName = hostnameOf(host);
  const hostPort = portOf(host);
  if (!LOOPBACK_HOSTS.has(hostName)) return false;
  // Host header must target our port (defeats rebinding to a different authority).
  if (hostPort !== null && hostPort !== String(port)) return false;

  // Origin is present on cross-origin (and most same-origin) browser requests.
  // When present it must be a loopback origin on our port. When absent (e.g.
  // curl, same-origin navigations that omit it), the Host check above stands.
  const origin = headers.origin;
  if (origin && origin !== 'null') {
    let url;
    try { url = new URL(origin); } catch { return false; }
    if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (originPort !== String(port)) return false;
  }
  return true;
}
