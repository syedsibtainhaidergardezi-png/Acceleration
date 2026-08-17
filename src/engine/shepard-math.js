/**
 * shepard-math.js
 *
 * Pure, dependency-free math for the Shepard/Risset illusions.
 * Everything here is side-effect free and unit-testable in plain Node.
 *
 * ---------------------------------------------------------------------------
 * THE CORE IDEA
 * ---------------------------------------------------------------------------
 * A Shepard tone is a stack of sine partials spaced exactly one octave apart,
 * whose amplitudes are read off a *fixed* window in log-frequency space. The
 * partials slide upward through that window; each one fades in at the bottom,
 * swells through the middle, and fades out at the top. Because the window
 * never moves, the spectrum after one octave of travel is bit-identical to
 * where it started -- so the rise has no beginning and no end.
 *
 * We track a single scalar `phase`, measured in octaves. Partial i sits at
 *
 *     e_i = wrap(i + phase, octaves)          (position in octaves, [0, N))
 *     f_i = baseFreq * 2^(e_i)                (Hz)
 *     a_i = window(e_i)                       (linear amplitude)
 *
 * ---------------------------------------------------------------------------
 * WHY COSINE-SUM WINDOWS (and why 'hann' is the default)
 * ---------------------------------------------------------------------------
 * Any cosine-sum window of the form
 *
 *     w(x) = a0 - a1*cos(2*pi*x/N) + a2*cos(4*pi*x/N) - ...
 *
 * has an exact and rather lovely property when sampled at unit spacing: for
 * every integer k >= 1, the partial sums of cos(2*pi*k*(i + phase)/N) over
 * i = 0..N-1 vanish identically. So
 *
 *     sum_i w(wrap(i + phase, N)) == a0 * N     for ALL phase.
 *
 * The total amplitude of the stack is therefore *mathematically* constant as
 * it slides -- no loudness pumping, ever -- and Hann additionally reaches
 * exactly zero at both window edges, so a partial wrapping from the top of
 * the span back to the bottom does so in perfect silence. No click, no seam.
 *
 * A Gaussian window (the textbook choice) does neither: it only approximates
 * constant sum, and it is nonzero at the edges, so the wrap is audible at
 * roughly -27 dB for typical widths. It is offered here because it has a
 * softer, rounder timbre that some material wants -- but 'hann' is the one
 * that makes the illusion seamless.
 */

export const OCTAVE = 2;
export const SEMITONE = 1 / 12;

/** Positive modulo: result always in [0, n). */
export function wrap(x, n) {
  const r = x % n;
  return r < 0 ? r + n : r;
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function gainToDb(g) {
  return 20 * Math.log10(Math.max(g, 1e-12));
}

/* -------------------------------------------------------------------------- */
/* Spectral windows                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Cosine-sum window coefficients, indexed by name. Each satisfies the
 * constant-overlap-add property at unit hop (see header note), so the summed
 * amplitude of the sliding stack is exactly a0 * N regardless of phase.
 *
 * `flat` is the degenerate case: a rectangular window. It does NOT taper, so
 * partials pop in and out at the span edges. Useful for analysis, awful for
 * listening -- included so the difference is audible on demand.
 */
export const WINDOW_COEFFS = {
  hann: [0.5, 0.5],
  blackman: [0.42, 0.5, 0.08],
  blackmanHarris: [0.35875, 0.48829, 0.14128, 0.01168],
  flat: [1],
};

export const WINDOW_NAMES = [...Object.keys(WINDOW_COEFFS), 'gauss'];

/**
 * Evaluate the spectral window at position `e` octaves within a span of
 * `octaves` octaves.
 *
 * @param {number} e        position in octaves, expected in [0, octaves)
 * @param {number} octaves  total span N
 * @param {string} shape    key of WINDOW_COEFFS, or 'gauss'
 * @param {number} sigma    Gaussian width in octaves (ignored unless 'gauss')
 * @returns {number} linear amplitude in [0, 1]
 */
export function windowAt(e, octaves, shape = 'hann', sigma = octaves / 6) {
  if (shape === 'gauss') {
    const d = (e - octaves / 2) / Math.max(sigma, 1e-6);
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

/**
 * Spectral tilt: attenuates or boosts partials by `tiltDbPerOctave` dB for
 * each octave away from the centre of the span. Negative values darken the
 * stack (high partials quieter), which is usually what makes a dense stack
 * sit in a mix instead of screaming.
 *
 * Note this deliberately breaks the exact constant-sum property above -- it is
 * a timbral choice, traded against perfect level constancy. `levelLock` in
 * stackGains() restores constant output level afterwards if you want both.
 */
export function tiltAt(e, octaves, tiltDbPerOctave) {
  if (!tiltDbPerOctave) return 1;
  return dbToGain(tiltDbPerOctave * (e - octaves / 2));
}

/* -------------------------------------------------------------------------- */
/* The sliding stack                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Compute positions, frequencies and gains for every partial in the stack at a
 * given phase.
 *
 * @param {object} opts
 * @param {number} opts.phase       current position in octaves (unbounded)
 * @param {number} opts.octaves     span N, integer >= 2
 * @param {number} opts.baseFreq    frequency of the bottom of the span, Hz
 * @param {string} [opts.shape]     window shape
 * @param {number} [opts.sigma]     Gaussian width, octaves
 * @param {number} [opts.tilt]      dB per octave
 * @param {number} [opts.offset]    phase offset in octaves (chord voicing)
 * @param {boolean} [opts.levelLock] normalise so RMS is phase-independent
 * @returns {{positions: Float64Array, freqs: Float64Array, gains: Float64Array}}
 */
export function stackGains({
  phase,
  octaves,
  baseFreq,
  shape = 'hann',
  sigma = octaves / 6,
  tilt = 0,
  offset = 0,
  levelLock = false,
}) {
  const n = Math.max(2, Math.round(octaves));
  const positions = new Float64Array(n);
  const freqs = new Float64Array(n);
  const gains = new Float64Array(n);

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const e = wrap(i + phase + offset, n);
    const g = windowAt(e, n, shape, sigma) * tiltAt(e, n, tilt);
    positions[i] = e;
    freqs[i] = baseFreq * Math.pow(2, e);
    gains[i] = g;
    sumSq += g * g;
  }

  if (levelLock && sumSq > 1e-12) {
    // Normalise to unit RMS. Perceived loudness tracks RMS far better than it
    // tracks the amplitude sum, so this is the honest way to hold level steady
    // once tilt (or a Gaussian window) has broken exact constant-sum.
    const norm = 1 / Math.sqrt(sumSq);
    for (let i = 0; i < n; i++) gains[i] *= norm;
  }

  return { positions, freqs, gains };
}

/* -------------------------------------------------------------------------- */
/* Phase motion                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rate shaping -- the "swoop".
 *
 * A plain Shepard glissando rises at a constant rate in log-frequency, which
 * reads as *steady* rather than *accelerating*. To get the feel of an
 * acceleration that never tops out, we modulate the instantaneous rate with a
 * function that is periodic in phase with period 1 octave:
 *
 *     dPhase/dt = rate * m(frac(phase)),    m(x) = 1 + a*cos(2*pi*x)
 *
 * Because m has mean exactly 1 over a cycle, the average time per octave is
 * unchanged -- the illusion's period is preserved exactly. Because m is
 * periodic in phase (not in time), every octave is shaped identically, so the
 * seam stays invisible. And because all partials share one phase, they remain
 * perfectly octave-spaced throughout: the Shepard structure is untouched.
 *
 * @param {number} phase  current phase, octaves
 * @param {number} amount in (-1, 1); 0 disables. Positive = slow at the octave
 *                        boundary and fast through the middle.
 */
export function rateShape(phase, amount) {
  if (!amount) return 1;
  const a = clamp(amount, -0.95, 0.95);
  return 1 + a * Math.cos(2 * Math.PI * phase);
}

/**
 * Quantise phase to a stepped scale -- the Shepard *scale* illusion, as
 * opposed to the continuous glissando.
 *
 * @param {number} phase      octaves
 * @param {number} divisions  steps per octave; 0 or 1 leaves it continuous
 *                            (12 = chromatic, 7 = whole-ish, 3 = aug triad)
 */
export function quantizePhase(phase, divisions) {
  if (!divisions || divisions < 2) return phase;
  return Math.floor(phase * divisions) / divisions;
}

/**
 * One-pole smoothing coefficient for a given 60 dB glide time.
 * Returns the per-sample coefficient `c` for y += (x - y) * c.
 */
export function glideCoeff(seconds, sampleRate) {
  if (seconds <= 0) return 1;
  return 1 - Math.exp(-1 / (Math.max(seconds, 1e-5) * sampleRate));
}

/** Seconds-per-octave <-> octaves-per-second, sign preserved. */
export function ratePerSecond(secondsPerOctave, direction = 1) {
  const s = Math.max(Math.abs(secondsPerOctave), 1e-4);
  return (direction >= 0 ? 1 : -1) / s;
}

/* -------------------------------------------------------------------------- */
/* Risset rhythm: tempo that accelerates forever                               */
/* -------------------------------------------------------------------------- */

/**
 * The rhythmic twin of the Shepard tone. Several pulse layers run at
 * octave-spaced tempi; each layer accelerates continuously, and the same
 * sliding window controls its loudness. A layer fades in slow and deep, speeds
 * up through the audible middle, and fades out fast and thin at the top, while
 * a new slow layer materialises underneath. The result beats faster and faster
 * without ever arriving anywhere.
 *
 * With tempo doubling every D seconds, layer tempo is
 *
 *     T(t) = T0 * 2^(t/D)
 *
 * Beats land at integer values of the accumulated beat count, which is the
 * integral of tempo:
 *
 *     theta(t) = theta0 + (T0*D/ln2) * (2^(t/D) - 1)
 *
 * That inverts in closed form, so we can place every beat *exactly* rather
 * than stepping a counter and accumulating drift:
 *
 *     t(theta) = D * log2( 1 + (theta - theta0)*ln2 / (T0*D) )
 *
 * At high acceleration a naive incremental scheduler smears the grid audibly;
 * this does not.
 */

/**
 * Accumulated beat count at time `dt` seconds after a layer's reference point.
 *
 * @param {number} dt        seconds since reference
 * @param {number} tempo0    tempo at the reference point, beats/second
 * @param {number} doubling  seconds for tempo to double (negative = decelerate)
 */
export function beatPhaseAt(dt, tempo0, doubling) {
  if (!isFinite(doubling) || doubling === 0) return tempo0 * dt;
  return ((tempo0 * doubling) / Math.LN2) * (Math.pow(2, dt / doubling) - 1);
}

/**
 * Inverse of beatPhaseAt: when does the layer reach beat number `theta`?
 *
 * @returns {number} seconds since reference, or Infinity if that beat is never
 *                   reached (possible when decelerating -- tempo asymptotes to
 *                   zero and the accumulated count converges).
 */
export function timeOfBeat(theta, tempo0, doubling) {
  if (!isFinite(doubling) || doubling === 0) return theta / tempo0;
  const arg = 1 + (theta * Math.LN2) / (tempo0 * doubling);
  if (arg <= 0) return Infinity;
  return doubling * Math.log2(arg);
}

/** Instantaneous tempo of a layer, beats/second. */
export function tempoAt(dt, tempo0, doubling) {
  if (!isFinite(doubling) || doubling === 0) return tempo0;
  return tempo0 * Math.pow(2, dt / doubling);
}

/**
 * Where a rhythm layer sits in the tempo window, in octaves-of-tempo.
 * Mirrors the pitch stack exactly: layer k starts k octaves up the span and
 * climbs at 1 octave per `doubling` seconds, wrapping at the top.
 */
export function rhythmLayerPosition(k, dt, doubling, layers) {
  return wrap(k + dt / doubling, layers);
}

/* -------------------------------------------------------------------------- */
/* Note helpers                                                                */
/* -------------------------------------------------------------------------- */

export function midiToFreq(m, a4 = 440) {
  return a4 * Math.pow(2, (m - 69) / 12);
}

export function freqToMidi(f, a4 = 440) {
  return 69 + 12 * Math.log2(f / a4);
}

/** Nearest note name for display, e.g. 55 Hz -> "A1". */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function freqToNoteName(f, a4 = 440) {
  if (!(f > 0)) return '--';
  const m = Math.round(freqToMidi(f, a4));
  return `${NOTE_NAMES[wrap(m, 12)]}${Math.floor(m / 12) - 1}`;
}
