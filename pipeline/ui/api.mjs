// Talking to the dashboard server.
//
// Every call is scoped to a project, because one dashboard serves every repo on
// the machine. Errors are returned rather than thrown: a failed poll should
// leave the last good view on screen with a note, not blank the page.

export function createApi(projectRef) {
  const q = (params = {}) => {
    const search = new URLSearchParams({ project: projectRef(), ...params });
    for (const [k, v] of [...search]) if (v === undefined || v === null || v === '') search.delete(k);
    return search.toString();
  };

  // The browser is signed in by an HttpOnly session cookie, sent with every
  // same-origin request; the page holds no secret. A 401 means that session
  // ended (the server restarted): reloading shows the sign-in instructions.
  const signedOut = (res) => { if (res.status === 401) globalThis.location?.reload(); };

  async function get(path, params) {
    const res = await fetch(`${path}?${q(params)}`, { headers: { Accept: 'application/json' } });
    signedOut(res);
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    return res.json();
  }

  async function post(path, body = {}) {
    const res = await fetch(`${path}?${q()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    signedOut(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path} failed (${res.status})`);
    return data;
  }

  return {
    projects: () => get('/api/projects'),
    // `stage` narrows the events to that stage (the server picks the active one otherwise).
    state: (run, stage) => get('/api/state', { ...(run ? { run } : {}), ...(stage ? { stage } : {}) }),
    runs: () => get('/api/runs'),
    pool: () => get('/api/pool'),
    decisions: (status) => get('/api/decisions', status ? { status } : {}),
    bridge: () => get('/api/bridge'),
    artifact: (name, run) => get('/api/artifact', { name, ...(run ? { run } : {}) }),
    log: (stage, run, params = {}) => get('/api/log', { stage, ...(run ? { run } : {}), ...params }),
    reportUrl: (params) => `/api/report?${q(params)}`,

    answerDecision: (decisionId, answer) => post('/api/decisions/answer', { decisionId, answer }),
    approveMerge: (featureId, note) => post('/api/merge/approve', { featureId, note }),
    requestChanges: (featureId, text) => post('/api/merge/request-changes', { featureId, text }),
    followup: (stage, text, run) => post('/api/followup', { stage, text, run }),
    poolAction: (action, featureId, reason, extra = {}) => post('/api/pool/action', { action, featureId, reason, ...extra }),
    pausePool: (why) => post('/api/pool/pause', { why }),
    resumePool: () => post('/api/pool/resume', {}),
    continueRun: (approve, run, handoffId) => post('/api/continue', { ...(approve ? { approve: true } : {}), ...(run ? { run } : {}), ...(handoffId ? { handoffId } : {}) }),
    cancelRun: (run) => post('/api/cancel', run ? { run } : {}),
    resumeRun: (run) => post('/api/resume', run ? { run } : {}),
    extendRun: (cycles, run) => post('/api/extend', { extend: cycles, ...(run ? { run } : {}) }),
    dismissRun: (run, reason) => post('/api/run/dismiss', { run, reason }),
    setAutonomy: (autonomy, run) => post('/api/run/autonomy', { autonomy, ...(run ? { run } : {}) }),
    startRun: (body) => post('/api/run', body),
  };
}
