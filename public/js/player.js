// Web Audio playback: a light piano-like synth for the notes, plus optional original audio.

export class Player {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.voices = new Set();
    this.onEnd = null;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createDynamicsCompressor();
      this.master.threshold.value = -14;
      this.master.connect(this.ctx.destination);
      this.synthBus = this.ctx.createGain();
      this.synthBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  voice(pitch, when, dur, vel = 90) {
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
          v.o2.stop(now + 0.1);
        } catch {}
      }
    }
    this.voices.clear();
    this.playing = false;
  }
}
