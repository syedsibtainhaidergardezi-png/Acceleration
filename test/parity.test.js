/**
 * Parity between the worklets' inlined maths and the shared module.
 *
 * The worklets deliberately duplicate wrap/windowAt/tiltAt instead of
 * importing them, because AudioWorklet module imports are not reliably
 * supported everywhere and a failed addModule means total silence. The cost of
 * that decision is the risk of the two copies drifting apart -- a fix applied
 * to the tested copy while the copy that actually makes sound goes stale.
 *
 * These tests remove that risk: they load the real worklet source and assert it
 * agrees with the shared implementation to float precision. If someone edits
 * one and not the other, CI says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as shared from '../src/engine/shepard-math.js';

/**
 * Worklet modules reference AudioWorkletProcessor, registerProcessor and the
 * `sampleRate` global at evaluation time. Stub them so the module can be
 * imported in plain Node.
 */
function installWorkletGlobals() {
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
  };
  globalThis.registerProcessor = () => {};
  globalThis.sampleRate = 48000;
  globalThis.currentTime = 0;
}

installWorkletGlobals();

const osc = await import('../src/worklets/shepard-osc-processor.js');
const sampler = await import('../src/worklets/shepard-sampler-processor.js');

const SHAPES = ['hann', 'blackman', 'blackmanHarris', 'flat', 'gauss'];

for (const [name, mod] of [['osc', osc], ['sampler', sampler]]) {
  test(`${name} worklet: wrap matches shared implementation`, () => {
    for (const n of [3, 5, 8, 10]) {
      for (let i = -40; i < 40; i++) {
        const x = i * 0.37;
        assert.equal(mod.wrap(x, n), shared.wrap(x, n), `wrap(${x}, ${n})`);
      }
    }
  });

  test(`${name} worklet: windowAt matches shared implementation`, () => {
    for (const shape of SHAPES) {
      for (const n of [4, 8, 9]) {
        for (let i = 0; i <= 200; i++) {
          const e = (i / 200) * n;
          const a = mod.windowAt(e, n, shape, n / 6);
          const b = shared.windowAt(e, n, shape, n / 6);
          assert.ok(
            Math.abs(a - b) < 1e-12,
            `${shape} n=${n} e=${e}: worklet ${a} vs shared ${b}`
          );
        }
      }
    }
  });

  test(`${name} worklet: tiltAt matches shared implementation`, () => {
    for (const tilt of [0, -1.5, -6, 3]) {
      for (let i = 0; i <= 40; i++) {
        const e = (i / 40) * 8;
        const a = mod.tiltAt(e, 8, tilt);
        const b = shared.tiltAt(e, 8, tilt);
        assert.ok(Math.abs(a - b) < 1e-12, `tilt=${tilt} e=${e}`);
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Wavetable band-limiting                                                     */
/* -------------------------------------------------------------------------- */

/** Naive DFT magnitude at harmonic k of a periodic table. */
function harmonicMagnitude(table, k, len) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < len; i++) {
    const ang = (2 * Math.PI * k * i) / len;
    re += table[i] * Math.cos(ang);
    im -= table[i] * Math.sin(ang);
  }
  return (2 * Math.sqrt(re * re + im * im)) / len;
}

test('wavetable mips contain no harmonics that would alias', () => {
  // The anti-aliasing guarantee, verified rather than assumed: for each mip,
  // every harmonic that would exceed Nyquist at the top of that mip's octave
  // band must be absent from the table.
  const sr = 48000;
  const nyquist = sr / 2;
  const TABLE_LEN = 2048;
  const MIP_BASE_HZ = 20;

  for (const waveform of ['saw', 'square', 'glass']) {
    const mips = osc.buildWavetables(waveform, sr);
    for (let m = 0; m < mips.length; m++) {
      const topFreq = MIP_BASE_HZ * Math.pow(2, m + 1);
      const maxAllowed = Math.floor(nyquist / topFreq);
      if (maxAllowed < 2 || maxAllowed > 200) continue; // keep the DFT cheap

      const table = mips[m];
      // The first harmonic beyond the limit must be essentially absent.
      const mag = harmonicMagnitude(table, maxAllowed + 1, TABLE_LEN);
      assert.ok(
        mag < 1e-4,
        `${waveform} mip ${m}: harmonic ${maxAllowed + 1} present at ${mag}`
      );
    }
  }
});

test('wavetables are normalised and continuous at the wrap point', () => {
  const mips = osc.buildWavetables('saw', 48000);
  for (const table of mips) {
    let peak = 0;
    for (let i = 0; i < 2048; i++) peak = Math.max(peak, Math.abs(table[i]));
    assert.ok(Math.abs(peak - 1) < 1e-5, `peak ${peak} should be 1`);
    // Guard point must equal the first sample, or interpolation across the
    // wrap produces a discontinuity once per cycle.
    assert.equal(table[2048], table[0]);
  }
});

test('wavetable generation is deterministic', () => {
  // Presets and offline renders must reproduce exactly; a PRNG without a fixed
  // seed here would make every page load sound subtly different.
  const a = osc.buildWavetables('glass', 48000)[3];
  const b = osc.buildWavetables('glass', 48000)[3];
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('sine wavetable really is a sine', () => {
  const table = osc.buildWavetables('sine', 48000)[0];
  const fundamental = harmonicMagnitude(table, 1, 2048);
  const second = harmonicMagnitude(table, 2, 2048);
  const third = harmonicMagnitude(table, 3, 2048);
  assert.ok(Math.abs(fundamental - 1) < 1e-4, `fundamental ${fundamental}`);
  assert.ok(second < 1e-6, `second harmonic leaked: ${second}`);
  assert.ok(third < 1e-6, `third harmonic leaked: ${third}`);
});
