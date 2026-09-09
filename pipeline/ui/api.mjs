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

  async function get(path, params) {
    const res = await fetch(`${path}?${q(params)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    return res.json();
  }

  async function post(path, body = {}) {
    const res = await fetch(`${path}?${q()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path} failed (${res.status})`);
    return data;
  }

  return {
    projects: () => get('/api/projects'),
    state: (run) => get('/api/state', run ? { run } : {}),
    runs: () => get('/api/runs'),
    pool: () => get('/api/pool'),
    decisions: (status) => get('/api/decisions', status ? { status } : {}),
    artifact: (name, run) => get('/api/artifact', { name, ...(run ? { run } : {}) }),
    log: (stage, run, params = {}) => get('/api/log', { stage, ...(run ? { run } : {}), ...params }),
    reportUrl: (params) => `/api/report?${q(params)}`,

    answerDecision: (decisionId, answer) => post('/api/decisions/answer', { decisionId, answer }),
    approveMerge: (featureId, note) => post('/api/merge/approve', { featureId, note }),
    requestChanges: (featureId, text) => post('/api/merge/request-changes', { featureId, text }),
    followup: (stage, text, run) => post('/api/followup', { stage, text, run }),
    pausePool: (why) => post('/api/pool/pause', { why }),
    resumePool: () => post('/api/pool/resume', {}),
    continueRun: (approve, run) => post('/api/continue', { ...(approve ? { approve: true } : {}), ...(run ? { run } : {}) }),
    cancelRun: (run) => post('/api/cancel', run ? { run } : {}),
    resumeRun: (run) => post('/api/resume', run ? { run } : {}),
    extendRun: (cycles, run) => post('/api/extend', { cycles, ...(run ? { run } : {}) }),
  };
}
