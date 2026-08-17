/**
 * voicing.js
 *
 * Chord and scale definitions for the Shepard stack.
 *
 * ---------------------------------------------------------------------------
 * THE KEY SIMPLIFICATION
 * ---------------------------------------------------------------------------
 * A raw Shepard glissando is a single stack of octaves -- musically it is one
 * pitch class smeared across the whole spectrum. Interesting as an illusion,
 * fatiguing as music: nothing consonant is ever happening, so the ear has
 * nothing to hold and the sound reads as a siren.
 *
 * The fix is to run several stacks at once, offset by musical intervals, so
 * the thing that rises forever is a *chord* rather than a tone.
 *
 * And here the maths is unusually kind. Transposing a stack up by `s`
 * semitones multiplies every partial frequency by 2^(s/12) -- which is
 * *identical* to advancing that stack's phase by s/12 octaves, because the
 * stack is octave-periodic by construction. So a chord voice is not a second
 * oscillator bank with its own frequencies to track: it is the same bank read
 * at a phase offset. One phase accumulator drives the entire chord, every
 * voice stays locked in tune forever, and no voice can drift out of the
 * spectral window while its neighbours sit inside it.
 *
 * Consequently intervals here are exact ratios of the octave, not tempered
 * approximations, unless you deliberately ask for just intonation below.
 */

/** Offsets are in semitones; only the value mod 12 is musically meaningful. */
export const CHORDS = {
  unison:        { label: 'Unison',            offsets: [0] },
  octaveOnly:    { label: 'Octaves',           offsets: [0] },
  fifth:         { label: 'Power (1-5)',       offsets: [0, 7] },
  majorTriad:    { label: 'Major triad',       offsets: [0, 4, 7] },
  minorTriad:    { label: 'Minor triad',       offsets: [0, 3, 7] },
  sus2:          { label: 'Sus2',              offsets: [0, 2, 7] },
  sus4:          { label: 'Sus4',              offsets: [0, 5, 7] },
  minor7:        { label: 'Minor 7th',         offsets: [0, 3, 7, 10] },
  major7:        { label: 'Major 7th',         offsets: [0, 4, 7, 11] },
  dom9:          { label: 'Dominant 9th',      offsets: [0, 4, 10, 14] },
  minor9:        { label: 'Minor 9th',         offsets: [0, 3, 10, 14] },
  quartal:       { label: 'Quartal',           offsets: [0, 5, 10] },
  wholeTone:     { label: 'Whole tone',        offsets: [0, 2, 4, 6, 8, 10] },
  diminished:    { label: 'Diminished',        offsets: [0, 3, 6, 9] },
  augmented:     { label: 'Augmented',         offsets: [0, 4, 8] },
  tritone:       { label: 'Tritone',           offsets: [0, 6] },
};

export const CHORD_NAMES = Object.keys(CHORDS);

/**
 * Just-intonation variants, in cents. The equal-tempered major third is 14
 * cents sharp of the 5:4 ratio, which on a sustained drone-like texture beats
 * noticeably. Because the stack sustains forever, those beats never resolve --
 * so for the pad-like presets the pure ratios are the better default.
 */
export const JUST_CENTS = {
  0: 0,        // 1:1
  2: 203.91,   // 9:8
  3: 315.64,   // 6:5
  4: 386.31,   // 5:4
  5: 498.04,   // 4:3
  6: 582.51,   // 7:5
  7: 701.96,   // 3:2
  8: 813.69,   // 8:5
  9: 884.36,   // 5:3
  // 9:5, the just minor seventh. The other candidate is 7:4 (968.8 cents, the
  // harmonic seventh), which is the better choice inside a dominant chord but
  // sounds conspicuously flat in the minor 7th and minor 9th voicings this
  // instrument leans on -- and on a chord that sustains forever, "conspicuous"
  // is not a passing impression.
  10: 1017.60, // 9:5
  11: 1088.27, // 15:8
  14: 1403.91, // 9:4
};

/**
 * Resolve a voicing spec to phase offsets in octaves, ready for the worklet.
 *
 * @param {string|number[]} spec  a CHORDS key, or raw semitone offsets
 * @param {object} [opts]
 * @param {boolean} [opts.just]     use just intonation where a ratio is known
 * @param {number}  [opts.detune]   cents of random-ish detune per voice, for
 *                                  a slow chorus-like widening
 * @param {number}  [opts.rootShift] semitones applied to the whole chord
 * @returns {{offsets: number[], gains: number[]}} offsets in OCTAVES
 */
export function resolveVoicing(spec, opts = {}) {
  const { just = false, detune = 0, rootShift = 0 } = opts;
  const semis = Array.isArray(spec)
    ? spec.slice()
    : (CHORDS[spec] || CHORDS.unison).offsets.slice();

  const offsets = [];
  const gains = [];
  const n = semis.length;

  for (let i = 0; i < n; i++) {
    const s = semis[i];
    const cents = just && JUST_CENTS[s] !== undefined ? JUST_CENTS[s] : s * 100;
    // Deterministic per-voice detune spread: alternating sign, growing slightly
    // with voice index. Deterministic matters -- presets must sound the same
    // every time they are recalled, and offline renders must match what was
    // auditioned in real time.
    const spread = detune === 0 ? 0 : detune * ((i % 2 === 0 ? 1 : -1) * (0.5 + i / (2 * n)));
    offsets.push((cents + spread + rootShift * 100) / 1200);

    // Roll the upper voices back a little. Equal-gain chord voices stack up
    // fast and the top of the chord starts to dominate; -1.5 dB per voice
    // keeps the root audible as the root.
    gains.push(Math.pow(10, (-1.5 * i) / 20));
  }

  // Normalise so total power is independent of how many voices the chord has,
  // otherwise switching from unison to a 9th chord jumps the output level.
  let sumSq = 0;
  for (const g of gains) sumSq += g * g;
  const norm = 1 / Math.sqrt(Math.max(sumSq, 1e-12));
  return { offsets, gains: gains.map((g) => g * norm) };
}

/**
 * Scales, for the stepped (Shepard *scale*) mode. Values are steps per octave
 * expressed as a list of semitone degrees; the engine walks them in order.
 */
export const SCALES = {
  chromatic:   { label: 'Chromatic',    degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major:       { label: 'Major',        degrees: [0, 2, 4, 5, 7, 9, 11] },
  minor:       { label: 'Natural minor',degrees: [0, 2, 3, 5, 7, 8, 10] },
  harmonic:    { label: 'Harmonic minor', degrees: [0, 2, 3, 5, 7, 8, 11] },
  phrygian:    { label: 'Phrygian',     degrees: [0, 1, 3, 5, 7, 8, 10] },
  dorian:      { label: 'Dorian',       degrees: [0, 2, 3, 5, 7, 9, 10] },
  lydian:      { label: 'Lydian',       degrees: [0, 2, 4, 6, 7, 9, 11] },
  pentatonic:  { label: 'Pentatonic',   degrees: [0, 2, 4, 7, 9] },
  minorPent:   { label: 'Minor pentatonic', degrees: [0, 3, 5, 7, 10] },
  wholeTone:   { label: 'Whole tone',   degrees: [0, 2, 4, 6, 8, 10] },
  octatonic:   { label: 'Octatonic',    degrees: [0, 2, 3, 5, 6, 8, 9, 11] },
};

export const SCALE_NAMES = Object.keys(SCALES);

/**
 * Build a lookup table mapping the fractional part of an octave to the nearest
 * scale degree at or below it. The worklet uses this to quantise phase without
 * branching: index by floor(frac * TABLE_SIZE).
 *
 * Uniform quantisation (quantizePhase in shepard-math) gives equal steps; this
 * gives *musical* steps, so a stepped rise walks a real scale instead of a
 * chromatic ladder.
 */
export const STEP_TABLE_SIZE = 1200;

export function buildScaleTable(scaleName) {
  const scale = SCALES[scaleName] || SCALES.chromatic;
  const degrees = scale.degrees;
  const table = new Float32Array(STEP_TABLE_SIZE);
  for (let i = 0; i < STEP_TABLE_SIZE; i++) {
    const semis = (i / STEP_TABLE_SIZE) * 12;
    // Largest degree <= semis; the scale is sorted so a linear scan is fine
    // (and this runs once per scale change, not per sample).
    let chosen = degrees[0];
    for (const d of degrees) {
      if (d <= semis) chosen = d;
      else break;
    }
    table[i] = chosen / 12; // in octaves
  }
  return table;
}
