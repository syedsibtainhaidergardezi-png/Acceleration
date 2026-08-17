/**
 * Tests for the illusion's core maths.
 *
 * These are not incidental unit tests -- each one pins down a property the
 * illusion actually depends on. If any of them fails, the seam becomes
 * audible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  wrap,
  windowAt,
  tiltAt,
  stackGains,
  rateShape,
  quantizePhase,
  ratePerSecond,
  beatPhaseAt,
  timeOfBeat,
  tempoAt,
  rhythmLayerPosition,
  freqToNoteName,
  midiToFreq,
  WINDOW_COEFFS,
} from '../src/engine/shepard-math.js';

/* -------------------------------------------------------------------------- */

test('wrap returns a value in [0, n) for negative and positive input', () => {
  assert.equal(wrap(9, 8), 1);
  assert.equal(wrap(-1, 8), 7);
  assert.equal(wrap(-8.5, 8), 7.5);
  assert.equal(wrap(0, 8), 0);
  assert.ok(wrap(-1e-9, 8) < 8);
});

/* -------------------------------------------------------------------------- */

test('cosine-sum windows vanish at both span edges', () => {
  // This is what makes the octave wrap silent. A window that is nonzero at the
  // edge means a partial appears and disappears at audible level.
  //
  // Hann and Blackman are exactly zero there. Blackman-Harris is not: its
  // standard coefficients sum to 6e-5, about -84 dBFS, which is below the
  // noise floor of 16-bit audio and inaudible under any playback condition --
  // so it is held to that weaker bound rather than to zero.
  const edgeTolerance = { hann: 1e-12, blackman: 1e-12, blackmanHarris: 1e-4 };

  for (const [shape, tol] of Object.entries(edgeTolerance)) {
    const n = 8;
    assert.ok(
      windowAt(0, n, shape) < tol,
      `${shape} should vanish at the bottom edge, got ${windowAt(0, n, shape)}`
    );
    assert.ok(
      windowAt(n, n, shape) < tol,
      `${shape} should vanish at the top edge, got ${windowAt(n, n, shape)}`
    );
  }
});

test('gaussian window is deliberately NOT zero at the edges', () => {
  // Documented behaviour: gauss is offered for its timbre, at the cost of an
  // audible wrap. If this ever becomes zero, the window ceased being Gaussian.
  const g = windowAt(0, 8, 'gauss', 8 / 6);
  assert.ok(g > 1e-4, 'gauss should leak at the edge');
  assert.ok(g < 0.05, 'but not by much at the default width');
});

test('window is symmetric about the centre of the span', () => {
  const n = 8;
  for (const shape of ['hann', 'blackman', 'blackmanHarris', 'gauss']) {
    for (const d of [0.5, 1, 2, 3.5]) {
      const a = windowAt(n / 2 - d, n, shape, n / 6);
      const b = windowAt(n / 2 + d, n, shape, n / 6);
      assert.ok(Math.abs(a - b) < 1e-12, `${shape} asymmetric at d=${d}`);
    }
  }
});

/* -------------------------------------------------------------------------- */

test('summed amplitude of the sliding stack is EXACTLY constant', () => {
  // The constant-overlap-add property of cosine-sum windows at unit hop. This
  // is why there is no loudness pumping as the stack slides -- it is an
  // identity, not an approximation, so the tolerance here is float epsilon.
  for (const shape of ['hann', 'blackman', 'blackmanHarris']) {
    const n = 8;
    const expected = WINDOW_COEFFS[shape][0] * n;

    for (let step = 0; step < 64; step++) {
      const phase = (step / 64) * n;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += windowAt(wrap(i + phase, n), n, shape);
      assert.ok(
        Math.abs(sum - expected) < 1e-9,
        `${shape}: sum ${sum} != ${expected} at phase ${phase}`
      );
    }
  }
});

test('constant-sum holds across different span widths', () => {
  for (const n of [3, 4, 6, 8, 9, 10]) {
    const expected = 0.5 * n;
    for (let step = 0; step < 16; step++) {
      const phase = (step / 16) * n;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += windowAt(wrap(i + phase, n), n, 'hann');
      assert.ok(Math.abs(sum - expected) < 1e-9, `n=${n} sum=${sum}`);
    }
  }
});

/* -------------------------------------------------------------------------- */

test('stack partials are exactly octave-spaced', () => {
  const { freqs } = stackGains({ phase: 1.37, octaves: 8, baseFreq: 27.5 });
  const sorted = Array.from(freqs).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const ratio = sorted[i] / sorted[i - 1];
    assert.ok(
      Math.abs(ratio - 2) < 1e-9,
      `partials ${i - 1}->${i} ratio ${ratio}, expected 2`
    );
  }
});

test('stack repeats exactly after one octave of phase', () => {
  // The defining property: after advancing one octave the spectrum is
  // identical, so the rise can never be detected as having restarted.
  const opts = { octaves: 8, baseFreq: 27.5, shape: 'hann', tilt: -2 };
  const a = stackGains({ ...opts, phase: 0.31 });
  const b = stackGains({ ...opts, phase: 1.31 });

  const sortPairs = (s) =>
    Array.from(s.freqs)
      .map((f, i) => [f, s.gains[i]])
      .sort((x, y) => x[0] - y[0]);

  const pa = sortPairs(a);
  const pb = sortPairs(b);
  assert.equal(pa.length, pb.length);
  for (let i = 0; i < pa.length; i++) {
    assert.ok(Math.abs(pa[i][0] - pb[i][0]) < 1e-6, `freq mismatch at ${i}`);
    assert.ok(Math.abs(pa[i][1] - pb[i][1]) < 1e-9, `gain mismatch at ${i}`);
  }
});

test('levelLock produces phase-independent RMS even with heavy tilt', () => {
  // Tilt breaks constant-sum by design; levelLock is what restores constant
  // perceived level on top of it.
  const opts = { octaves: 8, baseFreq: 27.5, shape: 'hann', tilt: -6, levelLock: true };
  let min = Infinity;
  let max = -Infinity;
  for (let step = 0; step < 48; step++) {
    const { gains } = stackGains({ ...opts, phase: (step / 48) * 8 });
    let sumSq = 0;
    for (const g of gains) sumSq += g * g;
    min = Math.min(min, sumSq);
    max = Math.max(max, sumSq);
  }
  assert.ok(Math.abs(max - 1) < 1e-9 && Math.abs(min - 1) < 1e-9,
    `RMS not locked: ${min}..${max}`);
});

test('without levelLock, tilt does cause level variation — but very little', () => {
  // Guards the test above from passing vacuously, and pins down how much is
  // actually at stake.
  //
  // The measured spread is remarkably small: with Hann and a steep -8 dB/oct
  // tilt the stack's RMS still varies by only ~0.07 dB across a full cycle,
  // because the window's constant-overlap-add property survives the tilt
  // almost intact. levelLock takes that to exactly zero. Worth knowing: it
  // means tilt is safe to reach for even with levelLock off.
  const measure = (tilt) => {
    let min = Infinity;
    let max = -Infinity;
    for (let step = 0; step < 200; step++) {
      const { gains } = stackGains({
        phase: (step / 200) * 8, octaves: 8, baseFreq: 27.5, shape: 'hann', tilt, levelLock: false,
      });
      let sumSq = 0;
      for (const g of gains) sumSq += g * g;
      min = Math.min(min, sumSq);
      max = Math.max(max, sumSq);
    }
    return 10 * Math.log10(max / min);
  };

  assert.ok(measure(0) < 1e-9, 'zero tilt must be exactly flat');
  assert.ok(measure(-8) > 1e-4, 'steep tilt should measurably vary');
  assert.ok(measure(-8) < 0.2, `variation should stay tiny, got ${measure(-8)} dB`);
  // And it should grow monotonically with tilt depth.
  assert.ok(measure(-8) > measure(-6) && measure(-6) > measure(-3));
});

test('tilt is unity at the centre and symmetric in dB', () => {
  assert.equal(tiltAt(4, 8, -3), 1);
  const below = 20 * Math.log10(tiltAt(3, 8, -3));
  const above = 20 * Math.log10(tiltAt(5, 8, -3));
  assert.ok(Math.abs(below - 3) < 1e-9);
  assert.ok(Math.abs(above + 3) < 1e-9);
});

/* -------------------------------------------------------------------------- */

test('rateShape averages to exactly 1 over a cycle', () => {
  // Swoop must not change how long an octave takes, or it would alter the
  // illusion's period (and break seamless export lengths).
  for (const amount of [0, 0.2, 0.5, -0.4, 0.9]) {
    const steps = 20000;
    let sum = 0;
    for (let i = 0; i < steps; i++) sum += rateShape(i / steps, amount);
    const mean = sum / steps;
    assert.ok(Math.abs(mean - 1) < 1e-6, `amount ${amount} mean ${mean}`);
  }
});

test('rateShape stays strictly positive so the rise never reverses', () => {
  for (const amount of [0.9, -0.9, 2, -2]) {
    for (let i = 0; i < 1000; i++) {
      assert.ok(rateShape(i / 1000, amount) > 0, `non-positive rate at ${amount}`);
    }
  }
});

test('rateShape is periodic in phase with period 1 octave', () => {
  for (let i = 0; i < 50; i++) {
    const p = i / 50;
    assert.ok(Math.abs(rateShape(p, 0.6) - rateShape(p + 3, 0.6)) < 1e-12);
  }
});

/* -------------------------------------------------------------------------- */

test('quantizePhase snaps to an even grid and is monotonic', () => {
  assert.equal(quantizePhase(0.99, 0), 0.99);
  assert.equal(quantizePhase(0.99, 1), 0.99);
  assert.equal(quantizePhase(0.5, 12), 6 / 12);
  assert.equal(quantizePhase(0.54, 12), 6 / 12);

  let prev = -Infinity;
  for (let i = 0; i < 500; i++) {
    const q = quantizePhase(i / 100, 7);
    assert.ok(q >= prev, 'quantised phase must never go backwards');
    prev = q;
  }
});

test('ratePerSecond inverts the octave time and honours direction', () => {
  assert.ok(Math.abs(ratePerSecond(10, 1) - 0.1) < 1e-12);
  assert.ok(Math.abs(ratePerSecond(10, -1) + 0.1) < 1e-12);
  assert.ok(isFinite(ratePerSecond(0, 1)), 'must not divide by zero');
});

/* -------------------------------------------------------------------------- */
/* Risset rhythm                                                              */
/* -------------------------------------------------------------------------- */

test('beatPhaseAt and timeOfBeat are exact inverses', () => {
  for (const doubling of [2, 8, -8, 30]) {
    for (const tempo0 of [0.25, 1, 4]) {
      for (const theta of [1, 5, 17.5, 90]) {
        const t = timeOfBeat(theta, tempo0, doubling);
        if (!isFinite(t)) continue;
        const back = beatPhaseAt(t, tempo0, doubling);
        assert.ok(
          Math.abs(back - theta) < 1e-9,
          `roundtrip failed: theta=${theta} D=${doubling} T0=${tempo0} -> ${back}`
        );
      }
    }
  }
});

test('tempo doubles after exactly one doubling time', () => {
  const D = 6;
  assert.ok(Math.abs(tempoAt(D, 1.5, D) - 3) < 1e-12);
  assert.ok(Math.abs(tempoAt(2 * D, 1.5, D) - 6) < 1e-12);
  assert.ok(Math.abs(tempoAt(0, 1.5, D) - 1.5) < 1e-12);
});

test('naive incremental scheduling would drift, closed form does not', () => {
  // The reason timeOfBeat exists. Simulate the obvious "sleep 1/tempo" loop
  // and show it diverges from the true beat times.
  const D = 4;
  const T0 = 1;
  const beats = 12;

  let naive = 0;
  for (let n = 0; n < beats; n++) naive += 1 / tempoAt(naive, T0, D);
  const exact = timeOfBeat(beats, T0, D);

  assert.ok(
    Math.abs(naive - exact) > 0.15,
    `expected meaningful drift, got naive=${naive} exact=${exact}`
  );
  // And confirm the closed form really is the integral, by dense numeric
  // integration of the tempo curve.
  let theta = 0;
  const dt = 1e-5;
  for (let t = 0; t < exact; t += dt) theta += tempoAt(t, T0, D) * dt;
  assert.ok(Math.abs(theta - beats) < 1e-2, `integral check: ${theta}`);
});

test('rhythm layer positions stay evenly distributed across the span', () => {
  const L = 5;
  const D = 8;
  for (const dt of [0, 1.3, 7.9, 40]) {
    const positions = [];
    for (let k = 0; k < L; k++) positions.push(rhythmLayerPosition(k, dt, D, L));
    positions.sort((a, b) => a - b);
    for (let i = 1; i < L; i++) {
      assert.ok(
        Math.abs(positions[i] - positions[i - 1] - 1) < 1e-9,
        `layers not unit-spaced at dt=${dt}`
      );
    }
  }
});

/* -------------------------------------------------------------------------- */

test('note naming matches known reference pitches', () => {
  assert.equal(freqToNoteName(440), 'A4');
  assert.equal(freqToNoteName(27.5), 'A0');
  assert.equal(freqToNoteName(261.6255653), 'C4');
  assert.equal(freqToNoteName(0), '--');
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
});
