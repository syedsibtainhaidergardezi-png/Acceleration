/**
 * visualizer.js
 *
 * Two views, both drawn on a shared log-frequency axis.
 *
 * The spectrum alone would show *that* something is happening but not *what*.
 * The point of the overlay is that you can watch the mechanism: the spectral
 * window sits still while the partials slide through it, fade in at the
 * bottom, and vanish at the top. Once you have seen the wrap happen in
 * silence, the illusion stops being mysterious and starts being obvious --
 * which, for a tool you are going to build sounds with, is the useful state.
 */

import { stackGains, windowAt, wrap, freqToNoteName } from '../engine/shepard-math.js';
import { resolveVoicing } from '../engine/voicing.js';

const MIN_HZ = 18;
const MAX_HZ = 20000;

function logX(freq, width) {
  const t = (Math.log2(Math.max(freq, MIN_HZ)) - Math.log2(MIN_HZ)) /
            (Math.log2(MAX_HZ) - Math.log2(MIN_HZ));
  return t * width;
}

/** Size a canvas for the device pixel ratio; returns CSS-pixel dimensions. */
function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export class Visualizer {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.spectrumCanvas
   * @param {HTMLCanvasElement} opts.rhythmCanvas
   * @param {AccelerationEngine} opts.engine
   */
  constructor({ spectrumCanvas, rhythmCanvas, engine }) {
    this.spectrumCanvas = spectrumCanvas;
    this.rhythmCanvas = rhythmCanvas;
    this.engine = engine;
    this.raf = null;
    this.freqData = null;
    this.beats = [];       // recent beats, for the flash decay
    this.running = false;

    engine.onBeat = (ev) => {
      this.beats.push({ ...ev, born: performance.now() });
      if (this.beats.length > 256) this.beats.splice(0, this.beats.length - 256);
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  draw() {
    this.drawSpectrum();
    this.drawRhythm();
  }

  /* ---------------------------------------------------------------------- */

  drawSpectrum() {
    const canvas = this.spectrumCanvas;
    if (!canvas) return;
    const { ctx, w, h } = fitCanvas(canvas);
    const engine = this.engine;
    const p = engine.params;

    ctx.clearRect(0, 0, w, h);

    // --- backdrop ---------------------------------------------------------
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(12,14,26,0.9)');
    bg.addColorStop(1, 'rgba(6,7,14,0.95)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // --- octave gridlines -------------------------------------------------
    ctx.strokeStyle = 'rgba(120,140,200,0.10)';
    ctx.fillStyle = 'rgba(150,170,220,0.35)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 1;
    for (let f = 20; f < MAX_HZ; f *= 2) {
      const x = logX(f, w);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (f >= 40) ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 4);
    }

    // --- live spectrum ----------------------------------------------------
    const analyser = engine.analyser;
    if (analyser) {
      if (!this.freqData || this.freqData.length !== analyser.frequencyBinCount) {
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this.freqData);

      const nyquist = engine.ctx.sampleRate / 2;
      const bins = this.freqData.length;
      ctx.beginPath();
      ctx.moveTo(0, h);
      let started = false;
      for (let i = 1; i < bins; i++) {
        const freq = (i / bins) * nyquist;
        if (freq < MIN_HZ) continue;
        if (freq > MAX_HZ) break;
        const x = logX(freq, w);
        const y = h - (this.freqData[i] / 255) * h * 0.92;
        if (!started) { ctx.lineTo(x, h); started = true; }
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, 'rgba(56,189,248,0.05)');
      grad.addColorStop(0.5, 'rgba(56,189,248,0.28)');
      grad.addColorStop(1, 'rgba(232,121,249,0.5)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(125,211,252,0.65)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- the spectral window (the thing that does not move) ----------------
    const n = Math.max(2, Math.round(p.stack.octaves));
    const base = p.stack.baseFreq;
    const topFreq = base * Math.pow(2, n);

    ctx.beginPath();
    const steps = 220;
    for (let i = 0; i <= steps; i++) {
      const e = (i / steps) * n;
      const freq = base * Math.pow(2, e);
      const g = windowAt(e, n, p.stack.shape, p.stack.sigma);
      const x = logX(freq, w);
      const y = h - g * h * 0.86;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.setLineDash([]);

    // Span markers
    ctx.fillStyle = 'rgba(148,163,184,0.45)';
    ctx.fillText(freqToNoteName(base), logX(base, w) + 3, 12);
    ctx.fillText(freqToNoteName(topFreq), Math.min(w - 24, logX(topFreq, w) + 3), 12);

    // --- the partials (the things that do) --------------------------------
    const voicing = resolveVoicing(p.tone.voicing, {
      just: p.tone.just,
      detune: p.tone.detune,
      rootShift: p.tone.rootShift,
    });

    for (let v = 0; v < voicing.offsets.length; v++) {
      const { freqs, gains } = stackGains({
        phase: engine.phase,
        octaves: n,
        baseFreq: base,
        shape: p.stack.shape,
        sigma: p.stack.sigma,
        tilt: p.stack.tilt,
        offset: voicing.offsets[v],
        levelLock: false,
      });

      for (let i = 0; i < freqs.length; i++) {
        const g = gains[i];
        if (g < 0.004) continue;
        const x = logX(freqs[i], w);
        const y = h - g * h * 0.86;
        const r = 2 + g * 5;

        const hue = v === 0 ? '56,189,248' : v === 1 ? '232,121,249' : v === 2 ? '134,239,172' : '253,224,71';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${hue},${0.25 + g * 0.7})`;
        ctx.fill();

        // Drop line, so the frequency reading is unambiguous.
        ctx.beginPath();
        ctx.moveTo(x, y + r);
        ctx.lineTo(x, h);
        ctx.strokeStyle = `rgba(${hue},${0.06 + g * 0.16})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // --- readout ----------------------------------------------------------
    const cyclePos = wrap(engine.phase, 1);
    ctx.fillStyle = 'rgba(226,232,240,0.75)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(
      `phase ${engine.phase.toFixed(2)} oct   cycle ${(cyclePos * 100).toFixed(0)}%`,
      8,
      h - 18
    );
  }

  /* ---------------------------------------------------------------------- */

  /**
   * The rhythm view is the tempo-domain twin of the spectrum view: the same
   * window, the same sliding, but the axis is beats per second instead of Hz.
   * Seeing them side by side is the clearest possible statement of what this
   * instrument actually is.
   */
  drawRhythm() {
    const canvas = this.rhythmCanvas;
    if (!canvas) return;
    const { ctx, w, h } = fitCanvas(canvas);
    const engine = this.engine;
    const p = engine.params;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,10,20,0.85)';
    ctx.fillRect(0, 0, w, h);

    if (!p.rhythm.enabled) {
      ctx.fillStyle = 'rgba(148,163,184,0.4)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('rhythm off', 8, h / 2 + 4);
      return;
    }

    const L = Math.max(2, Math.round(p.rhythm.layers));
    const now = engine.ctx.currentTime;
    const doubling = engine.rhythm.cfg.doubling;
    const elapsed = now - engine.rhythm.startTime;

    // Window outline across the tempo span.
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const e = (i / 200) * L;
      const g = windowAt(e, L, p.rhythm.shape, L / 6);
      const x = (e / L) * w;
      const y = h - g * h * 0.8 - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.4)';
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Each layer as a marker at its current tempo position.
    for (let k = 0; k < L; k++) {
      const e = engine.running ? wrap(k + elapsed / doubling, L) : wrap(k, L);
      const g = windowAt(e, L, p.rhythm.shape, L / 6);
      const x = (e / L) * w;
      const y = h - g * h * 0.8 - 4;
      const tempo = p.rhythm.baseTempo * Math.pow(2, e);

      ctx.beginPath();
      ctx.arc(x, y, 3 + g * 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(251,146,60,${0.25 + g * 0.7})`;
      ctx.fill();

      if (g > 0.35) {
        ctx.fillStyle = 'rgba(226,232,240,0.55)';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`${(tempo * 60).toFixed(0)} bpm`, x + 7, y - 4);
      }
    }

    // Beat flashes, decaying over 350 ms.
    const nowMs = performance.now();
    this.beats = this.beats.filter((b) => nowMs - b.born < 400);
    for (const b of this.beats) {
      const age = (nowMs - b.born) / 400;
      const x = (b.position / L) * w;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - h * 0.9 * b.gain * (1 - age));
      ctx.strokeStyle = `rgba(251,191,36,${(1 - age) * 0.8 * b.gain})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(148,163,184,0.45)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('slower', 6, 12);
    const fastLabel = 'faster';
    ctx.fillText(fastLabel, w - ctx.measureText(fastLabel).width - 6, 12);
  }
}

/** Draw a static waveform preview of a loaded sample, with loop markers. */
export function drawWaveform(canvas, envelope, loop, length) {
  if (!canvas) return;
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(8,10,20,0.85)';
  ctx.fillRect(0, 0, w, h);

  if (!envelope) {
    ctx.fillStyle = 'rgba(148,163,184,0.4)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('drop an audio file here', 10, h / 2 + 4);
    return;
  }

  const buckets = envelope.length / 2;
  const mid = h / 2;
  ctx.beginPath();
  for (let b = 0; b < buckets; b++) {
    const x = (b / buckets) * w;
    const min = envelope[b * 2];
    const max = envelope[b * 2 + 1];
    ctx.moveTo(x, mid - max * mid * 0.92);
    ctx.lineTo(x, mid - min * mid * 0.92);
  }
  ctx.strokeStyle = 'rgba(125,211,252,0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (loop && length) {
    const x0 = (loop.start / length) * w;
    const x1 = (loop.end / length) * w;
    ctx.fillStyle = 'rgba(232,121,249,0.14)';
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = 'rgba(232,121,249,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, 0); ctx.lineTo(x0, h);
    ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,121,249,0.85)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('loop', x0 + 4, 12);
  }
}
