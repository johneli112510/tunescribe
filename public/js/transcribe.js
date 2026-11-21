// Audio -> notes. Two engines:
//  1. "ai": Spotify's open-source Basic Pitch model (polyphonic), loaded from a CDN on first use.
//  2. "melody": a built-in YIN pitch tracker (monophonic) that works fully offline.

export const SAMPLE_RATE = 22050;
const BASIC_PITCH_MODULE = 'https://esm.sh/@spotify/basic-pitch@1.0.1';
const BASIC_PITCH_MODEL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';

let bpPromise = null;
function loadBasicPitch() {
  if (!bpPromise) {
    bpPromise = import(/* @vite-ignore */ BASIC_PITCH_MODULE).catch((e) => {
      bpPromise = null;
      throw e;
    });
  }
  return bpPromise;
}

export async function transcribeAI(samples, { sensitivity = 0.5, onProgress = () => {} } = {}) {
  const bp = await loadBasicPitch();
  const model = new bp.BasicPitch(BASIC_PITCH_MODEL);
  const frames = [], onsets = [], contours = [];
  await model.evaluateModel(
    samples,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (p) => onProgress(p),
  );
  const onsetThresh = 0.7 - sensitivity * 0.45;
  const frameThresh = 0.42 - sensitivity * 0.2;
  const events = bp.noteFramesToTime(
    bp.addPitchBendsToNoteEvents(contours, bp.outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, 8)),
  );
  return events
    .map((n) => ({
      start: n.startTimeSeconds,
      dur: n.durationSeconds,
      pitch: Math.round(n.pitchMidi),
      vel: Math.round(35 + Math.min(1, n.amplitude) * 90),
    }))
    .filter((n) => n.dur > 0.03)
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// ---------- YIN monophonic tracker ----------
export async function transcribeMelody(x, sr = SAMPLE_RATE, { sensitivity = 0.5, onProgress = () => {} } = {}) {
  const hop = 256, win = 768;
  const minHz = 65, maxHz = 1600;
  const tauMin = Math.floor(sr / maxHz);
  const tauMax = Math.min(Math.ceil(sr / minHz), win - 1);
  const silenceDb = -52 + (1 - sensitivity) * 16; // -52 dB (sensitive) .. -36 dB
  const threshold = 0.12 + sensitivity * 0.1;
  const d = new Float32Array(tauMax + 2);
  const frames = [];
  const nFrames = Math.max(0, Math.floor((x.length - win - tauMax) / hop));

  for (let f = 0; f < nFrames; f++) {
    const i = f * hop;
    let e = 0;
    for (let j = 0; j < win; j++) e += x[i + j] * x[i + j];
    const rms = Math.sqrt(e / win);
    const db = 20 * Math.log10(rms + 1e-12);
    if (db < silenceDb) {
      frames.push({ midi: null, rms });
    } else {
      d[0] = 1;
      let running = 0, tau = -1;
      for (let t = 1; t <= tauMax; t++) {
        let s = 0;
        for (let j = 0; j < win; j++) {
          const diff = x[i + j] - x[i + j + t];
          s += diff * diff;
        }
        running += s;
        d[t] = running ? (s * t) / running : 1;
      }
      for (let t = tauMin; t < tauMax; t++) {
        if (d[t] < threshold) {
          while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
          tau = t;
          break;
        }
      }
      if (tau < 0) {
        frames.push({ midi: null, rms });
      } else {
        const a = d[tau - 1], b = d[tau], c = d[tau + 1];
        const denom = a - 2 * b + c;
        const betterTau = denom ? tau + (0.5 * (a - c)) / denom : tau;
        const hz = sr / betterTau;
        frames.push({ midi: 69 + 12 * Math.log2(hz / 440), rms });
      }
    }
    if (f % 400 === 0) {
      onProgress(f / nFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress(1);
  return segmentFrames(frames, hop, sr);
}

function segmentFrames(frames, hop, sr) {
  const raw = frames.map((f) => (f.midi == null ? null : Math.round(f.midi)));
  // 5-frame median smoothing to remove octave blips
  const midi = raw.map((v, i) => {
    if (v == null) return null;
    const w = raw.slice(Math.max(0, i - 2), i + 3).filter((n) => n != null).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const notes = [];
  const minFrames = 5;
  let cur = null;
  const close = (end) => {
    if (cur && end - cur.from >= minFrames) {
      const rmsAvg = cur.rmsSum / (end - cur.from);
      const db = 20 * Math.log10(rmsAvg + 1e-12);
      notes.push({
        start: (cur.from * hop) / sr,
        dur: ((end - cur.from) * hop) / sr,
        pitch: cur.pitch,
        vel: Math.round(Math.max(30, Math.min(120, 40 + (db + 45) * 2))),
      });
    }
    cur = null;
  };
  for (let i = 0; i < midi.length; i++) {
    const p = midi[i];
    const r = frames[i].rms;
    const prevMin = Math.min(...frames.slice(Math.max(0, i - 4), i).map((f) => f.rms), Infinity);
    const reattack = cur && i - cur.from > 6 && r > prevMin * 2.2;
    if (p == null) {
      close(i);
    } else if (!cur || p !== cur.pitch || reattack) {
      close(i);
      cur = { pitch: p, from: i, rmsSum: r };
    } else {
      cur.rmsSum += r;
    }
  }
  close(midi.length);
  return notes;
}
