// Web Audio playback: a sampled concert grand (Salamander Grand Piano, CC-BY 3.0),
// a fallback synth, and optional original audio.

// One recording every 3 semitones from A0 to C8; other notes are pitch-shifted from the nearest one.
const SAMPLE_NAMES = { 9: 'A', 0: 'C', 3: 'Ds', 6: 'Fs' };
const SAMPLE_PITCHES = [];
for (let p = 21; p <= 108; p += 3) SAMPLE_PITCHES.push(p);
const sampleFile = (p) => `${SAMPLE_NAMES[p % 12]}${Math.floor(p / 12) - 1}.mp3`;
const SAMPLE_SOURCES = ['/api/samples/', 'https://tonejs.github.io/audio/salamander/'];

export class Player {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.voices = new Set();
    this.onEnd = null;
    this.sound = 'piano';
    this.samples = new Map();
    this.pianoPromise = null;
  }

  // Loads all piano samples (≈3 MB, cached by the browser and by the server's R2 bucket).
  loadPiano(onProgress = () => {}) {
    if (this.pianoPromise) return this.pianoPromise;
    const ctx = this.ensure();
    let done = 0;
    const loadOne = async (p) => {
      const file = sampleFile(p);
      for (const base of SAMPLE_SOURCES) {
        try {
          const res = await fetch(base + file);
          if (!res.ok) continue;
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          this.samples.set(p, buf);
          break;
        } catch {}
      }
      onProgress(++done / SAMPLE_PITCHES.length);
    };
    this.pianoPromise = Promise.all(SAMPLE_PITCHES.map(loadOne)).then(() => {
      if (this.samples.size < SAMPLE_PITCHES.length / 2) {
        this.pianoPromise = null;
        throw new Error('Piano samples unavailable');
      }
    });
    return this.pianoPromise;
  }

  get pianoReady() {
    return this.samples.size >= SAMPLE_PITCHES.length / 2;
  }

  pianoVoice(pitch, when, dur, vel = 90) {
    const ctx = this.ctx;
    let best = null;
    for (const p of this.samples.keys()) if (best == null || Math.abs(p - pitch) < Math.abs(best - pitch)) best = p;
    const src = ctx.createBufferSource();
    src.buffer = this.samples.get(best);
    src.playbackRate.value = 2 ** ((pitch - best) / 12);
    const g = ctx.createGain();
    const level = 0.12 + ((vel / 127) ** 1.6) * 0.75;
    g.gain.setValueAtTime(level, when);
    // key release: dampers come down over ~0.25 s
    const end = when + Math.max(0.08, dur);
    g.gain.setValueAtTime(level, end);
    g.gain.setTargetAtTime(0, end, 0.12);
    src.connect(g).connect(this.synthBus);
    src.start(when);
    src.stop(end + 1.2);
    const v = { o1: src, o2: null, g };
    this.voices.add(v);
    src.onended = () => this.voices.delete(v);
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createDynamicsCompressor();
      this.master.threshold.value = -14;
      this.master.connect(this.ctx.destination);
      this.synthBus = this.ctx.createGain();
      // gentle room reverb so the piano sounds natural rather than dry
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(2.2);
      const wet = this.ctx.createGain();
      wet.gain.value = 0.18;
      this.synthBus.connect(this.master);
      this.synthBus.connect(this.reverb).connect(wet).connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  voice(pitch, when, dur, vel = 90) {
    if (this.sound === 'piano' && this.pianoReady) return this.pianoVoice(pitch, when, dur, vel);
    const ctx = this.ctx;
    const f = 440 * 2 ** ((pitch - 69) / 12);
    const peak = (vel / 127) * 0.22;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, f * 8), when);
    lp.frequency.setTargetAtTime(Math.min(4000, f * 3), when, 0.3);
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    o1.type = 'triangle';
    o2.type = 'sine';
    o1.frequency.value = f;
    o2.frequency.value = f * 2;
    o2.detune.value = 4;
    g2.gain.value = 0.25;
    o1.connect(g);
    o2.connect(g2).connect(g);
    g.connect(lp).connect(this.synthBus);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.setTargetAtTime(peak * 0.12, when + 0.01, 0.7);
    const end = when + Math.max(0.05, dur);
    g.gain.setTargetAtTime(0, end, 0.07);
    o1.start(when);
    o2.start(when);
    o1.stop(end + 0.6);
    o2.stop(end + 0.6);
    const v = { o1, o2, g };
    this.voices.add(v);
    o1.onended = () => this.voices.delete(v);
  }

  makeImpulse(seconds) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    return buf;
  }

  preview(pitch, vel = 90) {
    this.ensure();
    this.voice(pitch, this.ctx.currentTime + 0.01, 0.4, vel);
  }

  play(notes, { from = 0, speed = 1, synth = true, audio = null, audioVolume = 0.8 } = {}) {
    this.stop();
    const ctx = this.ensure();
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.from = from;
    this.speed = speed;
    this.t0 = ctx.currentTime + 0.08;
    this.synthOn = synth;
    this.idx = this.notes.findIndex((n) => n.start >= from);
    if (this.idx < 0) this.idx = this.notes.length;
    this.end = Math.max(this.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0), audio ? audio.duration : 0);
    if (audio) {
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = audioVolume;
      src.buffer = audio;
      src.playbackRate.value = speed;
      src.connect(g).connect(this.master);
      src.start(this.t0, Math.min(from, audio.duration));
      this.src = src;
    }
    this.synthBus.gain.value = synth ? 1 : 0;
    this.playing = true;
    this.timer = setInterval(() => this.schedule(), 40);
    this.schedule();
  }

  toCtx(sec) {
    return this.t0 + (sec - this.from) / this.speed;
  }

  schedule() {
    const ctx = this.ctx;
    const horizon = ctx.currentTime + 0.3;
    while (this.idx < this.notes.length && this.toCtx(this.notes[this.idx].start) < horizon) {
      const n = this.notes[this.idx++];
      if (this.synthOn) this.voice(n.pitch, Math.max(ctx.currentTime, this.toCtx(n.start)), n.dur / this.speed, n.vel);
    }
    if (this.position() > this.end + 0.8) {
      this.stop();
      this.onEnd?.();
    }
  }

  position() {
    if (!this.playing) return this.from || 0;
    return this.from + Math.max(0, this.ctx.currentTime - this.t0) * this.speed;
  }

  stop() {
    clearInterval(this.timer);
    if (this.src) {
      try { this.src.stop(); } catch {}
      this.src = null;
    }
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const v of this.voices) {
        try {
          v.g.gain.cancelScheduledValues(now);
          v.g.gain.setTargetAtTime(0, now, 0.02);
          v.o1.stop(now + 0.1);
          v.o2?.stop(now + 0.1);
        } catch {}
      }
    }
    this.voices.clear();
    this.playing = false;
  }
}
