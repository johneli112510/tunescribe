// Interactive piano roll on <canvas>: select, drag, resize, add and delete notes.
import { noteName } from './music.js';

const KEYS_W = 54, RULER_H = 24;
const isBlack = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

export class PianoRoll {
  constructor(root, { onEdit, onSeek, onPreview, getTiming }) {
    this.root = root;
    this.onEdit = onEdit;
    this.onSeek = onSeek;
    this.onPreview = onPreview;
    this.getTiming = getTiming; // () => ({bpm, offset, beats, beatType, grid, split})
    this.notes = [];
    this.selected = new Set();
    this.pps = 90; // pixels per second
    this.rowH = 12;
    this.playhead = 0;
    root.innerHTML = `
      <div class="pr-grid">
        <canvas class="pr-corner"></canvas>
        <canvas class="pr-ruler"></canvas>
        <canvas class="pr-keys"></canvas>
        <div class="pr-roll-wrap"><canvas class="pr-roll" tabindex="0"></canvas><div class="pr-playhead"></div></div>
      </div>`;
    this.cCorner = root.querySelector('.pr-corner');
    this.cRuler = root.querySelector('.pr-ruler');
    this.cKeys = root.querySelector('.pr-keys');
    this.cRoll = root.querySelector('.pr-roll');
    this.playEl = root.querySelector('.pr-playhead');
    this.bind();
  }

  setNotes(notes, { keepView = false } = {}) {
    this.notes = notes;
    const ids = new Set(notes.map((n) => n.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    this.computeRange();
    this.draw();
    if (!keepView) this.scrollToNotes();
  }

  computeRange() {
    let lo = 60, hi = 72;
    if (this.notes.length) {
      lo = Math.min(...this.notes.map((n) => n.pitch));
      hi = Math.max(...this.notes.map((n) => n.pitch));
    }
    lo -= 4; hi += 4;
    while (hi - lo < 36) { lo--; hi++; }
    this.lo = Math.max(12, lo);
    this.hi = Math.min(120, hi);
    this.duration = Math.max(8, this.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0) + 4);
    this.clampZoom();
  }

  clampZoom() {
    const maxW = 30000 / (window.devicePixelRatio || 1);
    this.pps = Math.min(this.pps, maxW / this.duration);
  }

  scrollToNotes() {
    const p = this.notes.length ? this.notes.reduce((s, n) => s + n.pitch, 0) / this.notes.length : 66;
    this.root.scrollTop = Math.max(0, (this.hi - p) * this.rowH - this.root.clientHeight / 2);
  }

  setZoom(pps) {
    const center = (this.root.scrollLeft + this.root.clientWidth / 2) / this.pps;
    this.pps = pps;
    this.clampZoom();
    this.draw();
    this.root.scrollLeft = center * pps - this.root.clientWidth / 2;
  }

  y(p) { return (this.hi - p) * this.rowH; }
  x(t) { return t * this.pps; }

  sizeCanvas(c, w, h) {
    const dpr = window.devicePixelRatio || 1;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  draw() {
    if (this.lo == null) this.computeRange();
    const W = Math.ceil(this.x(this.duration));
    const H = (this.hi - this.lo + 1) * this.rowH;
    const tm = this.getTiming();
    const beat = 60 / tm.bpm;
    const barBeats = tm.beats * (4 / tm.beatType);
    const css = getComputedStyle(document.documentElement);
    const col = (v, d) => css.getPropertyValue(v).trim() || d;
    const accent = col('--accent', '#5b4bdb');
    const accent2 = col('--accent-2', '#e0742b');

    // keys
    let k = this.sizeCanvas(this.cKeys, KEYS_W, H);
    for (let p = this.hi; p >= this.lo; p--) {
      const yy = this.y(p);
      k.fillStyle = isBlack(p) ? '#2a2a33' : '#fff';
      k.fillRect(0, yy, KEYS_W, this.rowH);
      k.strokeStyle = '#d9d9e3';
      k.strokeRect(0.5, yy + 0.5, KEYS_W - 1, this.rowH);
      if (p % 12 === 0) {
        k.fillStyle = '#555';
        k.font = '10px system-ui, sans-serif';
        k.fillText(noteName(p), 6, yy + this.rowH - 2);
      }
    }

    // ruler
    const r = this.sizeCanvas(this.cRuler, W, RULER_H);
    r.fillStyle = '#f7f7fb';
    r.fillRect(0, 0, W, RULER_H);
    r.font = '10px system-ui, sans-serif';
    let bar = 1;
    for (let t = tm.offset, i = 0; t < this.duration; t += beat, i++) {
      const xx = this.x(t);
      const isBar = i % barBeats === 0;
      r.fillStyle = isBar ? '#888' : '#ccc';
      r.fillRect(xx, isBar ? 8 : 16, 1, isBar ? 16 : 8);
      if (isBar) { r.fillStyle = '#555'; r.fillText(String(bar++), xx + 3, 12); }
    }
    r.fillStyle = '#e2e2ea';
    r.fillRect(0, RULER_H - 1, W, 1);

    // corner
    const c = this.sizeCanvas(this.cCorner, KEYS_W, RULER_H);
    c.fillStyle = '#f7f7fb';
    c.fillRect(0, 0, KEYS_W, RULER_H);

    // roll
    const g = this.sizeCanvas(this.cRoll, W, H);
    for (let p = this.hi; p >= this.lo; p--) {
      g.fillStyle = isBlack(p) ? '#f1f1f6' : '#fff';
      g.fillRect(0, this.y(p), W, this.rowH);
      if (p % 12 === 0) { g.fillStyle = '#d6d6e2'; g.fillRect(0, this.y(p) + this.rowH - 1, W, 1); }
    }
    for (let t = tm.offset, i = 0; t < this.duration; t += beat, i++) {
      g.fillStyle = i % barBeats === 0 ? '#c9c9d8' : '#ececf3';
      g.fillRect(Math.round(this.x(t)), 0, 1, H);
    }
    if (tm.layout === 'grand') {
      g.fillStyle = 'rgba(224,116,43,.35)';
      g.fillRect(0, this.y(tm.split) + this.rowH - 1, W, 2);
    }
    for (const n of this.notes) {
      const xx = this.x(n.start), yy = this.y(n.pitch);
      const w = Math.max(3, this.x(n.dur));
      const lh = tm.layout === 'grand' && n.pitch < tm.split;
      g.globalAlpha = 0.55 + 0.45 * Math.min(1, (n.vel || 90) / 110);
      g.fillStyle = lh ? accent2 : accent;
      roundRect(g, xx, yy + 1, w, this.rowH - 2, 3);
      g.fill();
      g.globalAlpha = 1;
      if (this.selected.has(n.id)) {
        g.strokeStyle = '#111';
        g.lineWidth = 2;
        roundRect(g, xx, yy + 1, w, this.rowH - 2, 3);
        g.stroke();
      }
    }
    this.playEl.style.left = this.x(this.playhead) - 1 + 'px';
  }

  setPlayhead(t, follow = false) {
    this.playhead = t;
    this.playEl.style.left = this.x(t) - 1 + 'px';
    if (follow) {
      const x = this.x(t);
      const view = this.root.clientWidth - KEYS_W;
      if (x < this.root.scrollLeft || x > this.root.scrollLeft + view * 0.85) this.root.scrollLeft = x - view * 0.15;
    }
  }

  hit(px, py) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const x0 = this.x(n.start), x1 = x0 + Math.max(3, this.x(n.dur)), y0 = this.y(n.pitch);
      if (px >= x0 && px <= x1 + 2 && py >= y0 && py <= y0 + this.rowH) return { n, edge: x1 - px < 6 && x1 - x0 > 10 };
    }
    return null;
  }

  snapStep() {
    const tm = this.getTiming();
    return 60 / tm.bpm / (tm.grid || 4);
  }

  snapTime(t) {
    const tm = this.getTiming();
    const s = this.snapStep();
    return tm.offset + Math.round((t - tm.offset) / s) * s;
  }

  bind() {
    const pos = (e, el) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.cRuler.addEventListener('pointerdown', (e) => {
      const { x } = pos(e, this.cRuler);
      this.onSeek(Math.max(0, x / this.pps));
    });

    this.cKeys.addEventListener('pointerdown', (e) => {
      const { y } = pos(e, this.cKeys);
      this.onPreview(this.hi - Math.floor(y / this.rowH));
    });

    let drag = null;
    this.cRoll.addEventListener('pointerdown', (e) => {
      this.cRoll.focus();
      const { x, y } = pos(e, this.cRoll);
      const h = this.hit(x, y);
      if (!h) {
        if (!e.shiftKey) this.selected.clear();
        this.draw();
        return;
      }
      if (e.shiftKey) {
        this.selected.has(h.n.id) ? this.selected.delete(h.n.id) : this.selected.add(h.n.id);
      } else if (!this.selected.has(h.n.id)) {
        this.selected.clear();
        this.selected.add(h.n.id);
      }
      this.onPreview(h.n.pitch, h.n.vel);
      const sel = this.notes.filter((n) => this.selected.has(n.id));
      drag = { x, y, mode: h.edge ? 'resize' : 'move', orig: sel.map((n) => ({ n, start: n.start, dur: n.dur, pitch: n.pitch })), changed: false };
      this.cRoll.setPointerCapture(e.pointerId);
      this.draw();
    });

    this.cRoll.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e, this.cRoll);
      if (!drag) {
        const h = this.hit(x, y);
        this.cRoll.style.cursor = h ? (h.edge ? 'ew-resize' : 'grab') : 'crosshair';
        return;
      }
      const step = this.snapStep();
      const dt = Math.round((x - drag.x) / this.pps / step) * step;
      const dp = -Math.round((y - drag.y) / this.rowH);
      if (!drag.changed && (dt !== 0 || dp !== 0)) {
        this.onEdit('begin');
        drag.changed = true;
      }
      let lastPitch = null;
      for (const o of drag.orig) {
        if (drag.mode === 'move') {
          o.n.start = Math.max(0, o.start + dt);
          o.n.pitch = Math.max(12, Math.min(120, o.pitch + dp));
          lastPitch = o.n.pitch;
        } else {
          o.n.dur = Math.max(step, o.dur + dt);
        }
      }
      if (drag.mode === 'move' && dp !== drag.lastDp && lastPitch != null) {
        drag.lastDp = dp;
        if (drag.changed) this.onPreview(lastPitch);
      }
      this.draw();
    });

    const end = () => {
      if (drag?.changed) this.onEdit('commit');
      drag = null;
    };
    this.cRoll.addEventListener('pointerup', end);
    this.cRoll.addEventListener('pointercancel', end);

    this.cRoll.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e, this.cRoll);
      if (this.hit(x, y)) return;
      const tm = this.getTiming();
      this.onEdit('begin');
      const n = {
        id: 'n' + Math.random().toString(36).slice(2, 9),
        start: Math.max(0, this.snapTime(x / this.pps - this.snapStep() / 2)),
        dur: 60 / tm.bpm,
        pitch: this.hi - Math.floor(y / this.rowH),
        vel: 90,
      };
      this.notes.push(n);
      this.selected = new Set([n.id]);
      this.onPreview(n.pitch);
      this.onEdit('commit');
    });

    this.cRoll.addEventListener('keydown', (e) => {
      if (!this.selected.size) return;
      const sel = this.notes.filter((n) => this.selected.has(n.id));
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.onEdit('begin');
        for (let i = this.notes.length - 1; i >= 0; i--) if (this.selected.has(this.notes[i].id)) this.notes.splice(i, 1);
        this.selected.clear();
        this.onEdit('commit');
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        this.onEdit('begin');
        sel.forEach((n) => (n.pitch = Math.max(12, Math.min(120, n.pitch + d))));
        this.onPreview(sel[0].pitch);
        this.onEdit('commit');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = (e.key === 'ArrowRight' ? 1 : -1) * this.snapStep();
        this.onEdit('begin');
        sel.forEach((n) => (n.start = Math.max(0, n.start + d)));
        this.onEdit('commit');
      } else if (e.key === 'Escape') {
        this.selected.clear();
        this.draw();
      }
    });
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
