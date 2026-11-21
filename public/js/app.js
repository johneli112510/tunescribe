import { SAMPLE_RATE, transcribeAI, transcribeMelody } from './transcribe.js';
import { detectKey, keyLabel, estimateTempo, buildMusicXML, buildMidi, noteName, resolveLayout } from './music.js';
import { PianoRoll } from './pianoroll.js';
import { Player } from './player.js';
import { api, AuthError, setPassword } from './api.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => 'n' + Math.random().toString(36).slice(2, 9);
const LIB_KEY = 'tunescribe.library.v1';

const INSTRUMENTS = {
  piano: { label: 'Piano', layout: 'grand', engine: 'ai', part: 'Piano' },
  voice: { label: 'Voice / singing', layout: 'treble', engine: 'melody', part: 'Voice' },
  guitar: { label: 'Guitar / ukulele', layout: 'auto', engine: 'ai', part: 'Guitar' },
  lead: { label: 'Violin, flute, sax, trumpet', layout: 'treble', engine: 'melody', part: 'Melody' },
  bass: { label: 'Bass, cello, low voice', layout: 'bass', engine: 'melody', part: 'Bass' },
  ensemble: { label: 'Band / mixed recording', layout: 'grand', engine: 'ai', part: 'Piano reduction' },
};

const state = {
  id: null,
  title: 'Untitled',
  notes: [],
  audio: null,
  instrument: 'piano',
  s: { bpm: 100, offset: 0, beats: 4, beatType: 4, grid: 4, layout: 'grand', split: 60, keyAuto: true, fifths: 0, mode: 'major' },
  undo: [],
  redo: [],
  cursor: 0,
  view: 'score',
};

const player = new Player();
let osmd = null;
let scoreDirty = true;
let scoreZoom = 1;

// ---------------------------------------------------------------- UI helpers
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function setProgress(p, text) {
  const box = $('#progress');
  box.hidden = p == null;
  if (p == null) return;
  $('#progressBar').style.width = Math.round(Math.max(0.03, p) * 100) + '%';
  if (text) $('#progressText').textContent = text;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safeName = () => (state.title || 'transcription').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'transcription';

// ---------------------------------------------------------------- Storage (R2 server, with local fallback)
const server = { online: false, passwordRequired: false };

function readLib() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY)) || []; } catch { return []; }
}
function writeLib(items) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(items));
  } catch {
    toast('Browser storage is full — delete some saved transcriptions.');
  }
}
function record() {
  return {
    id: state.id,
    title: state.title,
    instrument: state.instrument,
    created: state.created || Date.now(),
    updated: Date.now(),
    s: state.s,
    notes: state.notes.map((n) => [+n.start.toFixed(3), +n.dur.toFixed(3), n.pitch, n.vel]),
  };
}
function setSaveStatus(text, cls = '') {
  const el = $('#saveStatus');
  el.textContent = text;
  el.className = 'save-status small ' + cls;
}

let saveChain = Promise.resolve();
function saveCurrent() {
  if (!state.id) return Promise.resolve();
  const rec = record();
  // local copy (offline backup)
  writeLib([rec, ...readLib().filter((i) => i.id !== rec.id)].slice(0, 30));
  if (!server.online || state.id.startsWith('demo')) {
    setSaveStatus(server.online ? 'Demo (not saved)' : 'Saved in this browser');
    return Promise.resolve();
  }
  setSaveStatus('Saving…');
  saveChain = saveChain
    .then(() => api.save(rec.id, rec))
    .then((r) => {
      state.hasAudio = r.hasAudio;
      setSaveStatus('☁ Saved', 'ok');
    })
    .catch((e) => {
      console.warn(e);
      if (e instanceof AuthError) showLogin();
      setSaveStatus('Not saved — offline copy kept', 'warn');
    });
  return saveChain;
}
const saveSoon = debounce(saveCurrent, 900);

function libRow(it, { onOpen, onDelete }) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  row.innerHTML = `<div><strong></strong><div class="muted small"></div></div>
    <div class="lib-actions"><button class="btn small" data-open>Open</button><button class="btn small ghost" data-del aria-label="Delete">Delete</button></div>`;
  row.querySelector('strong').textContent = it.title;
  const count = Array.isArray(it.notes) ? it.notes.length : it.notes;
  row.querySelector('.muted').textContent = `${count} notes${it.hasAudio ? ' · ♪ audio' : ''} · ${new Date(it.updated).toLocaleString()}`;
  row.querySelector('[data-open]').onclick = onOpen;
  row.querySelector('[data-del]').onclick = () => {
    if (confirm(`Delete "${it.title}"${it.hasAudio ? ' and its audio' : ''}? This cannot be undone.`)) onDelete();
  };
  return row;
}

function fromRecord(r) {
  return {
    id: r.id,
    title: r.title,
    instrument: r.instrument,
    created: r.created,
    s: r.s,
    notes: r.notes.map(([start, dur, pitch, vel]) => ({ id: uid(), start, dur, pitch, vel })),
    audio: null,
  };
}

async function renderLibrary() {
  const list = $('#libList');
  $('#libSource').textContent = server.online ? 'Stored on the server (Cloudflare R2) — available on any device.' : 'Server not reachable — showing transcriptions saved in this browser.';
  list.innerHTML = '<p class="muted">Loading…</p>';
  let items;
  try {
    items = server.online ? await api.list() : readLib();
  } catch (e) {
    if (e instanceof AuthError) { $('#library').close(); showLogin(); return; }
    list.innerHTML = `<p class="muted">Could not load the library: ${e.message}</p>`;
    return;
  }
  list.innerHTML = items.length ? '' : '<p class="muted">No saved transcriptions yet. Everything you transcribe is saved here automatically.</p>';
  for (const it of items) {
    list.appendChild(
      libRow(it, {
        onOpen: async () => {
          $('#library').close();
          if (!server.online) return openTranscription(fromRecord(it));
          try {
            const rec = await api.get(it.id);
            openTranscription(fromRecord(rec), { save: false });
            if (rec.hasAudio) loadServerAudio(rec.id);
          } catch (e) {
            toast('Could not open: ' + e.message);
          }
        },
        onDelete: async () => {
          try {
            if (server.online) await api.remove(it.id);
            writeLib(readLib().filter((i) => i.id !== it.id));
            renderLibrary();
          } catch (e) {
            toast('Could not delete: ' + e.message);
          }
        },
      }),
    );
  }
}

async function loadServerAudio(id) {
  const label = $('#origLabel');
  label.title = 'Loading original audio…';
  try {
    const buf = await api.getAudio(id);
    if (state.id !== id) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    state.audio = await ctx.decodeAudioData(buf);
    ctx.close?.();
    $('#origAudio').disabled = false;
    label.title = '';
    updateTime(state.cursor);
  } catch (e) {
    console.warn(e);
    label.title = 'Original audio could not be loaded';
  }
}

async function uploadAudio(id, blob, name) {
  if (!server.online) return;
  if (blob.size > 95 * 1024 * 1024) {
    toast('Audio is over 95 MB, so only the transcription was saved to the server.');
    return;
  }
  setSaveStatus('Uploading audio…');
  try {
    await api.uploadAudio(id, blob, name);
    await saveCurrent(); // refresh hasAudio flag on the record
  } catch (e) {
    console.warn(e);
    if (e instanceof AuthError) showLogin();
    setSaveStatus('Audio not uploaded', 'warn');
  }
}

// ---------------------------------------------------------------- Login (optional APP_PASSWORD)
function showLogin() {
  const dlg = $('#login');
  if (dlg.open) return;
  $('#loginError').textContent = '';
  $('#loginPw').value = '';
  dlg.showModal();
  setTimeout(() => $('#loginPw').focus(), 50);
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api.login($('#loginPw').value);
    $('#login').close();
    toast('Welcome!');
  } catch (err) {
    setPassword('');
    $('#loginError').textContent = err instanceof AuthError ? 'Wrong password.' : err.message;
  }
});
$('#login').addEventListener('cancel', (e) => e.preventDefault());

async function connectServer() {
  try {
    const h = await api.health();
    server.online = !!h.storage;
    server.passwordRequired = h.passwordRequired;
    $('#serverBadge').textContent = server.online ? '☁ Cloud library' : 'Local only';
    $('#serverBadge').classList.toggle('ok', server.online);
    if (h.passwordRequired) {
      try { await api.list(); } catch (e) { if (e instanceof AuthError) showLogin(); }
    }
  } catch {
    server.online = false;
    $('#serverBadge').textContent = 'Local only';
  }
}

// ---------------------------------------------------------------- Transcription pipeline
async function decodeAudio(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    ctx.close?.();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const off = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { samples: rendered.getChannelData(0), original: decoded };
}

async function handleAudio(arrayBuffer, title, file = null) {
  const instrument = $('#instrument').value;
  const engine = $('#engine').value === 'auto' ? INSTRUMENTS[instrument].engine : $('#engine').value;
  const sensitivity = +$('#sensitivity').value / 100;
  $$('.upload-card button, .upload-card input, .upload-card select').forEach((el) => (el.disabled = true));
  try {
    setProgress(0.02, 'Decoding audio…');
    const { samples, original } = await decodeAudio(arrayBuffer);
    if (original.duration > 900) toast('Long file — transcription may take a few minutes.');
    let notes;
    if (engine === 'ai') {
      try {
        setProgress(0.04, 'Loading the AI model (first time only)…');
        notes = await transcribeAI(samples, {
          sensitivity,
          onProgress: (p) => setProgress(0.05 + p * 0.9, `Listening for notes… ${Math.round(p * 100)}%`),
        });
      } catch (e) {
        console.warn('AI engine failed, falling back to melody engine', e);
        toast('Could not load the AI model — using the built-in melody engine instead.', 5000);
        notes = null;
      }
    }
    if (!notes) {
      notes = await transcribeMelody(samples, SAMPLE_RATE, {
        sensitivity,
        onProgress: (p) => setProgress(0.05 + p * 0.9, `Tracking the melody… ${Math.round(p * 100)}%`),
      });
    }
    setProgress(0.98, 'Writing sheet music…');
    if (!notes.length) {
      toast('No notes were detected. Try a clearer recording or raise the sensitivity.', 6000);
      return;
    }
    notes.forEach((n) => (n.id = uid()));
    const tempo = estimateTempo(notes);
    const key = detectKey(notes);
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    openTranscription({
      id,
      title,
      instrument,
      notes,
      audio: original,
      s: { ...state.s, ...tempo, ...key, keyAuto: true, layout: INSTRUMENTS[instrument].layout, beats: 4, beatType: 4, grid: 2 },
    });
    toast(`Found ${notes.length} notes · ${tempo.bpm} BPM · ${keyLabel(key.fifths, key.mode)}`);
    const blob = file || new Blob([arrayBuffer]);
    uploadAudio(id, blob, file?.name || title);
  } catch (e) {
    console.error(e);
    toast('Sorry, that file could not be read. Try MP3, WAV, M4A, OGG or FLAC.', 6000);
  } finally {
    setProgress(null);
    $$('.upload-card button, .upload-card input, .upload-card select').forEach((el) => (el.disabled = false));
  }
}

function openTranscription(t, { save = true } = {}) {
  player.stop();
  Object.assign(state, { id: t.id, created: t.created || Date.now(), title: t.title, instrument: t.instrument || 'piano', notes: t.notes, audio: t.audio, undo: [], redo: [], cursor: 0 });
  state.s = { ...state.s, ...t.s };
  $('#home').hidden = true;
  $('#editor').hidden = false;
  $('#title').value = state.title;
  $('#origAudio').disabled = !state.audio;
  $('#origAudio').checked = false;
  $('#origLabel').title = state.audio ? '' : 'No original audio for this transcription';
  syncSettingsUI();
  roll.setNotes(state.notes);
  roll.setPlayhead(0);
  updateTime(0);
  scoreDirty = true;
  showView(state.view);
  if ($('#sound').value === 'piano') player.loadPiano().catch(() => {});
  if (save) saveCurrent();
  else setSaveStatus(server.online ? '☁ Saved' : 'Saved in this browser', server.online ? 'ok' : '');
  window.scrollTo({ top: 0 });
  history.replaceState(null, '', '#editor');
}

// ---------------------------------------------------------------- Score
function scoreOptions() {
  return { ...state.s, title: state.title, partName: INSTRUMENTS[state.instrument]?.part };
}

async function renderScore() {
  if (!scoreDirty || $('#editor').hidden || state.view !== 'score') return;
  scoreDirty = false;
  const el = $('#score');
  if (!window.opensheetmusicdisplay) {
    el.innerHTML = '<p class="muted pad">The notation renderer could not be loaded (check your internet connection). You can still download MusicXML or MIDI.</p>';
    return;
  }
  try {
    if (!osmd) {
      el.innerHTML = '';
      osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(el, {
        autoResize: true,
        backend: 'svg',
        drawTitle: true,
        drawPartNames: false,
        autoBeam: true,
        drawingParameters: 'default',
      });
    }
    await osmd.load(buildMusicXML(state.notes, scoreOptions()));
    osmd.zoom = scoreZoom;
    osmd.render();
  } catch (e) {
    console.error(e);
    el.innerHTML = '<p class="muted pad">Could not draw this score. Try a different grid or tempo setting.</p>';
    osmd = null;
  }
}
const renderScoreSoon = debounce(renderScore, 350);

function changed({ score = true, save = true, keepView = true } = {}) {
  if (state.s.keyAuto) Object.assign(state.s, detectKey(state.notes));
  syncSettingsUI();
  roll.setNotes(state.notes, { keepView });
  if (score) { scoreDirty = true; renderScoreSoon(); }
  if (save) saveSoon();
}

// ---------------------------------------------------------------- Undo / redo
function snapshot() {
  return JSON.stringify(state.notes);
}
function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 80) state.undo.shift();
  state.redo = [];
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  state.notes = JSON.parse(state.undo.pop());
  changed();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  state.notes = JSON.parse(state.redo.pop());
  changed();
}

// ---------------------------------------------------------------- Settings UI
function buildSelects() {
  const keySel = $('#key');
  keySel.innerHTML = '<option value="auto">Auto-detect</option>';
  for (const mode of ['major', 'minor']) {
    const og = document.createElement('optgroup');
    og.label = mode === 'major' ? 'Major' : 'Minor';
    for (let f = -6; f <= 6; f++) {
      const o = document.createElement('option');
      o.value = `${f}:${mode}`;
      o.textContent = keyLabel(f, mode);
      og.appendChild(o);
    }
    keySel.appendChild(og);
  }
  const split = $('#split');
  for (let p = 48; p <= 72; p++) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = noteName(p);
    split.appendChild(o);
  }
  const inst = $('#instrument');
  for (const [k, v] of Object.entries(INSTRUMENTS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v.label;
    inst.appendChild(o);
  }
}

function syncSettingsUI() {
  const s = state.s;
  $('#bpm').value = s.bpm;
  $('#offset').value = (+s.offset).toFixed(2);
  $('#timesig').value = `${s.beats}/${s.beatType}`;
  $('#grid').value = s.grid;
  $('#layout').value = s.layout;
  $('#split').value = s.split;
  $('#splitWrap').hidden = resolveLayout(state.notes, s.layout) !== 'grand';
  $('#key').value = s.keyAuto ? 'auto' : `${s.fifths}:${s.mode}`;
  $('#keyDetected').textContent = s.keyAuto ? keyLabel(s.fifths, s.mode) : '';
  $('#noteCount').textContent = `${state.notes.length} notes`;
  $('#undoBtn').disabled = !state.undo.length;
  $('#redoBtn').disabled = !state.redo.length;
}

function bindSettings() {
  const upd = (fn) => () => { fn(); changed({ save: true }); };
  $('#bpm').addEventListener('change', upd(() => (state.s.bpm = Math.min(300, Math.max(30, +$('#bpm').value || 100)))));
  $('#offset').addEventListener('change', upd(() => (state.s.offset = Math.max(0, +$('#offset').value || 0))));
  $('#timesig').addEventListener('change', upd(() => {
    const [b, t] = $('#timesig').value.split('/').map(Number);
    state.s.beats = b;
    state.s.beatType = t;
  }));
  $('#grid').addEventListener('change', upd(() => (state.s.grid = +$('#grid').value)));
  $('#layout').addEventListener('change', upd(() => (state.s.layout = $('#layout').value)));
  $('#split').addEventListener('change', upd(() => (state.s.split = +$('#split').value)));
  $('#key').addEventListener('change', upd(() => {
    const v = $('#key').value;
    if (v === 'auto') state.s.keyAuto = true;
    else {
      const [f, m] = v.split(':');
      Object.assign(state.s, { keyAuto: false, fifths: +f, mode: m });
    }
  }));
  $('#autoTempo').addEventListener('click', upd(() => Object.assign(state.s, estimateTempo(state.notes))));
  $('#title').addEventListener('change', () => {
    state.title = $('#title').value.trim() || 'Untitled';
    changed();
  });

  let taps = [];
  $('#tap').addEventListener('click', () => {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 3000);
    taps.push(now);
    if (taps.length >= 3) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      state.s.bpm = Math.round(60000 / iv);
      changed();
    }
    $('#tap').textContent = taps.length >= 3 ? `Tap (${state.s.bpm})` : `Tap ${'•'.repeat(taps.length)}`;
  });

  $$('[data-transpose]').forEach((b) =>
    b.addEventListener('click', () => {
      const d = +b.dataset.transpose;
      pushUndo();
      state.notes.forEach((n) => (n.pitch = Math.max(12, Math.min(120, n.pitch + d))));
      if (!state.s.keyAuto) {
        // move a fixed key signature along with the notes
        let f = state.s.fifths + d * 7;
        f = ((f % 12) + 12 + 6) % 12 - 6;
        state.s.fifths = f;
      }
      changed();
    }),
  );
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
}

// ---------------------------------------------------------------- Playback
function updateTime(t) {
  const total = Math.max(state.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0), state.audio?.duration || 0);
  $('#time').textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
}

function tick() {
  if (!player.playing) return;
  const t = player.position();
  roll.setPlayhead(t, true);
  updateTime(t);
  requestAnimationFrame(tick);
}

async function togglePlay() {
  if (player.playing) {
    state.cursor = player.position();
    player.stop();
    setPlayIcon(false);
    return;
  }
  const sound = $('#sound').value;
  const synth = sound !== 'off';
  const audio = $('#origAudio').checked ? state.audio : null;
  if (!synth && !audio) {
    toast('Choose a sound or tick "Original audio" to hear something.');
    return;
  }
  player.sound = sound;
  if (sound === 'piano' && !player.pianoReady) {
    const btn = $('#playBtn');
    btn.disabled = true;
    try {
      await player.loadPiano((p) => ($('#time').textContent = `Loading piano ${Math.round(p * 100)}%`));
    } catch {
      toast('The piano sound could not be loaded, so the simple synth is playing instead.');
    } finally {
      btn.disabled = false;
    }
  }
  player.play(state.notes, { from: state.cursor, speed: +$('#speed').value, synth, audio });
  setPlayIcon(true);
  requestAnimationFrame(tick);
}
player.onEnd = () => {
  state.cursor = 0;
  setPlayIcon(false);
  roll.setPlayhead(0);
  updateTime(0);
};
function setPlayIcon(on) {
  $('#playBtn').innerHTML = on
    ? '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  $('#playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
}
function seek(t) {
  const wasPlaying = player.playing;
  if (wasPlaying) player.stop();
  state.cursor = t;
  roll.setPlayhead(t);
  updateTime(t);
  if (wasPlaying) togglePlay();
}

// ---------------------------------------------------------------- Views
function showView(v) {
  state.view = v;
  $$('.view-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('#scoreView').hidden = v !== 'score';
  $('#rollView').hidden = v !== 'roll';
  if (v === 'score') renderScore();
  else roll.draw();
}

// ---------------------------------------------------------------- Recording
let recorder = null, recChunks = [], recStart = 0, recTimer = null, recStream = null;
async function toggleRecord() {
  const btn = $('#recBtn');
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch {
    toast('Microphone access was blocked. Allow it in your browser settings and try again.', 6000);
    return;
  }
  recChunks = [];
  recorder = new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    clearInterval(recTimer);
    recStream.getTracks().forEach((t) => t.stop());
    btn.classList.remove('recording');
    $('#recLabel').textContent = 'Start recording';
    const blob = new Blob(recChunks, { type: recorder.mimeType });
    const buf = await blob.arrayBuffer();
    const ext = (recorder.mimeType.split('/')[1] || 'webm').split(';')[0];
    const title = `Recording ${new Date().toLocaleString()}`;
    handleAudio(buf, title, new File([blob], `recording.${ext}`, { type: blob.type || 'audio/webm' }));
  };
  recorder.start();
  recStart = Date.now();
  btn.classList.add('recording');
  $('#recLabel').textContent = 'Stop & transcribe';
  recTimer = setInterval(() => ($('#recTime').textContent = fmtTime((Date.now() - recStart) / 1000)), 250);
}

// ---------------------------------------------------------------- Demo
function demoNotes() {
  // "Ode to Joy" (Beethoven, public domain) with a simple left hand, at 100 BPM
  const b = 0.6, notes = [];
  const mel = [
    [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2],
    [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1], [62, 1.5], [60, 0.5], [60, 2],
  ];
  let t = 0;
  for (const [p, d] of mel) { notes.push({ start: t * b, dur: d * b * 0.92, pitch: p, vel: 88 }); t += d; }
  const lh = [48, 52, 43, 48, 48, 52, 43, 43, 48, 52, 43, 48, 48, 43, 48, 48];
  lh.forEach((p, i) => notes.push({ start: i * 2 * b, dur: 2 * b * 0.95, pitch: p, vel: 70 }));
  notes.push({ start: 30 * b, dur: 2 * b, pitch: 36, vel: 70 });
  return notes.map((n) => ({ ...n, id: uid() })).sort((a, c) => a.start - c.start);
}

// ---------------------------------------------------------------- Tidy notes
function tidyNotes() {
  const { bpm, offset } = state.s;
  const step = 60 / bpm / Math.min(state.s.grid, 2); // tidy to 8th notes at the finest
  const minDur = Math.min(0.09, step * 0.45);
  const before = state.notes.length;
  const kept = state.notes.filter((n) => n.dur >= minDur && (n.vel ?? 90) >= 38);
  for (const n of kept) {
    const s0 = offset + Math.round((n.start - offset) / step) * step;
    n.start = Math.max(0, +s0.toFixed(4));
    n.dur = Math.max(step, Math.round(n.dur / step) * step);
  }
  // remove duplicates and stop overlapping repeats of the same pitch
  kept.sort((a, b) => a.pitch - b.pitch || a.start - b.start);
  const out = [];
  for (const n of kept) {
    const prev = out[out.length - 1];
    if (prev && prev.pitch === n.pitch) {
      if (Math.abs(prev.start - n.start) < 1e-6) { prev.dur = Math.max(prev.dur, n.dur); prev.vel = Math.max(prev.vel, n.vel); continue; }
      if (prev.start + prev.dur > n.start) prev.dur = n.start - prev.start;
    }
    out.push(n);
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { notes: out, removed: before - out.length };
}

// ---------------------------------------------------------------- Misc
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- Wire up
const roll = new PianoRoll($('#roll'), {
  getTiming: () => ({ ...state.s, layout: resolveLayout(state.notes, state.s.layout) }),
  onSeek: seek,
  onPreview: (p, v) => player.preview(p, v),
  onEdit: (phase) => {
    if (phase === 'begin') pushUndo();
    else changed();
  },
});

buildSelects();
bindSettings();
setPlayIcon(false);

$('#instrument').addEventListener('change', () => {
  const e = INSTRUMENTS[$('#instrument').value].engine;
  $('#engineHint').textContent = e === 'ai' ? 'Recommended: AI (chords & multiple notes)' : 'Recommended: Melody (one note at a time)';
});
$('#instrument').dispatchEvent(new Event('change'));

$$('.src-tab').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.src-tab').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $$('.src-pane').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.pane));
  }),
);

const drop = $('#drop');
const fileInput = $('#file');
const takeFile = async (file) => {
  if (!file) return;
  const title = file.name.replace(/\.[^.]+$/, '');
  handleAudio(await file.arrayBuffer(), title, file);
};
fileInput.addEventListener('change', () => takeFile(fileInput.files[0]).finally(() => (fileInput.value = '')));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

$('#recBtn').addEventListener('click', toggleRecord);
$('#demoBtn').addEventListener('click', () =>
  openTranscription({
    id: 'demo-' + Date.now().toString(36),
    title: 'Ode to Joy (demo)',
    instrument: 'piano',
    notes: demoNotes(),
    audio: null,
    s: { bpm: 100, offset: 0, beats: 4, beatType: 4, grid: 4, layout: 'grand', split: 60, keyAuto: true, fifths: 0, mode: 'major' },
  }),
);

$('#playBtn').addEventListener('click', togglePlay);
$('#tidyBtn').addEventListener('click', () => {
  pushUndo();
  const { notes, removed } = tidyNotes();
  state.notes = notes;
  if (state.s.grid > 2) state.s.grid = 2;
  changed();
  toast(`Tidied: removed ${removed} stray note${removed === 1 ? '' : 's'} and lined everything up with the beat. Undo with ↶.`, 4500);
});
$('#sound').addEventListener('change', () => {
  player.sound = $('#sound').value;
  if (player.sound === 'piano') player.loadPiano().catch(() => {});
});
$('#stopBtn').addEventListener('click', () => { player.stop(); setPlayIcon(false); seek(0); });
$('#speed').addEventListener('change', () => { if (player.playing) { state.cursor = player.position(); player.stop(); togglePlay(); } });
$$('.view-tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('#zoomRoll').addEventListener('input', (e) => roll.setZoom(+e.target.value));
$('#zoomScore').addEventListener('input', (e) => {
  scoreZoom = +e.target.value;
  if (osmd) { osmd.zoom = scoreZoom; osmd.render(); }
});

$('#dlXml').addEventListener('click', () => download(`${safeName()}.musicxml`, buildMusicXML(state.notes, scoreOptions()), 'application/vnd.recordare.musicxml+xml'));
$('#dlMidi').addEventListener('click', () => download(`${safeName()}.mid`, buildMidi(state.notes, scoreOptions()), 'audio/midi'));
$('#dlPdf').addEventListener('click', async () => {
  showView('score');
  await renderScore();
  toast('Choose "Save as PDF" in the print dialog.');
  setTimeout(() => window.print(), 300);
});
$('#backBtn').addEventListener('click', () => {
  player.stop();
  setPlayIcon(false);
  $('#editor').hidden = true;
  $('#home').hidden = false;
  history.replaceState(null, '', location.pathname);
});
$('#libBtn').addEventListener('click', () => { $('#library').showModal(); renderLibrary(); });
$('#libClose').addEventListener('click', () => $('#library').close());

document.addEventListener('keydown', (e) => {
  if ($('#editor').hidden || e.target.closest('input, select, textarea, dialog')) return;
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

window.addEventListener('resize', debounce(() => !$('#editor').hidden && state.view === 'roll' && roll.draw(), 200));

connectServer();
