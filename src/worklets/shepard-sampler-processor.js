/**
 * shepard-sampler-processor.js  --  AudioWorkletProcessor
 *
 * Turns an arbitrary sound bite into a Shepard tone: the same octave-spaced,
 * window-weighted stack as the oscillator, but every partial is a transposed
 * copy of the source instead of a sine.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO TRANSPOSE, AND WHY BOTH EXIST
 * ---------------------------------------------------------------------------
 *
 * 'rate'  -- straight resampling. Pitch and speed move together, exactly like
 *            varispeed tape. The lowest layer crawls, the highest gabbers.
 *            For a sustained or textural source (a pad, a held vowel, room
 *            tone, a cymbal wash) this is the richer, more organic result and
 *            it is what most Risset-style sample pieces actually use.
 *
 * 'grain' -- granular pitch shift: overlapping grains are read at the
 *            transposed rate while the grain *stream* advances at 1x. Pitch
 *            moves, speed does not. This is the mode that matters for
 *            rhythmic material -- a drum loop, a spoken phrase, a riff -- because
 *            every layer of the stack stays locked to the same groove while
 *            spanning eight octaves. The loop keeps its time; only its pitch
 *            spirals. That is the version of this effect that sounds like
 *            music rather than like a tape machine falling apart.
 *
 * Grain windows are Hann at 50% overlap, which sums to exactly unity, so the
 * grain stream introduces no amplitude ripple of its own.
 *
 * See the duplication note in shepard-osc-processor.js -- same reasoning here.
 */

const CONTROL_INTERVAL = 12;

const WINDOW_COEFFS = {
  hann: [0.5, 0.5],
  blackman: [0.42, 0.5, 0.08],
  blackmanHarris: [0.35875, 0.48829, 0.14128, 0.01168],
  flat: [1],
};

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

class ShepardSamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.mips = null;       // Float32Array[] -- band-limited copies of source
    this.srcLength = 0;
    this.sourceRate = sampleRate;
    this.loopStart = 0;
    this.loopEnd = 0;

    this.phase = 0;
    this.running = false;
    this.fadeGain = 0;
    this.blockCount = 0;

    this.masterPos = 0;     // grain-mode playhead, advances at 1x
    this.readPos = null;    // rate-mode per-partial positions
    this.grainPhase = null; // grain-mode per-partial-per-slot phase [0,1)
    this.grainStart = null; // grain-mode per-partial-per-slot source origin

    this.p = {
      rate: 1 / 12,
      swoop: 0,
      octaves: 8,
      shape: 'hann',
      sigma: 8 / 6,
      tilt: 0,
      levelLock: true,
      stepDivisions: 0,
      scaleTable: null,
      glide: 0,
      spread: 0.6,
      gain: 0.5,
      mode: 'grain',
      grainMs: 80,
      pitchShift: 0,      // semitones applied to the whole stack
      voiceOffsets: new Float32Array([0]),
      voiceGains: new Float32Array([1]),
    };
    this.smoothPhase = 0;

    if (options && options.processorOptions && options.processorOptions.params) {
      this.applyParams(options.processorOptions.params);
    }

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'sample') {
        this.mips = msg.mips.map((m) => new Float32Array(m));
        this.srcLength = msg.length;
        this.sourceRate = msg.sourceRate;
        this.loopStart = msg.loopStart;
        this.loopEnd = msg.loopEnd;
        this.resetHeads();
        this.port.postMessage({ type: 'sampleReady', length: this.srcLength });
      } else if (msg.type === 'params') {
        this.applyParams(msg.params);
      } else if (msg.type === 'loop') {
        this.loopStart = msg.loopStart;
        this.loopEnd = msg.loopEnd;
        this.resetHeads();
      } else if (msg.type === 'transport') {
        this.running = !!msg.running;
        if (msg.resetPhase) {
          this.phase = 0;
          this.smoothPhase = 0;
          this.resetHeads();
        }
      } else if (msg.type === 'setPhase') {
        this.phase = msg.phase;
        this.smoothPhase = msg.phase;
      }
    };
  }

  applyParams(params) {
    const p = this.p;
    for (const key of Object.keys(params)) {
      if (key === 'voiceOffsets' || key === 'voiceGains') {
        p[key] = Float32Array.from(params[key]);
      } else if (key === 'scaleTable') {
        p.scaleTable = params.scaleTable ? Float32Array.from(params.scaleTable) : null;
      } else {
        p[key] = params[key];
      }
    }
    p.octaves = Math.max(2, Math.round(p.octaves));
    this.alloc();
  }

  alloc() {
    const count = this.p.voiceOffsets.length * this.p.octaves;
    if (!this.readPos || this.readPos.length !== count) {
      this.readPos = new Float64Array(count);
      this.grainPhase = new Float64Array(count * 2);
      this.grainStart = new Float64Array(count * 2);
      this.resetHeads();
    }
  }

  resetHeads() {
    if (!this.readPos) return;
    const loopLen = Math.max(1, this.loopEnd - this.loopStart);
    for (let i = 0; i < this.readPos.length; i++) {
      // Scatter start positions around the loop. If every partial started at
      // the same sample the stack would be a pile of perfectly correlated
      // copies -- comb filtering, and a mono-sounding, phasey result. Spread
      // out, the layers decorrelate into a wide, evolving texture.
      const frac = (i * 0.6180339887498949) % 1;
      this.readPos[i] = this.loopStart + frac * loopLen;
      this.grainPhase[i * 2] = frac;
      this.grainPhase[i * 2 + 1] = (frac + 0.5) % 1;
      this.grainStart[i * 2] = this.readPos[i];
      this.grainStart[i * 2 + 1] = this.readPos[i];
    }
    this.masterPos = this.loopStart;
  }

  /** Linear interpolation into a mip, wrapped to the loop region. */
  readMip(mip, pos) {
    const len = this.srcLength;
    let x = pos;
    if (x < 0 || x >= len) x = wrap(x, len);
    const i0 = x | 0;
    const frac = x - i0;
    const i1 = i0 + 1 >= len ? 0 : i0 + 1;
    return mip[i0] + (mip[i1] - mip[i0]) * frac;
  }

  /** Read with fractional-octave crossfade between adjacent mips. */
  readBandLimited(pos, rate) {
    const mips = this.mips;
    const nm = mips.length;
    let mipF = rate > 1 ? Math.log2(rate) : 0;
    if (mipF > nm - 1) mipF = nm - 1;
    const m0 = mipF | 0;
    const m1 = m0 + 1 > nm - 1 ? nm - 1 : m0 + 1;
    const f = mipF - m0;
    const a = this.readMip(mips[m0], pos);
    if (f <= 0 || m0 === m1) return a;
    const b = this.readMip(mips[m1], pos);
    return a + (b - a) * f;
  }

  advancePhase(n) {
    const { rate, swoop } = this.p;
    if (!this.running || rate === 0) return;
    const dt = n / sampleRate;
    if (!swoop) {
      this.phase += rate * dt;
      return;
    }
    const a = swoop > 0.95 ? 0.95 : swoop < -0.95 ? -0.95 : swoop;
    const k1 = 1 + a * Math.cos(2 * Math.PI * this.phase);
    const mid = this.phase + rate * k1 * dt * 0.5;
    const k2 = 1 + a * Math.cos(2 * Math.PI * mid);
    this.phase += rate * k2 * dt;
  }

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
   * Per-partial playback rates and gains.
   *
   * Rates are centred on the span: position e maps to 2^(e - octaves/2), so
   * the loudest partials (the middle of the window) play near original pitch
   * and the source stays recognisable. Mapping 2^e instead would put the
   * window centre four octaves up, which turns every sample into a chipmunk.
   */
  computeStack(phaseNow, rateOut, gainOut, panLOut, panROut) {
    const p = this.p;
    const n = p.octaves;
    const voices = p.voiceOffsets.length;
    const half = n / 2;
    const baseRatio = (this.sourceRate / sampleRate) * Math.pow(2, p.pitchShift / 12);

    let idx = 0;
    for (let v = 0; v < voices; v++) {
      const voffs = p.voiceOffsets[v];
      const vgain = p.voiceGains[v];

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
        rateOut[idx] = Math.pow(2, e - half) * baseRatio;
        gainOut[idx] = windowAt(e, n, p.shape, p.sigma) * tiltAt(e, n, p.tilt) * norm * vgain;

        const t = voices > 1 ? (i / n + v / voices) % 1 : i / n;
        const panPos = p.spread * (2 * t - 1);
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

    if (!this.mips || this.srcLength < 2) {
      // Nothing loaded: keep the node alive but silent.
      this.advancePhase(blockSize);
      return true;
    }

    const p = this.p;
    this.alloc();
    const count = p.voiceOffsets.length * p.octaves;

    if (!this._rateA || this._rateA.length !== count) {
      this._rateA = new Float32Array(count);
      this._rateB = new Float32Array(count);
      this._gainA = new Float32Array(count);
      this._gainB = new Float32Array(count);
      this._panL = new Float32Array(count);
      this._panR = new Float32Array(count);
    }

    const glideCoeff =
      p.glide > 0 ? 1 - Math.exp(-blockSize / (p.glide * sampleRate)) : 1;

    const targetA = this.targetPhase();
    this.smoothPhase += (targetA - this.smoothPhase) * glideCoeff;
    this.computeStack(this.smoothPhase, this._rateA, this._gainA, this._panL, this._panR);

    this.advancePhase(blockSize);
    const targetB = this.targetPhase();
    const phaseB = this.smoothPhase + (targetB - this.smoothPhase) * glideCoeff;
    this.computeStack(phaseB, this._rateB, this._gainB, this._panL, this._panR);

    // Snap rather than ramp across an octave wrap (see the osc processor).
    for (let i = 0; i < count; i++) {
      const a = this._rateA[i];
      const b = this._rateB[i];
      if (a > 1e-9 && (b > a * 1.5 || b < a * 0.67)) this._rateA[i] = b;
    }

    const loopStart = this.loopStart;
    const loopEnd = this.loopEnd > loopStart + 16 ? this.loopEnd : this.srcLength;
    const loopLen = loopEnd - loopStart;

    const grainLen = Math.max(64, (p.grainMs * 0.001 * sampleRate) | 0);
    const grainInc = 1 / grainLen;
    const isGrain = p.mode === 'grain';

    const fadeTarget = this.running ? 1 : 0;
    const fadeCoeff = 1 - Math.exp(-blockSize / (0.02 * sampleRate));
    const invBlock = 1 / blockSize;
    const masterGain = p.gain;

    for (let s = 0; s < blockSize; s++) {
      const t = s * invBlock;
      let l = 0;
      let r = 0;

      if (isGrain) {
        this.masterPos += 1;
        if (this.masterPos >= loopEnd) this.masterPos = loopStart + (this.masterPos - loopEnd);
      }

      for (let i = 0; i < count; i++) {
        const g = this._gainA[i] + (this._gainB[i] - this._gainA[i]) * t;
        const rate = this._rateA[i] + (this._rateB[i] - this._rateA[i]) * t;

        if (isGrain) {
          let acc = 0;
          for (let slot = 0; slot < 2; slot++) {
            const gi = i * 2 + slot;
            let gp = this.grainPhase[gi] + grainInc;
            if (gp >= 1) {
              gp -= 1;
              // Re-anchor the grain to the current master playhead. This is
              // what decouples pitch from speed: the grain stream always
              // tracks real time, only the read rate inside a grain is
              // transposed.
              this.grainStart[gi] = this.masterPos;
            }
            this.grainPhase[gi] = gp;

            if (g > 1e-6) {
              let pos = this.grainStart[gi] + gp * grainLen * rate;
              if (pos >= loopEnd || pos < loopStart) {
                pos = loopStart + wrap(pos - loopStart, loopLen);
              }
              // Hann grain window; two slots at 50% overlap sum to unity.
              const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * gp);
              acc += this.readBandLimited(pos, rate) * w;
            }
          }
          if (g > 1e-6) {
            const sample = acc * g;
            l += sample * this._panL[i];
            r += sample * this._panR[i];
          }
        } else {
          let pos = this.readPos[i] + rate;
          if (pos >= loopEnd || pos < loopStart) {
            pos = loopStart + wrap(pos - loopStart, loopLen);
          }
          this.readPos[i] = pos;

          if (g > 1e-6) {
            const sample = this.readBandLimited(pos, rate) * g;
            l += sample * this._panL[i];
            r += sample * this._panR[i];
          }
        }
      }

      this.fadeGain += (fadeTarget - this.fadeGain) * fadeCoeff;
      const gm = masterGain * this.fadeGain;
      outL[s] = l * gm;
      outR[s] = r * gm;
    }

    if (++this.blockCount >= CONTROL_INTERVAL) {
      this.blockCount = 0;
      this.port.postMessage({ type: 'phase', phase: this.phase });
    }

    return true;
  }
}

registerProcessor('shepard-sampler', ShepardSamplerProcessor);
