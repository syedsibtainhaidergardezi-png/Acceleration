/**
 * Tests for chord voicing and scale quantisation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHORDS,
  SCALES,
  JUST_CENTS,
  resolveVoicing,
  buildScaleTable,
  STEP_TABLE_SIZE,
} from '../src/engine/voicing.js';
import { stackGains } from '../src/engine/shepard-math.js';

test('every chord starts on the root and has unique degrees', () => {
  for (const [name, chord] of Object.entries(CHORDS)) {
    assert.equal(chord.offsets[0], 0, `${name} should start at the root`);
    const mod12 = chord.offsets.map((s) => ((s % 12) + 12) % 12);
    assert.equal(new Set(mod12).size, mod12.length, `${name} has duplicate pitch classes`);
    assert.ok(chord.label && chord.label.length > 0, `${name} needs a label`);
  }
});

test('a semitone offset equals a phase offset of s/12 octaves', () => {
  // The identity the whole voicing design rests on: transposing the stack and
  // advancing its phase are the same operation, so chord voices can never
  // drift out of tune with each other.
  const { offsets } = resolveVoicing([0, 7], { just: false, detune: 0 });
  assert.ok(Math.abs(offsets[0] - 0) < 1e-12);
  assert.ok(Math.abs(offsets[1] - 7 / 12) < 1e-12);

  const base = 27.5;
  const n = 8;
  const root = stackGains({ phase: 0, octaves: n, baseFreq: base });
  const fifth = stackGains({ phase: 0, octaves: n, baseFreq: base, offset: 7 / 12 });

  // The fifth's partials should be the root's, multiplied by 2^(7/12).
  const sortF = (s) => Array.from(s.freqs).sort((a, b) => a - b);
  const rf = sortF(root);
  const ff = sortF(fifth);
  const ratio = Math.pow(2, 7 / 12);
  for (let i = 0; i < rf.length - 1; i++) {
    assert.ok(
      Math.abs(ff[i] / rf[i] - ratio) < 1e-9,
      `partial ${i}: ratio ${ff[i] / rf[i]} != ${ratio}`
    );
  }
});

test('just intonation uses the pure ratios, not tempered ones', () => {
  const { offsets } = resolveVoicing([0, 4, 7], { just: true, detune: 0 });
  // 5:4 major third and 3:2 fifth.
  assert.ok(Math.abs(Math.pow(2, offsets[1]) - 5 / 4) < 1e-4, 'major third should be 5:4');
  assert.ok(Math.abs(Math.pow(2, offsets[2]) - 3 / 2) < 1e-4, 'fifth should be 3:2');

  const tempered = resolveVoicing([0, 4, 7], { just: false, detune: 0 });
  // The tempered third is famously ~14 cents sharp of pure.
  const centsDiff = (tempered.offsets[1] - offsets[1]) * 1200;
  assert.ok(centsDiff > 13 && centsDiff < 15, `expected ~13.7 cents, got ${centsDiff}`);
});

test('every JUST_CENTS entry is within 20 cents of its tempered degree', () => {
  for (const [semi, cents] of Object.entries(JUST_CENTS)) {
    const tempered = Number(semi) * 100;
    assert.ok(
      Math.abs(cents - tempered) < 20,
      `degree ${semi}: ${cents} cents is not a plausible just interval`
    );
  }
});

test('voice gains are power-normalised regardless of chord size', () => {
  // Switching chords must not jump the output level.
  for (const name of Object.keys(CHORDS)) {
    const { gains } = resolveVoicing(name);
    let sumSq = 0;
    for (const g of gains) sumSq += g * g;
    assert.ok(Math.abs(sumSq - 1) < 1e-9, `${name}: power ${sumSq}`);
  }
});

test('upper chord voices are rolled back so the root stays the root', () => {
  const { gains } = resolveVoicing('minor9');
  for (let i = 1; i < gains.length; i++) {
    assert.ok(gains[i] < gains[i - 1], `voice ${i} should be quieter than ${i - 1}`);
  }
});

test('detune is deterministic and symmetric-ish', () => {
  // Determinism matters: a preset must sound identical every recall, and an
  // offline render must match what was auditioned.
  const a = resolveVoicing('majorTriad', { detune: 10 });
  const b = resolveVoicing('majorTriad', { detune: 10 });
  for (let i = 0; i < a.offsets.length; i++) assert.equal(a.offsets[i], b.offsets[i]);

  const none = resolveVoicing('majorTriad', { detune: 0 });
  assert.notEqual(a.offsets[1], none.offsets[1], 'detune should actually do something');
});

test('rootShift transposes the whole chord uniformly', () => {
  const base = resolveVoicing('minorTriad', { detune: 0 });
  const up = resolveVoicing('minorTriad', { detune: 0, rootShift: 5 });
  for (let i = 0; i < base.offsets.length; i++) {
    assert.ok(Math.abs(up.offsets[i] - base.offsets[i] - 5 / 12) < 1e-12);
  }
});

/* -------------------------------------------------------------------------- */

test('scale tables are monotonic and stay within one octave', () => {
  for (const name of Object.keys(SCALES)) {
    const table = buildScaleTable(name);
    assert.equal(table.length, STEP_TABLE_SIZE);
    let prev = -Infinity;
    for (let i = 0; i < table.length; i++) {
      assert.ok(table[i] >= prev, `${name} not monotonic at ${i}`);
      assert.ok(table[i] >= 0 && table[i] < 1, `${name} out of range at ${i}: ${table[i]}`);
      prev = table[i];
    }
  }
});

test('scale tables emit exactly the scale degrees, and nothing else', () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    const table = buildScaleTable(name);
    const produced = new Set(Array.from(table).map((v) => Math.round(v * 12)));
    const expected = new Set(scale.degrees);
    assert.deepEqual(
      [...produced].sort((a, b) => a - b),
      [...expected].sort((a, b) => a - b),
      `${name} produced unexpected degrees`
    );
  }
});

test('scale degrees are sorted and inside an octave', () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    for (let i = 1; i < scale.degrees.length; i++) {
      assert.ok(scale.degrees[i] > scale.degrees[i - 1], `${name} degrees not sorted`);
    }
    assert.ok(scale.degrees[0] === 0, `${name} should start at 0`);
    assert.ok(scale.degrees[scale.degrees.length - 1] < 12, `${name} exceeds an octave`);
  }
});
