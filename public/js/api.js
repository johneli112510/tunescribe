// Small client for the Tunescribe Worker API (R2-backed).
const PW_KEY = 'tunescribe.password';

export class AuthError extends Error {}

let password = '';
try { password = localStorage.getItem(PW_KEY) || ''; } catch {}

export function setPassword(pw) {
  password = pw;
  try { pw ? localStorage.setItem(PW_KEY, pw) : localStorage.removeItem(PW_KEY); } catch {}
}

async function req(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (password) h['X-App-Password'] = password;
  if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, { method, body, headers: h });
  if (res.status === 401) throw new AuthError('Password required');
  if (!res.ok) {
    let msg = `Server error (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  if (raw) return res;
  return res.json();
}

export const api = {
  async health() {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('application/json')) throw new Error('No server');
    return res.json();
  },
  login: (pw) => {
    setPassword(pw);
    return req('/login', { method: 'POST' });
  },
  list: () => req('/transcriptions').then((r) => r.items),
  get: (id) => req(`/transcriptions/${id}`),
  save: (id, record) => req(`/transcriptions/${id}`, { method: 'PUT', body: record }),
  remove: (id) => req(`/transcriptions/${id}`, { method: 'DELETE' }),
  uploadAudio: (id, blob, name = '') =>
    req(`/audio/${id}`, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    }),
  getAudio: (id) => req(`/audio/${id}`, { raw: true }).then((r) => r.arrayBuffer()),
};
