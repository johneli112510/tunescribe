// Tunescribe API — Cloudflare Worker + R2.
//
// R2 layout (bucket bound as BUCKET):
//   t/<id>.json   transcription (title, settings, notes); summary kept in customMetadata
//   a/<id>        original audio file
//
// Optional secret APP_PASSWORD: when set, every /api call (except /api/health)
// must send the header  X-App-Password: <password>.

const ID_RE = /^[a-z0-9-]{1,48}$/;
const MAX_AUDIO = 95 * 1024 * 1024; // stay under the Workers request-body limit
const MAX_JSON = 5 * 1024 * 1024;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const error = (status, message) => json({ error: message }, status);

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(request, env) {
  if (!env.APP_PASSWORD) return true;
  return safeEqual(request.headers.get('x-app-password') || '', env.APP_PASSWORD);
}

function clean(s, max = 200) {
  return String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

async function listTranscriptions(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: 't/', cursor, include: ['customMetadata'] });
    for (const obj of page.objects) {
      const m = obj.customMetadata || {};
      items.push({
        id: obj.key.slice(2, -5),
        title: m.title || 'Untitled',
        instrument: m.instrument || 'piano',
        notes: Number(m.notes || 0),
        hasAudio: m.hasAudio === '1',
        updated: Number(m.updated || obj.uploaded.getTime()),
        size: obj.size,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => b.updated - a.updated);
  return items;
}

async function handleApi(request, env, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [resource, id] = parts;
  const method = request.method;

  if (resource === 'health') {
    return json({ ok: true, passwordRequired: !!env.APP_PASSWORD, storage: !!env.BUCKET });
  }
  if (!env.BUCKET) return error(500, 'R2 bucket is not bound. Add the BUCKET binding in wrangler.jsonc.');

  // Grand-piano samples (Salamander Grand Piano, CC-BY 3.0). Fetched once from the
  // public Tone.js mirror, then served from your own R2 bucket. Public: no password needed.
  if (resource === 'samples' && (method === 'GET' || method === 'HEAD')) {
    if (!id || !/^(A|C|Ds|Fs)[0-8]\.mp3$/.test(id)) return error(400, 'Bad sample name');
    const key = `samples/${id}`;
    let obj = await env.BUCKET.get(key);
    if (!obj) {
      const upstream = await fetch(`https://tonejs.github.io/audio/salamander/${id}`);
      if (!upstream.ok) return error(502, 'Sample source unavailable');
      const data = await upstream.arrayBuffer();
      await env.BUCKET.put(key, data, { httpMetadata: { contentType: 'audio/mpeg' } });
      return new Response(method === 'HEAD' ? null : data, {
        headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=31536000, immutable' },
      });
    }
    return new Response(method === 'HEAD' ? null : obj.body, {
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  if (!authorized(request, env)) return error(401, 'Password required');

  if (resource === 'login' && method === 'POST') return json({ ok: true });

  // ---------- transcriptions ----------
  if (resource === 'transcriptions') {
    if (!id) {
      if (method === 'GET') return json({ items: await listTranscriptions(env) });
      return error(405, 'Method not allowed');
    }
    if (!ID_RE.test(id)) return error(400, 'Bad id');
    const key = `t/${id}.json`;

    if (method === 'GET') {
      const obj = await env.BUCKET.get(key);
      if (!obj) return error(404, 'Not found');
      return new Response(obj.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_JSON) return error(413, 'Transcription too large');
      let body;
      try {
        body = await request.json();
      } catch {
        return error(400, 'Invalid JSON');
      }
      if (!Array.isArray(body.notes)) return error(400, 'notes must be an array');
      const audioHead = await env.BUCKET.head(`a/${id}`);
      const record = {
        id,
        title: clean(body.title) || 'Untitled',
        instrument: clean(body.instrument, 20) || 'piano',
        s: body.s && typeof body.s === 'object' ? body.s : {},
        notes: body.notes
          .filter((n) => Array.isArray(n) && n.length >= 3 && n.every((v) => typeof v === 'number' && Number.isFinite(v)))
          .slice(0, 50000),
        created: Number(body.created) || Date.now(),
        updated: Date.now(),
        hasAudio: !!audioHead,
        audioType: audioHead?.httpMetadata?.contentType || null,
      };
      const text = JSON.stringify(record);
      if (text.length > MAX_JSON) return error(413, 'Transcription too large');
      await env.BUCKET.put(key, text, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          title: record.title,
          instrument: record.instrument,
          notes: String(record.notes.length),
          hasAudio: record.hasAudio ? '1' : '0',
          updated: String(record.updated),
        },
      });
      return json({ ok: true, id, updated: record.updated, hasAudio: record.hasAudio });
    }

    if (method === 'DELETE') {
      await env.BUCKET.delete([key, `a/${id}`]);
      return json({ ok: true });
    }
    return error(405, 'Method not allowed');
  }

  // ---------- audio ----------
  if (resource === 'audio') {
    if (!id || !ID_RE.test(id)) return error(400, 'Bad id');
    const key = `a/${id}`;

    if (method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (!len) return error(411, 'Content-Length required');
      if (len > MAX_AUDIO) return error(413, 'Audio file is too large (max 95 MB)');
      const type = (request.headers.get('content-type') || 'application/octet-stream').slice(0, 100);
      if (!/^(audio|video)\//.test(type) && type !== 'application/octet-stream') return error(415, 'Only audio or video files');
      const name = clean(request.headers.get('x-file-name') ? decodeURIComponent(request.headers.get('x-file-name')) : '', 200);
      await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType: type },
        customMetadata: { name, uploaded: String(Date.now()) },
      });
      return json({ ok: true });
    }

    if (method === 'GET' || method === 'HEAD') {
      const range = request.headers.get('range');
      const obj = await env.BUCKET.get(key, range ? { range: request.headers } : undefined);
      if (!obj) return error(404, 'Not found');
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      headers.set('accept-ranges', 'bytes');
      headers.set('cache-control', 'private, max-age=3600');
      if (range && obj.range) {
        let { offset, length, suffix } = obj.range;
        if (suffix != null) { offset = obj.size - suffix; length = suffix; }
        offset = offset ?? 0;
        length = length ?? obj.size - offset;
        headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
        headers.set('content-length', String(length));
        return new Response(method === 'HEAD' ? null : obj.body, { status: 206, headers });
      }
      headers.set('content-length', String(obj.size));
      return new Response(method === 'HEAD' ? null : obj.body, { headers });
    }

    if (method === 'DELETE') {
      await env.BUCKET.delete(key);
      return json({ ok: true });
    }
    return error(405, 'Method not allowed');
  }

  return error(404, 'Unknown API route');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error(e);
        return error(500, 'Server error');
      }
    }
    return env.ASSETS.fetch(request);
  },
};
