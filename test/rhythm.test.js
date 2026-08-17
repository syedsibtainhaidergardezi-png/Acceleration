/**
 * Tests for the Risset rhythm scheduler.
 *
 * The scheduler is stateless by design: it derives every beat from absolute
 * time. These tests exist to prove that property holds, because it is what
 * makes real-time playback and offline rendering produce identical results.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectBeats, driveCurve, PERCUSSION_VOICES } from '../src/engine/risset-rhythm.js';
import { tempoAt } from '../src/engine/shepard-math.js';

const CFG = {
  startTime: 0,
  baseTempo: 1,
  doubling: 8,
  layers: 5,
  shape: 'hann',
  tilt: 0,
};

test('windowed scheduling equals one-shot scheduling', () => {
  // The property the offline export depends on: chunked real-time scheduling
  // must produce exactly the beats a single whole-span call produces.
  const whole = collectBeats(CFG, 0, 20, 100000);

  const chunked = [];
  const step = 0.6;
  for (let t = 0; t < 20; t += step) {
    chunked.push(...collectBeats(CFG, t, Math.min(20, t + step), 100000));
  }
  chunked.sort((a, b) => a.time - b.time);

  assert.equal(chunked.length, whole.length, 'beat count differs between chunked and whole');
  for (let i = 0; i < whole.length; i++) {
    assert.ok(
      Math.abs(whole[i].time - chunked[i].time) < 1e-9,
      `beat ${i}: ${whole[i].time} vs ${chunked[i].time}`
    );
    assert.equal(whole[i].layer, chunked[i].layer, `beat ${i} layer differs`);
  }
});

test('no beat is emitted twice at a window boundary', () => {
  // Half-open intervals: a beat exactly on the boundary belongs to the later
  // window only. Getting this wrong produces audible flams.
  const a = collectBeats(CFG, 0, 5, 100000);
  const b = collectBeats(CFG, 5, 10, 100000);
  const times = new Set();
  for (const ev of [...a, ...b]) {
    const key = `${ev.layer}:${ev.time.toFixed(9)}`;
    assert.ok(!times.has(key), `duplicate beat at ${ev.time} layer ${ev.layer}`);
    times.add(key);
  }
});

test('every beat falls inside its requested window', () => {
  const events = collectBeats(CFG, 3, 9, 100000);
  assert.ok(events.length > 0, 'expected some beats');
  for (const ev of events) {
    assert.ok(ev.time >= 3 && ev.time < 9, `beat at ${ev.time} outside [3, 9)`);
  }
});

test('events are returned in time order', () => {
  const events = collectBeats(CFG, 0, 30, 100000);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].time >= events[i - 1].time, `out of order at ${i}`);
  }
});

test('inter-beat interval matches the instantaneous tempo', () => {
  // Verifies the closed-form placement really tracks T(t) = T0 * 2^(t/D).
  const events = collectBeats(CFG, 0, 24, 100000).filter((e) => e.layer === 0);
  assert.ok(events.length > 5, 'expected several beats on layer 0');

  for (let i = 1; i < events.length; i++) {
    const gap = events[i].time - events[i - 1].time;
    if (gap > 3) continue; // segment boundary, where the layer restarts silently
    // The gap should be about 1/tempo evaluated midway between the two beats.
    const midTempo = (events[i].tempo + events[i - 1].tempo) / 2;
    const expected = 1 / midTempo;
    assert.ok(
      Math.abs(gap - expected) / expected < 0.02,
      `gap ${gap} vs expected ${expected}`
    );
  }
});

test('beats accelerate: each gap is shorter than the last', () => {
  const events = collectBeats(CFG, 0, 7, 100000).filter((e) => e.layer === 0);
  let prevGap = Infinity;
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].time - events[i - 1].time;
    assert.ok(gap < prevGap, `gap ${gap} not shorter than previous ${prevGap}`);
    prevGap = gap;
  }
});

test('a beat"s tempo is exactly baseTempo * 2^position', () => {
  // The tempo-domain equivalent of "partials are exactly octave-spaced".
  // Since layer positions are unit-spaced in the span (proved separately in
  // shepard-math.test.js), this identity is what makes the layers exactly
  // octave-spaced in tempo at every instant.
  //
  // Asserting the identity beats sampling tempi from a short window: slow
  // layers may not fire at all inside one, which makes such a test flaky
  // rather than wrong.
  const events = collectBeats(CFG, 0, 40, 100000);
  assert.ok(events.length > 20, 'expected plenty of beats');
  for (const ev of events) {
    const expected = CFG.baseTempo * Math.pow(2, ev.position);
    assert.ok(
      Math.abs(ev.tempo - expected) / expected < 1e-9,
      `layer ${ev.layer} at pos ${ev.position}: tempo ${ev.tempo} != ${expected}`
    );
  }
});

test('every layer contributes, and each sweeps the whole tempo span', () => {
  // Coverage rather than spacing: over a long window each layer should climb
  // from the quiet bottom of the span to the quiet top. A layer that never
  // fires, or one stuck at one position, would mean the illusion is running on
  // fewer voices than configured.
  //
  // (Instantaneous octave spacing between layers cannot be measured from
  // events, since each layer's beats land at different times and positions
  // advance continuously. That property is proved directly in
  // shepard-math.test.js via rhythmLayerPosition.)
  const events = collectBeats(CFG, 0, CFG.doubling * CFG.layers, 100000);
  const seen = new Map();
  for (const ev of events) {
    const range = seen.get(ev.layer) || { lo: Infinity, hi: -Infinity };
    range.lo = Math.min(range.lo, ev.position);
    range.hi = Math.max(range.hi, ev.position);
    seen.set(ev.layer, range);
  }

  assert.equal(seen.size, CFG.layers, `only ${seen.size} of ${CFG.layers} layers fired`);
  for (const [layer, range] of seen) {
    assert.ok(
      range.hi - range.lo > CFG.layers * 0.6,
      `layer ${layer} only covered ${range.lo}..${range.hi} of a ${CFG.layers}-wide span`
    );
  }
});

test('gains follow the window: quiet at the span edges', () => {
  const events = collectBeats(CFG, 0, 40, 100000);
  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.ok(ev.gain > 0 && ev.gain <= 1.0001, `gain out of range: ${ev.gain}`);
    // Beats near either edge of the tempo span must be quiet, or the layer
    // appearing and disappearing would be audible.
    if (ev.position < 0.3 || ev.position > CFG.layers - 0.3) {
      assert.ok(ev.gain < 0.25, `edge beat too loud: pos ${ev.position} gain ${ev.gain}`);
    }
  }
});

test('the whole configuration repeats after one doubling time', () => {
  // The rhythm's period. This is what makes a seamless loop possible when
  // transport linking is on.
  const a = collectBeats(CFG, 40, 44, 100000);
  const b = collectBeats(CFG, 40 + CFG.doubling, 44 + CFG.doubling, 100000);

  assert.equal(a.length, b.length, 'beat count differs across one period');
  for (let i = 0; i < a.length; i++) {
    assert.ok(
      Math.abs(a[i].position - b[i].position) < 1e-6,
      `position drift at ${i}: ${a[i].position} vs ${b[i].position}`
    );
    assert.ok(Math.abs(a[i].gain - b[i].gain) < 1e-6, `gain drift at ${i}`);
  }
});

test('decelerating (negative doubling) produces slowing beats', () => {
  const cfg = { ...CFG, doubling: -8 };
  const events = collectBeats(cfg, 0, 6, 100000).filter((e) => e.layer === 2);
  assert.ok(events.length > 2, 'expected beats when decelerating');
  let prevGap = 0;
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].time - events[i - 1].time;
    if (gap > 3) continue;
    assert.ok(gap > prevGap, `gap ${gap} should exceed previous ${prevGap}`);
    prevGap = gap;
  }
});

test('degenerate configurations return nothing rather than hanging', () => {
  assert.equal(collectBeats(CFG, 5, 5).length, 0, 'empty window');
  assert.equal(collectBeats(CFG, 5, 1).length, 0, 'reversed window');
  assert.equal(collectBeats({ ...CFG, baseTempo: 0 }, 0, 10).length, 0, 'zero tempo');
  assert.equal(collectBeats({ ...CFG, doubling: 0 }, 0, 10).length, 0, 'zero doubling');
});

test('the event cap bounds the work done for an extreme request', () => {
  // A very fast tempo over a very long window must not attempt to allocate
  // millions of events on the audio thread's critical path.
  const cfg = { ...CFG, baseTempo: 40, doubling: 1 };
  const events = collectBeats(cfg, 0, 600, 512);
  assert.ok(events.length <= 512, `cap exceeded: ${events.length}`);
});

test('tempoAt agrees with the tempo reported on each event', () => {
  const events = collectBeats(CFG, 0, 6, 100000).filter((e) => e.layer === 0);
  for (const ev of events) {
    assert.ok(Math.abs(tempoAt(ev.time, CFG.baseTempo, CFG.doubling) - ev.tempo) < 1e-9);
  }
});

/* -------------------------------------------------------------------------- */

test('drive curve is monotonic, odd-symmetric and bounded', () => {
  for (const amount of [0, 0.3, 1]) {
    const curve = driveCurve(amount, 257);
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i] >= curve[i - 1], `not monotonic at ${i} (amount ${amount})`);
    }
    assert.ok(Math.abs(curve[0] + 1) < 1e-6, 'should map -1 to -1');
    assert.ok(Math.abs(curve[curve.length - 1] - 1) < 1e-6, 'should map +1 to +1');
    assert.ok(Math.abs(curve[(curve.length - 1) / 2]) < 1e-6, 'should map 0 to 0');
  }
});

test('percussion voices all have labels', () => {
  for (const [name, v] of Object.entries(PERCUSSION_VOICES)) {
    assert.ok(v.label && v.label.length, `${name} needs a label`);
  }
});
