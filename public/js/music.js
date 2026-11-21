// Pure music helpers: key & tempo detection, quantization, MusicXML and MIDI export.
// No DOM access here, so this file can be unit-tested in Node.

export const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(midi, useFlats = false) {
  const pc = ((midi % 12) + 12) % 12;
  return (useFlats ? FLAT : SHARP)[pc] + (Math.floor(midi / 12) - 1);
}

// ---------- Key detection (Krumhansl–Schmuckler) ----------
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
const FIFTHS_TO_MAJOR_PC = Object.fromEntries(Object.entries(MAJOR_FIFTHS).map(([pc, f]) => [f, +pc]));

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function detectKey(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[((n.pitch % 12) + 12) % 12] += Math.min(n.dur, 2) * ((n.vel || 80) / 80);
  if (h.every((v) => v === 0)) return { fifths: 0, mode: 'major' };
  let best = { score: -Infinity };
  for (let t = 0; t < 12; t++) {
    for (const [mode, prof] of [['major', MAJ], ['minor', MIN]]) {
      const rot = prof.map((_, i) => prof[(i - t + 12) % 12]);
      const score = pearson(rot, h);
      if (score > best.score) best = { score, tonic: t, mode };
    }
  }
  const majorPc = best.mode === 'major' ? best.tonic : (best.tonic + 3) % 12;
  return { fifths: MAJOR_FIFTHS[majorPc], mode: best.mode };
}

export function keyLabel(fifths, mode) {
  const majorPc = FIFTHS_TO_MAJOR_PC[fifths];
  const pc = mode === 'minor' ? (majorPc + 9) % 12 : majorPc;
  const names = fifths < 0 ? FLAT : SHARP;
  return `${names[pc]} ${mode}`;
}

// ---------- Tempo estimation ----------
export function estimateTempo(notes) {
  const starts = notes.map((n) => n.start).sort((a, b) => a - b);
  const onsets = [];
  for (const t of starts) if (!onsets.length || t - onsets[onsets.length - 1] > 0.05) onsets.push(t);
  if (onsets.length < 4) return { bpm: 100, offset: onsets[0] || 0 };
  let best = null;
  for (let bpm = 60; bpm <= 170; bpm += 0.5) {
    const b = 60 / bpm;
    let re = 0, im = 0;
    for (const t of onsets) {
      const a = (2 * Math.PI * t) / b;
      re += Math.cos(a);
      im += Math.sin(a);
    }
    const R = Math.hypot(re, im) / onsets.length;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 100) / 0.5) ** 2);
    const score = R * prior;
    if (!best || score > best.score) best = { score, bpm, phase: Math.atan2(im, re) };
  }
  const b = 60 / best.bpm;
  let t0 = ((best.phase / (2 * Math.PI)) * b + b) % b;
  const k = Math.floor((onsets[0] - t0) / b + 0.15);
  const offset = Math.max(0, t0 + k * b);
  return { bpm: Math.round(best.bpm), offset: +offset.toFixed(3) };
}

// ---------- Quantization & score building ----------
export const DIV = 4; // MusicXML divisions per quarter note (16th-note resolution)
const DUR_TYPES = [
  [16, 'whole', 0], [12, 'half', 1], [8, 'half', 0], [6, 'quarter', 1],
  [4, 'quarter', 0], [3, 'eighth', 1], [2, 'eighth', 0], [1, '16th', 0],
];

export function measureUnits(beats, beatType) {
  return Math.round(beats * (4 / beatType) * DIV);
}
function beatUnits(beats, beatType) {
  if (beatType === 8 && beats % 3 === 0) return 6;
  return Math.round((4 / beatType) * DIV);
}

export function quantize(notes, opt) {
  const unit = 60 / opt.bpm / DIV;
  const step = DIV / (opt.grid || 4);
  return notes.map((n) => {
    const s = Math.max(0, Math.round((n.start - opt.offset) / unit / step) * step);
    let e = Math.round((n.start + n.dur - opt.offset) / unit / step) * step;
    if (e <= s) e = s + step;
    return { pitch: n.pitch, s, e };
  });
}

function toEvents(ns, total) {
  const groups = new Map();
  for (const n of ns) {
    if (n.s >= total) continue;
    const g = groups.get(n.s) || { pitches: new Set(), e: 0 };
    g.pitches.add(n.pitch);
    g.e = Math.max(g.e, n.e);
    groups.set(n.s, g);
  }
  const starts = [...groups.keys()].sort((a, b) => a - b);
  const out = [];
  let cur = 0;
  starts.forEach((s, i) => {
    if (s > cur) out.push({ start: cur, len: s - cur, pitches: null });
    const g = groups.get(s);
    const end = Math.min(g.e, starts[i + 1] ?? Infinity, total);
    out.push({ start: s, len: end - s, pitches: [...g.pitches].sort((a, b) => a - b) });
    cur = end;
  });
  if (cur < total) out.push({ start: cur, len: total - cur, pitches: null });
  return out;
}

function decompose(len, pos, beatLen) {
  const out = [];
  let p = pos, L = len;
  while (L > 0) {
    const toBeat = (beatLen - (p % beatLen)) % beatLen;
    const limit = toBeat && L > toBeat ? toBeat : L;
    const d = DUR_TYPES.find(([u]) => u <= limit)[0];
    out.push(d);
    p += d;
    L -= d;
  }
  return out;
}

function splitIntoMeasures(events, ML, BL, count) {
  const measures = Array.from({ length: count }, () => []);
  for (const ev of events) {
    const pieces = [];
    let pos = ev.start, remaining = ev.len;
    while (remaining > 0) {
      const m = Math.floor(pos / ML);
      const inM = pos - m * ML;
      const chunk = Math.min(remaining, ML - inM);
      for (const d of decompose(chunk, inM, BL)) pieces.push({ m, d });
      pos += chunk;
      remaining -= chunk;
    }
    pieces.forEach((pc, i) => {
      if (pc.m >= count) return;
      measures[pc.m].push({
        len: pc.d,
        pitches: ev.pitches,
        tieStart: !!ev.pitches && i < pieces.length - 1,
        tieStop: !!ev.pitches && i > 0,
      });
    });
  }
  return measures;
}

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function pitchXml(midi, useFlats) {
  const name = (useFlats ? FLAT : SHARP)[((midi % 12) + 12) % 12];
  const step = name[0];
  const alter = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
}

function noteXml(item, staff, voice, useFlats, grand) {
  const [, type, dot] = DUR_TYPES.find(([u]) => u === item.len);
  const staffTag = grand ? `<staff>${staff}</staff>` : '';
  if (!item.pitches) {
    return `<note><rest/><duration>${item.len}</duration><voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}${staffTag}</note>`;
  }
  return item.pitches.map((p, i) => {
    const ties = (item.tieStop ? '<tie type="stop"/>' : '') + (item.tieStart ? '<tie type="start"/>' : '');
    const tied = (item.tieStop ? '<tied type="stop"/>' : '') + (item.tieStart ? '<tied type="start"/>' : '');
    return `<note>${i ? '<chord/>' : ''}${pitchXml(p, useFlats)}<duration>${item.len}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}${staffTag}${tied ? `<notations>${tied}</notations>` : ''}</note>`;
  }).join('');
}

export function resolveLayout(notes, layout) {
  if (layout !== 'auto') return layout;
  if (!notes.length) return 'treble';
  const sorted = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.9)];
  if (hi - lo > 19 && lo < 55 && hi > 64) return 'grand';
  return sorted[Math.floor(sorted.length / 2)] >= 57 ? 'treble' : 'bass';
}

export function buildMusicXML(notes, opt) {
  const ML = measureUnits(opt.beats, opt.beatType);
  const BL = beatUnits(opt.beats, opt.beatType);
  const q = quantize(notes, opt);
  const layout = resolveLayout(notes, opt.layout);
  const grand = layout === 'grand';
  const staves = grand
    ? [q.filter((n) => n.pitch >= opt.split), q.filter((n) => n.pitch < opt.split)]
    : [q];
  const maxEnd = q.reduce((m, n) => Math.max(m, n.e), 0);
  const count = Math.max(1, Math.ceil(maxEnd / ML));
  const total = count * ML;
  const useFlats = opt.fifths < 0;
  const staffMeasures = staves.map((ns) => splitIntoMeasures(toEvents(ns, total), ML, BL, count));

  const clefs = grand
    ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'
    : layout === 'bass'
      ? '<clef><sign>F</sign><line>4</line></clef>'
      : '<clef><sign>G</sign><line>2</line></clef>';

  let body = '';
  for (let m = 0; m < count; m++) {
    body += `<measure number="${m + 1}">`;
    if (m === 0) {
      body += `<attributes><divisions>${DIV}</divisions><key><fifths>${opt.fifths}</fifths><mode>${opt.mode}</mode></key><time><beats>${opt.beats}</beats><beat-type>${opt.beatType}</beat-type></time>${clefs}</attributes>`;
      body += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(opt.bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(opt.bpm)}"/></direction>`;
    }
    staffMeasures.forEach((measures, si) => {
      if (si > 0) body += `<backup><duration>${ML}</duration></backup>`;
      const items = measures[m];
      const voice = si === 0 ? 1 : 5;
      if (items.every((it) => !it.pitches)) {
        body += `<note><rest measure="yes"/><duration>${ML}</duration><voice>${voice}</voice>${grand ? `<staff>${si + 1}</staff>` : ''}</note>`;
      } else {
        for (const it of items) body += noteXml(it, si + 1, voice, useFlats, grand);
      }
    });
    if (m === count - 1) body += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    body += '</measure>';
  }

  const partName = grand ? 'Piano' : opt.partName || 'Melody';
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(opt.title || 'Untitled')}</work-title></work><identification><encoding><software>Tunescribe</software></encoding></identification><part-list><score-part id="P1"><part-name>${esc(partName)}</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
}

// ---------- MIDI export ----------
function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
function str(s) {
  return [...new TextEncoder().encode(s)];
}
function chunk(id, data) {
  const len = data.length;
  return [...str(id), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

export function buildMidi(notes, opt) {
  const ppq = 480;
  const beatSec = 60 / opt.bpm;
  const tick = (sec) => Math.max(0, Math.round(((sec - opt.offset) / beatSec) * ppq));
  const usPerQ = Math.round(60e6 / opt.bpm);
  const meta = [
    0, 0xff, 0x51, 3, (usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255,
    0, 0xff, 0x58, 4, opt.beats, Math.log2(opt.beatType), 24, 8,
    0, 0xff, 0x59, 2, (opt.fifths + 256) & 255, opt.mode === 'minor' ? 1 : 0,
    0, 0xff, 0x03, ...vlq(str(opt.title || 'Tunescribe').length), ...str(opt.title || 'Tunescribe'),
    0, 0xff, 0x2f, 0,
  ];
  const layout = resolveLayout(notes, opt.layout);
  const groups = layout === 'grand'
    ? [['Right hand', notes.filter((n) => n.pitch >= opt.split)], ['Left hand', notes.filter((n) => n.pitch < opt.split)]]
    : [[opt.partName || 'Melody', notes]];
  const tracks = [chunk('MTrk', meta)];
  groups.forEach(([name, ns], ch) => {
    const evs = [];
    for (const n of ns) {
      const on = tick(n.start);
      const off = Math.max(on + 1, tick(n.start + n.dur));
      const p = Math.max(0, Math.min(127, Math.round(n.pitch)));
      evs.push([on, 1, p, Math.max(1, Math.min(127, n.vel || 90))], [off, 0, p, 0]);
    }
    evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const data = [0, 0xff, 0x03, ...vlq(str(name).length), ...str(name), 0, 0xc0 | ch, 0];
    let last = 0;
    for (const [t, on, p, v] of evs) {
      data.push(...vlq(t - last), (on ? 0x90 : 0x80) | ch, p, v);
      last = t;
    }
    data.push(0, 0xff, 0x2f, 0);
    tracks.push(chunk('MTrk', data));
  });
  const header = chunk('MThd', [0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255]);
  return new Uint8Array([...header, ...tracks.flat()]);
}
