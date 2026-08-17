/**
 * shepard-osc-processor.js  --  AudioWorkletProcessor
 *
 * The synthesis core: an octave-spaced partial stack sliding through a fixed
 * spectral window, rendered sample-accurately on the audio thread.
 *
 * NOTE ON DUPLICATION
 * This file deliberately re-implements a handful of helpers from
 * ../engine/shepard-math.js rather than importing them. AudioWorklet module
 * imports are not reliably supported across browsers (Safari in particular),
 * and a silent addModule failure means no sound at all. The duplicated code is
 * ~40 lines of window maths; the shared copy in shepard-math.js is the one
 * under test, and test/parity.test.js asserts the two agree numerically so
 * they cannot drift apart unnoticed.
 *
 * ---------------------------------------------------------------------------
 * ANTI-ALIASING
 * ---------------------------------------------------------------------------
 * A Shepard stack puts partials all the way up the spectrum by design, and
 * sweeps them continuously. Naive saw/square oscillators would fold aliasing
 * back down as *descending* tones -- which is exactly the illusion's opposite,
 * and it is instantly audible as a gritty shimmer moving the wrong way.
 *
 * So every waveform is a mip-mapped band-limited wavetable: one table per
 * octave band, each containing only the harmonics that fit below Nyquist for
 * that band. Playback crossfades between adjacent mips by fractional octave,
 * so a partial gliding across a mip boundary hears no timbral step.
 */

const TABLE_LEN = 2048;
const TABLE_MASK = TABLE_LEN - 1;
const MIP_BASE_HZ = 20;      // fundamental frequency at the bottom of mip 0
const NUM_MIPS = 11;         // 20 Hz * 2^11 = ~41 kHz, covers any sane rate
const CONTROL_INTERVAL = 12; // blocks between phase reports to the main thread

/* -------------------------------------------------------------------------- */
/* Window maths (mirror of shepard-math.js -- see note above)                  */
/* -------------------------------------------------------------------------- */

const WINDOW_COEFFS = {
  hann: [0.5, 0.5],
  blackman: [0.42, 0.5, 0.08],
  blackmanHarris: [0.35875, 0.48829, 0.14128, 0.01168],
  flat: [1],
};

// These three are exported purely so test/parity.test.js can assert they still
// agree with the shared implementations in ../engine/shepard-math.js. Worklet
// modules are module scripts, so `export` is legal here and inert at runtime.
export function wrap(x, n) {
  const r = x % n;
  return r < 0 ? r + n : r;
}

export function windowAt(e, octaves, shape, sigma) {
  if (shape === 'gauss') {
    const d = (e - octaves / 2) / (sigma > 1e-6 ? sigma : 1e-6);
    return Math.exp(-0.5 * d * d);
  }
  const coeffs = WINDOW_COEFFS[shape] || WINDOW_COEFFS.hann;
  const x = (2 * Math.PI * e) / octaves;
  let sum = coeffs[0];
  for (let k = 1; k < coeffs.length; k++) {
    sum += (k % 2 === 1 ? -1 : 1) * coeffs[k] * Math.cos(k * x);
  }
  return sum < 0 ? 0 : sum;
}

export function tiltAt(e, octaves, tiltDb) {
  if (!tiltDb) return 1;
  return Math.pow(10, (tiltDb * (e - octaves / 2)) / 20);
}

/* -------------------------------------------------------------------------- */
/* Band-limited wavetable generation                                           */
/* -------------------------------------------------------------------------- */

/**
 * Harmonic amplitude/phase spectra. Each returns the linear amplitude of
 * harmonic k (1-indexed), or 0 if the harmonic is absent.
 */
const SPECTRA = {
  sine: (k) => (k === 1 ? 1 : 0),
  triangle: (k) => (k % 2 === 1 ? 1 / (k * k) : 0),
  saw: (k) => 1 / k,
  square: (k) => (k % 2 === 1 ? 1 / k : 0),
  // Drawbar-ish: octaves plus a twelfth. Reads as "warm organ pad" and is
  // the most forgiving voice for a dense stack -- its harmonics land on the
  // same octave grid the stack already occupies, so it thickens rather than
  // muddies.
  organ: (k) => (k === 1 ? 1 : k === 2 ? 0.5 : k === 3 ? 0.28 : k === 4 ? 0.22 : k === 8 ? 0.12 : 0),
  // Inharmonic-flavoured but still periodic: emphasises odd partials with a
  // slow rolloff for a glassy, bell-like edge.
  glass: (k) => (k % 2 === 1 ? Math.pow(k, -1.4) : 0.35 * Math.pow(k, -1.8)),
};

const WAVEFORM_NAMES = Object.keys(SPECTRA);

/**
 * Build the full mip chain for a waveform.
 *
 * Harmonic phases are randomised deterministically per harmonic rather than
 * all starting at zero. All-zero phase piles every harmonic's peak at t=0,
 * producing a large crest factor -- with 8 partials x 4 chord voices summed,
 * that clips the bus long before the RMS is anywhere near full scale.
 * Scattering the phases lowers peak level by several dB for identical
 * spectrum and identical perceived timbre (the ear is famously insensitive to
 * the absolute phase of steady harmonics).
 */
export function buildWavetables(name, sampleRate) {
  const spectrum = SPECTRA[name] || SPECTRA.sine;
  const nyquist = sampleRate * 0.5;
  const mips = [];

  for (let m = 0; m < NUM_MIPS; m++) {
    const topFreq = MIP_BASE_HZ * Math.pow(2, m + 1);
    let maxHarmonic = Math.floor(nyquist / topFreq);
    if (maxHarmonic < 1) maxHarmonic = 1;
    if (maxHarmonic > 1024) maxHarmonic = 1024;

    const table = new Float32Array(TABLE_LEN + 1); // +1 guard point for lerp
    for (let k = 1; k <= maxHarmonic; k++) {
      const amp = spectrum(k);
      if (amp === 0) continue;
      // Deterministic scattered phase: an irrational multiple of k keeps
      // successive harmonics decorrelated without a PRNG.
      const phase0 = 2 * Math.PI * ((k * 0.6180339887498949) % 1);
      const step = (2 * Math.PI * k) / TABLE_LEN;
      // Rotation recurrence instead of TABLE_LEN Math.sin calls per harmonic:
      // ~10x faster to build, and the drift over 2048 steps is far below the
      // 24-bit noise floor.
      const cosStep = Math.cos(step);
      const sinStep = Math.sin(step);
      let c = Math.cos(phase0);
      let s = Math.sin(phase0);
      for (let i = 0; i < TABLE_LEN; i++) {
        table[i] += amp * s;
        const nc = c * cosStep - s * sinStep;
        s = s * cosStep + c * sinStep;
        c = nc;
      }
    }

    // Normalise to unit peak so waveform changes do not jump the level.
    let peak = 0;
    for (let i = 0; i < TABLE_LEN; i++) {
      const a = Math.abs(table[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-9) {
      const inv = 1 / peak;
      for (let i = 0; i < TABLE_LEN; i++) table[i] *= inv;
    }
    table[TABLE_LEN] = table[0]; // wrap guard
    mips.push(table);
  }
  return mips;
}

/* -------------------------------------------------------------------------- */
/* Processor                                                                   */
/* -------------------------------------------------------------------------- */

class ShepardOscProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.tableCache = new Map();
    this.waveform = 'organ';
    this.tables = this.getTables(this.waveform);

    // --- state -------------------------------------------------------------
    this.phase = 0;          // stack position, octaves (unbounded, monotonic)
    this.smoothPhase = 0;    // glide-smoothed phase actually used for pitch
    this.oscPhases = null;   // per (voice, partial) wavetable read position
    this.blockCount = 0;
    this.running = false;
    this.fadeGain = 0;       // click-free start/stop envelope

    // --- parameters (all replaceable wholesale via a 'params' message) ------
    this.p = {
      rate: 1 / 12,
      swoop: 0,
      octaves: 8,
      baseFreq: 27.5,
      shape: 'hann',
      sigma: 8 / 6,
      tilt: -1.5,
      levelLock: true,
      stepDivisions: 0,
      glide: 0,
      spread: 0.6,
      gain: 0.25,
      voiceOffsets: new Float32Array([0]),
      voiceGains: new Float32Array([1]),
      scaleTable: null,
    };

    if (options && options.processorOptions && options.processorOptions.params) {
      this.applyParams(options.processorOptions.params);
    }
    this.allocVoices();

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'params') {
        this.applyParams(msg.params);
      } else if (msg.type === 'transport') {
        this.running = !!msg.running;
        if (msg.resetPhase) {
          this.phase = 0;
          this.smoothPhase = 0;
        }
      } else if (msg.type === 'setPhase') {
        this.phase = msg.phase;
        this.smoothPhase = msg.phase;
      }
    };
  }

  static get parameterDescriptors() {
    return [];
  }

  getTables(name) {
    if (!this.tableCache.has(name)) {
      this.tableCache.set(name, buildWavetables(name, sampleRate));
    }
    return this.tableCache.get(name);
  }

  applyParams(params) {
    const p = this.p;
    for (const key of Object.keys(params)) {
      if (key === 'waveform') {
        const w = WAVEFORM_NAMES.includes(params.waveform) ? params.waveform : 'sine';
        if (w !== this.waveform) {
          this.waveform = w;
          this.tables = this.getTables(w);
        }
      } else if (key === 'voiceOffsets' || key === 'voiceGains') {
        p[key] = Float32Array.from(params[key]);
      } else if (key === 'scaleTable') {
        p.scaleTable = params.scaleTable ? Float32Array.from(params.scaleTable) : null;
      } else {
        p[key] = params[key];
      }
    }
    p.octaves = Math.max(2, Math.round(p.octaves));
    this.allocVoices();
  }

  /**
   * (Re)allocate oscillator phase accumulators. Existing phases are preserved
   * where the geometry is unchanged, so tweaking an unrelated parameter mid-
   * flight does not restart every oscillator and produce a broadband click.
   */
  allocVoices() {
    const need = this.p.voiceOffsets.length * this.p.octaves;
    if (!this.oscPhases || this.oscPhases.length !== need) {
      const next = new Float32Array(need);
      if (this.oscPhases) {
        next.set(this.oscPhases.subarray(0, Math.min(need, this.oscPhases.length)));
      } else {
        // Scatter initial phases for the same crest-factor reason as the
        // wavetable harmonics.
        for (let i = 0; i < need; i++) next[i] = (i * 0.6180339887498949) % 1;
      }
      this.oscPhases = next;
    }
  }

  /** Read the mip chain with fractional-octave crossfade. */
  sampleTable(pos, mipF) {
    const tables = this.tables;
    let m0 = Math.floor(mipF);
    if (m0 < 0) m0 = 0;
    if (m0 > NUM_MIPS - 1) m0 = NUM_MIPS - 1;
    let m1 = m0 + 1;
    if (m1 > NUM_MIPS - 1) m1 = NUM_MIPS - 1;
    const frac = mipF - m0 < 0 ? 0 : mipF - m0 > 1 ? 1 : mipF - m0;

    const x = pos * TABLE_LEN;
    const i0 = x | 0;
    const xf = x - i0;
    const idx = i0 & TABLE_MASK;

    const t0 = tables[m0];
    const t1 = tables[m1];
    const a = t0[idx] + (t0[idx + 1] - t0[idx]) * xf;
    const b = t1[idx] + (t1[idx + 1] - t1[idx]) * xf;
    return a + (b - a) * frac;
  }

  /**
   * Advance the stack phase by `n` samples' worth of time, honouring the
   * swoop rate-shaping. Integrated in small steps because the rate depends on
   * the phase itself; a block is short enough that midpoint integration is
   * exact to well past audio precision.
   */
  advancePhase(n) {
    const { rate, swoop } = this.p;
    if (!this.running || rate === 0) return;
    const dt = n / sampleRate;
    if (!swoop) {
      this.phase += rate * dt;
      return;
    }
    const a = swoop > 0.95 ? 0.95 : swoop < -0.95 ? -0.95 : swoop;
    // Midpoint method: evaluate the shaping at the half-step estimate.
    const k1 = 1 + a * Math.cos(2 * Math.PI * this.phase);
    const mid = this.phase + rate * k1 * dt * 0.5;
    const k2 = 1 + a * Math.cos(2 * Math.PI * mid);
    this.phase += rate * k2 * dt;
  }

  /** Quantise to a scale/step grid, if enabled. */
  targetPhase() {
    const { stepDivisions, scaleTable } = this.p;
    const ph = this.phase;
    if (scaleTable && scaleTable.length) {
      const oct = Math.floor(ph);
      const frac = ph - oct;
      const idx = Math.min(scaleTable.length - 1, Math.max(0, (frac * scaleTable.length) | 0));
      return oct + scaleTable[idx];
    }
    if (stepDivisions && stepDivisions >= 2) {
      return Math.floor(ph * stepDivisions) / stepDivisions;
    }
    return ph;
  }

  /**
   * Compute per-partial phase increments and gains for the current smoothed
   * phase. Called twice per block (start and end) and linearly interpolated
   * between, which keeps the expensive pow() calls at control rate while the
   * audible motion stays continuous.
   */
  computeStack(phaseNow, incOut, gainOut, panLOut, panROut) {
    const p = this.p;
    const n = p.octaves;
    const voices = p.voiceOffsets.length;
    const nyquist = sampleRate * 0.5;
    const invSr = 1 / sampleRate;

    let idx = 0;
    for (let v = 0; v < voices; v++) {
      const voffs = p.voiceOffsets[v];
      const vgain = p.voiceGains[v];

      // Per-voice RMS normalisation of the window, when level lock is on.
      let norm = 1;
      if (p.levelLock) {
        let sumSq = 0;
        for (let i = 0; i < n; i++) {
          const e = wrap(i + phaseNow + voffs, n);
          const g = windowAt(e, n, p.shape, p.sigma) * tiltAt(e, n, p.tilt);
          sumSq += g * g;
        }
        norm = sumSq > 1e-12 ? 1 / Math.sqrt(sumSq) : 0;
      }

      for (let i = 0; i < n; i++, idx++) {
        const e = wrap(i + phaseNow + voffs, n);
        const freq = p.baseFreq * Math.pow(2, e);
        let g = windowAt(e, n, p.shape, p.sigma) * tiltAt(e, n, p.tilt) * norm * vgain;

        // Hard-mute anything at or above Nyquist. With a sane base frequency
        // and span this never engages, but a user dragging baseFreq up with a
        // 10-octave span can push the top partial off the end of the world.
        if (freq >= nyquist * 0.98) g = 0;

        incOut[idx] = freq * invSr;
        gainOut[idx] = g;

        // Equal-power pan, keyed to the partial's identity rather than its
        // position. Identities cycle as partials wrap, so the stereo image
        // slowly rotates -- motion the ear reads as depth.
        const spread = p.spread;
        const t = voices > 1 ? (i / n + v / voices) % 1 : i / n;
        const panPos = spread * (2 * t - 1);
        const ang = ((panPos + 1) * Math.PI) / 4;
        panLOut[idx] = Math.cos(ang);
        panROut[idx] = Math.sin(ang);
      }
    }
    return idx;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const blockSize = outL.length;

    const p = this.p;
    const count = p.voiceOffsets.length * p.octaves;
    this.allocVoices();

    // Scratch buffers, reallocated only when the stack geometry changes.
    if (!this._incA || this._incA.length !== count) {
      this._incA = new Float32Array(count);
      this._incB = new Float32Array(count);
      this._gainA = new Float32Array(count);
      this._gainB = new Float32Array(count);
      this._panL = new Float32Array(count);
      this._panR = new Float32Array(count);
    }

    // --- control rate: stack state at block start and block end -------------
    const glideCoeff =
      p.glide > 0 ? 1 - Math.exp(-blockSize / (p.glide * sampleRate)) : 1;

    const targetA = this.targetPhase();
    this.smoothPhase += (targetA - this.smoothPhase) * glideCoeff;
    const phaseA = this.smoothPhase;
    this.computeStack(phaseA, this._incA, this._gainA, this._panL, this._panR);

    this.advancePhase(blockSize);
    const targetB = this.targetPhase();
    const phaseB = this.smoothPhase + (targetB - this.smoothPhase) * glideCoeff;
    this.computeStack(phaseB, this._incB, this._gainB, this._panL, this._panR);

    // Guard against interpolating across an octave wrap. When a partial wraps
    // from the top of the span to the bottom its frequency divides by 2^N;
    // linearly ramping the increment through that would sweep audibly. Gain is
    // ~0 at the wrap point for tapered windows, but 'flat' and 'gauss' leave
    // enough level for it to click, so snap instead of ramp.
    for (let i = 0; i < count; i++) {
      const a = this._incA[i];
      const b = this._incB[i];
      if (a > 1e-9 && (b > a * 1.5 || b < a * 0.67)) this._incA[i] = b;
    }

    const incA = this._incA;
    const incB = this._incB;
    const gainA = this._gainA;
    const gainB = this._gainB;
    const panL = this._panL;
    const panR = this._panR;
    const phases = this.oscPhases;
    const masterGain = p.gain;

    // Click-free start/stop: a short fade applied to the whole bus.
    const fadeTarget = this.running ? 1 : 0;
    const fadeCoeff = 1 - Math.exp(-blockSize / (0.02 * sampleRate));

    const invBlock = 1 / blockSize;

    for (let s = 0; s < blockSize; s++) {
      const t = s * invBlock;
      let l = 0;
      let r = 0;

      for (let i = 0; i < count; i++) {
        const g = gainA[i] + (gainB[i] - gainA[i]) * t;
        const inc = incA[i] + (incB[i] - incA[i]) * t;

        let ph = phases[i] + inc;
        ph -= Math.floor(ph);
        phases[i] = ph;

        if (g > 1e-6) {
          // Mip selection by fundamental frequency: which octave band above
          // MIP_BASE_HZ does this partial sit in.
          const mipF = Math.log2((inc * sampleRate) / MIP_BASE_HZ);
          const sample = this.sampleTable(ph, mipF) * g;
          l += sample * panL[i];
          r += sample * panR[i];
        }
      }

      this.fadeGain += (fadeTarget - this.fadeGain) * fadeCoeff;
      const gm = masterGain * this.fadeGain;
      outL[s] = l * gm;
      outR[s] = r * gm;
    }

    // --- report phase to the main thread for the visualiser ----------------
    // Only the scalar phase crosses the boundary; the UI recomputes gains with
    // the shared maths module, so there is no per-frame array allocation here.
    if (++this.blockCount >= CONTROL_INTERVAL) {
      this.blockCount = 0;
      this.port.postMessage({ type: 'phase', phase: this.phase, smooth: this.smoothPhase });
    }

    return true;
  }
}

registerProcessor('shepard-osc', ShepardOscProcessor);
