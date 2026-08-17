/**
 * presets.js
 *
 * Each preset is a sparse patch merged over DEFAULT_PARAMS, so a preset only
 * states what it changes and new parameters get sensible values automatically.
 *
 * The set is arranged to cover the range of the instrument rather than to show
 * off: one mathematically pure reference, several musical voicings, one that
 * is mostly rhythm, and one going the other way.
 */

export const PRESETS = [
  {
    id: 'neutron-star',
    name: 'Neutron Star',
    blurb: 'The core patch. A minor 9th chord spiralling upward over an accelerating pulse, both locked to one clock.',
    params: {
      transport: { secondsPerOctave: 16, direction: 1, swoop: 0.18, link: true },
      stack: { baseFreq: 27.5, octaves: 8, shape: 'hann', tilt: -1.8 },
      tone: { enabled: true, gain: 0.3, waveform: 'organ', voicing: 'minor9', just: true, detune: 7, spread: 0.7 },
      drone: { enabled: true, gain: 0.18, octave: 1, cutoff: 300 },
      rhythm: { enabled: true, baseTempo: 0.85, layers: 5, voice: 'kick', baseFreq: 52, gain: 0.5, decay: 0.34 },
      pulse: { depth: 0.18 },
      fx: { drive: 0.18, cutoff: 6200, chorus: 0.4, delayMix: 0.2, reverbMix: 0.32, reverbSize: 4, width: 1.2 },
    },
  },
  {
    id: 'barber-pole',
    name: 'Barber Pole',
    blurb: 'The textbook illusion, undressed: pure sines, one pitch class, no effects. The reference to check the maths against.',
    params: {
      transport: { secondsPerOctave: 10, direction: 1, swoop: 0, link: false },
      stack: { baseFreq: 27.5, octaves: 9, shape: 'hann', tilt: 0, levelLock: true },
      tone: { enabled: true, gain: 0.35, waveform: 'sine', voicing: 'unison', just: false, detune: 0, spread: 0 },
      sample: { enabled: false },
      drone: { enabled: false },
      rhythm: { enabled: false },
      pulse: { depth: 0 },
      fx: { drive: 0, cutoff: 18000, chorus: 0, delayMix: 0, reverbMix: 0, width: 1, output: 0.95 },
    },
  },
  {
    id: 'event-horizon',
    name: 'Event Horizon',
    blurb: 'Very slow, very wide, almost no attack. A rise you notice only by having noticed it.',
    params: {
      transport: { secondsPerOctave: 48, direction: 1, swoop: 0, link: false },
      stack: { baseFreq: 20.6, octaves: 9, shape: 'blackman', tilt: -3.2 },
      tone: { enabled: true, gain: 0.32, waveform: 'sine', voicing: 'sus2', just: true, detune: 9, spread: 0.85 },
      drone: { enabled: true, gain: 0.2, octave: 0, cutoff: 220 },
      rhythm: { enabled: false },
      fx: { drive: 0.08, cutoff: 3400, chorus: 0.55, delayTime: 0.9, delayFeedback: 0.5, delayMix: 0.28, reverbMix: 0.5, reverbSize: 8, width: 1.4, output: 0.62 },
    },
  },
  {
    id: 'spin-up',
    name: 'Spin-Up',
    blurb: 'Fast, bright and mean. Saw stack, metallic hits, hard swoop — the acceleration you feel in your chest.',
    params: {
      transport: { secondsPerOctave: 6, direction: 1, swoop: 0.45, link: true },
      stack: { baseFreq: 32.7, octaves: 7, shape: 'hann', tilt: -1 },
      tone: { enabled: true, gain: 0.24, waveform: 'saw', voicing: 'fifth', just: true, detune: 12, spread: 0.75 },
      drone: { enabled: true, gain: 0.2, octave: 1, waveform: 'sawtooth', cutoff: 420 },
      rhythm: { enabled: true, baseTempo: 1.4, layers: 5, voice: 'metal', baseFreq: 74, gain: 0.5, decay: 0.2, tone: 0.7 },
      pulse: { depth: 0.35 },
      fx: { drive: 0.42, cutoff: 8200, resonance: 1.6, chorus: 0.3, delayMix: 0.22, delayFeedback: 0.42, reverbMix: 0.24, reverbSize: 2.6, width: 1.3 },
    },
  },
  {
    id: 'pulsar-clock',
    name: 'Pulsar Clock',
    blurb: 'Rhythm forward. The tonal stack is a bed; the accelerating beat is the subject.',
    params: {
      transport: { secondsPerOctave: 12, direction: 1, swoop: 0, link: true },
      stack: { baseFreq: 27.5, octaves: 8, tilt: -4 },
      tone: { enabled: true, gain: 0.15, waveform: 'sine', voicing: 'fifth', just: true, spread: 0.5 },
      drone: { enabled: true, gain: 0.22, octave: 0, cutoff: 180 },
      rhythm: { enabled: true, baseTempo: 1.1, layers: 6, voice: 'click', baseFreq: 90, gain: 0.6, decay: 0.14, pitchTrack: 0.7, tone: 0.6 },
      pulse: { depth: 0.5 },
      fx: { drive: 0.12, cutoff: 9000, chorus: 0.2, delayTime: 0.3, delayFeedback: 0.38, delayMix: 0.25, reverbMix: 0.22, reverbSize: 2.2, width: 1.25 },
    },
  },
  {
    id: 'cathedral-ascent',
    name: 'Cathedral Ascent',
    blurb: 'Major 7th in just intonation through a long tail. Consonant, slow, and unmistakably going somewhere.',
    params: {
      transport: { secondsPerOctave: 26, direction: 1, swoop: 0.1, link: false },
      stack: { baseFreq: 24.5, octaves: 9, shape: 'blackman', tilt: -2.4 },
      tone: { enabled: true, gain: 0.28, waveform: 'glass', voicing: 'major7', just: true, detune: 5, spread: 0.8 },
      drone: { enabled: true, gain: 0.14, octave: 1, waveform: 'triangle', cutoff: 400 },
      rhythm: { enabled: true, baseTempo: 0.4, layers: 4, voice: 'sub', baseFreq: 44, gain: 0.3, decay: 0.6 },
      fx: { drive: 0.1, cutoff: 5200, chorus: 0.5, delayTime: 0.66, delayFeedback: 0.44, delayMix: 0.24, reverbMix: 0.46, reverbSize: 7, width: 1.35 },
    },
  },
  {
    id: 'magnetar',
    name: 'Magnetar',
    blurb: 'Dark and heavy. Low span, strong tilt, saturated — the stack as a mass rather than a shimmer.',
    params: {
      transport: { secondsPerOctave: 20, direction: 1, swoop: 0.25, link: true },
      stack: { baseFreq: 18.35, octaves: 7, shape: 'hann', tilt: -5 },
      tone: { enabled: true, gain: 0.3, waveform: 'triangle', voicing: 'minorTriad', just: true, detune: 10, spread: 0.6 },
      drone: { enabled: true, gain: 0.26, octave: 0, waveform: 'sawtooth', cutoff: 160 },
      rhythm: { enabled: true, baseTempo: 0.6, layers: 5, voice: 'sub', baseFreq: 36, gain: 0.55, decay: 0.5, pitchTrack: 0.35 },
      pulse: { depth: 0.28 },
      fx: { drive: 0.5, cutoff: 2400, resonance: 1.2, chorus: 0.25, delayMix: 0.16, reverbMix: 0.3, reverbSize: 5, width: 1.1, output: 0.55 },
    },
  },
  {
    id: 'stairwell',
    name: 'Stairwell',
    blurb: 'Stepped rather than gliding: the Shepard *scale*. Walks a minor pentatonic upward forever.',
    params: {
      transport: { secondsPerOctave: 9, direction: 1, swoop: 0, stepDivisions: 0, scale: 'minorPent', glide: 0.035, link: true },
      stack: { baseFreq: 27.5, octaves: 8, tilt: -2 },
      tone: { enabled: true, gain: 0.26, waveform: 'glass', voicing: 'fifth', just: true, detune: 6, spread: 0.7 },
      drone: { enabled: true, gain: 0.16, octave: 1, cutoff: 300 },
      rhythm: { enabled: true, baseTempo: 1.0, layers: 5, voice: 'pulse', baseFreq: 66, gain: 0.35, decay: 0.22 },
      fx: { drive: 0.14, cutoff: 7000, chorus: 0.42, delayTime: 0.36, delayFeedback: 0.4, delayMix: 0.26, reverbMix: 0.34, reverbSize: 3.4, width: 1.25 },
    },
  },
  {
    id: 'descent',
    name: 'Descent',
    blurb: 'The same machine in reverse: falling forever, and never getting any lower.',
    params: {
      transport: { secondsPerOctave: 18, direction: -1, swoop: 0.2, link: true },
      stack: { baseFreq: 27.5, octaves: 8, shape: 'hann', tilt: -2.5 },
      tone: { enabled: true, gain: 0.3, waveform: 'organ', voicing: 'minorTriad', just: true, detune: 8, spread: 0.7 },
      drone: { enabled: true, gain: 0.18, octave: 1, cutoff: 260 },
      rhythm: { enabled: true, baseTempo: 0.9, layers: 5, voice: 'kick', baseFreq: 48, gain: 0.45, decay: 0.36 },
      pulse: { depth: 0.2 },
      fx: { drive: 0.2, cutoff: 4800, chorus: 0.4, delayMix: 0.2, reverbMix: 0.38, reverbSize: 5, width: 1.2 },
    },
  },
  {
    id: 'accretion',
    name: 'Accretion',
    blurb: 'Quartal and unresolved, with a heavy swoop. Built to sit under something else without ever settling.',
    params: {
      transport: { secondsPerOctave: 22, direction: 1, swoop: 0.6, link: false },
      stack: { baseFreq: 30.87, octaves: 8, shape: 'blackmanHarris', tilt: -2.8 },
      tone: { enabled: true, gain: 0.3, waveform: 'glass', voicing: 'quartal', just: true, detune: 11, spread: 0.9 },
      drone: { enabled: true, gain: 0.15, octave: 1, waveform: 'triangle', cutoff: 340 },
      rhythm: { enabled: true, baseTempo: 0.5, layers: 4, voice: 'noise', baseFreq: 120, gain: 0.25, decay: 0.45, pitchTrack: 0.6 },
      fx: { drive: 0.12, cutoff: 4200, chorus: 0.6, delayTime: 0.75, delayFeedback: 0.5, delayMix: 0.3, reverbMix: 0.44, reverbSize: 6.5, width: 1.45 },
    },
  },
  {
    id: 'sample-spiral',
    name: 'Sample Spiral',
    blurb: 'Starting point for your own audio: granular mode, so a loaded loop keeps its groove while its pitch spirals.',
    params: {
      transport: { secondsPerOctave: 20, direction: 1, swoop: 0, link: true },
      stack: { baseFreq: 27.5, octaves: 7, shape: 'hann', tilt: -1.5 },
      tone: { enabled: true, gain: 0.08, waveform: 'sine', voicing: 'unison', spread: 0.4 },
      sample: { enabled: true, gain: 0.62, mode: 'grain', grainMs: 90, pitchShift: 0, spread: 0.75 },
      drone: { enabled: true, gain: 0.12, octave: 1, cutoff: 260 },
      rhythm: { enabled: false },
      fx: { drive: 0.12, cutoff: 8000, chorus: 0.3, delayTime: 0.5, delayFeedback: 0.36, delayMix: 0.18, reverbMix: 0.3, reverbSize: 4, width: 1.25 },
    },
  },
];

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}
