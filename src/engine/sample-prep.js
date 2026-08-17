/**
 * sample-prep.js
 *
 * Turns a decoded AudioBuffer into the mip-mapped, mono-summed form the
 * sampler worklet needs.
 *
 * ---------------------------------------------------------------------------
 * WHY MIPS FOR A SAMPLE
 * ---------------------------------------------------------------------------
 * The Shepard stack reads its source at octave-spaced rates. Reading a buffer
 * at 8x speed shifts everything up three octaves -- including whatever sat
 * just under Nyquist, which folds back down as aliasing. On a sweeping stack
 * that folded content moves *downward* while the real content moves upward,
 * which is precisely the artefact that destroys the illusion.
 *
 * So we precompute one band-limited copy of the source per octave of upward
 * transposition: mip m is lowpassed to Nyquist / 2^m. A partial reading at
 * rate 2^m then reads a copy whose content cannot alias at that rate.
 *
 * Copies are kept at full length and full sample rate rather than decimated,
 * so every mip shares one index space -- a partial crossfading between mips
 * reads the same position in both, and no resampling bookkeeping is needed on
 * the audio thread.
 *
 * Filtering is zero-phase (forward then backward), so mips stay time-aligned
 * with each other. A causal filter would smear each mip by its own group
 * delay, and crossfading between two differently-delayed copies produces
 * comb filtering that sweeps as the stack moves.
 */

/** Hard ceiling on source length, in seconds. Guards against a 20-minute file
 *  being expanded into eight full-rate copies and exhausting memory. */
export const MAX_SAMPLE_SECONDS = 40;

/**
 * One biquad lowpass section, applied in place.
 * Direct Form I, cascaded twice for a steeper (24 dB/oct) skirt -- one pole
 * pair is not enough to keep an octave-up read clean.
 */
function biquadLowpassInPlace(data, cutoff, sampleRate, q = 0.7071) {
  const w0 = (2 * Math.PI * Math.min(cutoff, sampleRate * 0.49)) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  const b0 = (1 - cosw) / 2;
  const b1 = 1 - cosw;
  const b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    data[i] = y0;
  }
}

function biquadLowpassReverseInPlace(data, cutoff, sampleRate, q = 0.7071) {
  const w0 = (2 * Math.PI * Math.min(cutoff, sampleRate * 0.49)) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  const b0 = (1 - cosw) / 2;
  const b1 = 1 - cosw;
  const b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const x0 = data[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    data[i] = y0;
  }
}

/** Mono-sum an AudioBuffer, with equal-power compensation for the sum. */
export function monoSum(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  if (ch === 1) {
    out.set(audioBuffer.getChannelData(0));
    return out;
  }
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  const norm = 1 / Math.sqrt(ch);
  for (let i = 0; i < len; i++) out[i] *= norm;
  return out;
}

/** Peak-normalise to a target, leaving headroom for the stack sum. */
export function normalize(data, targetPeak = 0.9) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-9) return 0;
  const g = targetPeak / peak;
  for (let i = 0; i < data.length; i++) data[i] *= g;
  return peak;
}

/**
 * Remove DC offset. A sound bite with DC becomes a thump every time a grain
 * window opens and closes, and with dozens of grains per second across the
 * stack that reads as a nasty low-frequency rumble.
 */
export function removeDC(data) {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;
  if (Math.abs(mean) < 1e-7) return;
  for (let i = 0; i < data.length; i++) data[i] -= mean;
}

/**
 * Detect a sensible loop region. Sound bites usually have a transient attack
 * and a decaying tail; looping the whole file re-triggers that attack on every
 * pass, which fights the seamlessness of the illusion. We look for the
 * sustained middle: the longest run above a fraction of peak RMS.
 *
 * Returns sample indices. Callers may override.
 */
export function detectLoop(data, sampleRate) {
  const win = Math.max(1, Math.floor(sampleRate * 0.02));
  const frames = Math.floor(data.length / win);
  if (frames < 4) return { start: 0, end: data.length };

  const rms = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * win;
    for (let i = 0; i < win; i++) sum += data[off + i] * data[off + i];
    rms[f] = Math.sqrt(sum / win);
    if (rms[f] > peak) peak = rms[f];
  }
  if (peak < 1e-6) return { start: 0, end: data.length };

  const thresh = peak * 0.25;
  let bestStart = 0;
  let bestLen = 0;
  let curStart = -1;
  for (let f = 0; f < frames; f++) {
    if (rms[f] >= thresh) {
      if (curStart < 0) curStart = f;
    } else if (curStart >= 0) {
      if (f - curStart > bestLen) { bestLen = f - curStart; bestStart = curStart; }
      curStart = -1;
    }
  }
  if (curStart >= 0 && frames - curStart > bestLen) {
    bestLen = frames - curStart;
    bestStart = curStart;
  }
  if (bestLen < 2) return { start: 0, end: data.length };

  return {
    start: bestStart * win,
    end: Math.min(data.length, (bestStart + bestLen) * win),
  };
}

/**
 * Build the full payload for the sampler worklet.
 *
 * @param {AudioBuffer} audioBuffer  decoded source
 * @param {object} [opts]
 * @param {number} [opts.mipCount]   number of octave bands to precompute
 * @param {boolean} [opts.autoLoop]  detect the sustained region
 * @returns {{mips: Float32Array[], length: number, sourceRate: number,
 *            loopStart: number, loopEnd: number, duration: number}}
 */
export function prepareSample(audioBuffer, opts = {}) {
  const { mipCount = 6, autoLoop = true } = opts;

  const maxLen = Math.floor(MAX_SAMPLE_SECONDS * audioBuffer.sampleRate);
  let mono = monoSum(audioBuffer);
  let truncated = false;
  if (mono.length > maxLen) {
    mono = mono.slice(0, maxLen);
    truncated = true;
  }

  removeDC(mono);
  normalize(mono, 0.9);

  const sr = audioBuffer.sampleRate;
  const nyquist = sr * 0.5;

  const mips = [mono];
  for (let m = 1; m < mipCount; m++) {
    const copy = Float32Array.from(mips[m - 1]);
    // Each mip is one octave darker than the last. Cutting from the previous
    // mip rather than from the original gives a steeper effective rolloff for
    // free, since the filters cascade.
    const cutoff = nyquist / Math.pow(2, m);
    biquadLowpassInPlace(copy, cutoff, sr);
    biquadLowpassReverseInPlace(copy, cutoff, sr);
    mips.push(copy);
  }

  const loop = autoLoop
    ? detectLoop(mono, sr)
    : { start: 0, end: mono.length };

  return {
    mips,
    length: mono.length,
    sourceRate: sr,
    loopStart: loop.start,
    loopEnd: loop.end,
    duration: mono.length / sr,
    truncated,
  };
}

/** Peak envelope for waveform drawing, reduced to `buckets` min/max pairs. */
export function peakEnvelope(data, buckets = 900) {
  const out = new Float32Array(buckets * 2);
  const step = data.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * step);
    const e = Math.min(data.length, Math.floor((b + 1) * step));
    let min = 0;
    let max = 0;
    for (let i = s; i < e; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}
