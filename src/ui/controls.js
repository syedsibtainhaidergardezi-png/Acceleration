/**
 * controls.js
 *
 * The control surface is generated from a declarative spec rather than written
 * out in HTML. There are ~45 parameters; hand-writing markup and wiring for
 * each is where this kind of tool normally rots, because every new parameter
 * means touching three files. Here a new control is one line in CONTROL_SPEC.
 */

import { CHORDS, SCALES } from '../engine/voicing.js';
import { WINDOW_NAMES } from '../engine/shepard-math.js';
import { PERCUSSION_VOICES } from '../engine/risset-rhythm.js';

const chordOptions = Object.entries(CHORDS).map(([k, v]) => [k, v.label]);
const scaleOptions = [['', 'Off (even steps)']].concat(
  Object.entries(SCALES).map(([k, v]) => [k, v.label])
);
const percussionOptions = Object.entries(PERCUSSION_VOICES).map(([k, v]) => [k, v.label]);
const windowOptions = WINDOW_NAMES.map((k) => [k, k === 'blackmanHarris' ? 'Blackman-Harris' : k[0].toUpperCase() + k.slice(1)]);

export const CONTROL_SPEC = [
  {
    id: 'transport',
    title: 'Motion',
    hint: 'How fast the spiral turns, and whether it glides or steps.',
    controls: [
      { path: 'transport.secondsPerOctave', label: 'Octave time', type: 'range', min: 2, max: 60, step: 0.5, unit: 's', log: true,
        hint: 'Seconds for one full turn of the illusion. Also the exact loop length of a seamless export.' },
      { path: 'transport.direction', label: 'Direction', type: 'select', options: [[1, 'Rising ↑'], [-1, 'Falling ↓']], numeric: true },
      { path: 'transport.swoop', label: 'Swoop', type: 'range', min: -0.9, max: 0.9, step: 0.01,
        hint: 'Shapes the rate within each octave so the rise feels like acceleration rather than a constant climb. Average speed is unchanged.' },
      { path: 'transport.scale', label: 'Step scale', type: 'select', options: scaleOptions, nullable: true,
        hint: 'Off = continuous glissando. Anything else walks that scale upward forever.' },
      { path: 'transport.stepDivisions', label: 'Even steps', type: 'range', min: 0, max: 24, step: 1, unit: '/oct',
        hint: 'Uniform steps per octave, when no scale is chosen. 0 = continuous.' },
      { path: 'transport.glide', label: 'Glide', type: 'range', min: 0, max: 0.4, step: 0.005, unit: 's' },
      { path: 'transport.link', label: 'Link rhythm to pitch', type: 'toggle',
        hint: 'One octave of pitch per doubling of tempo. Locks the two illusions into a single period.' },
    ],
  },
  {
    id: 'stack',
    title: 'Stack',
    hint: 'The spectral window the partials slide through. This is the illusion itself.',
    controls: [
      { path: 'stack.baseFreq', label: 'Span bottom', type: 'range', min: 15, max: 110, step: 0.5, unit: 'Hz', log: true },
      { path: 'stack.octaves', label: 'Span width', type: 'range', min: 3, max: 10, step: 1, unit: ' oct' },
      { path: 'stack.shape', label: 'Window', type: 'select', options: windowOptions,
        hint: 'Hann and Blackman reach exactly zero at the edges, so the octave wrap is silent. Gauss does not — you can hear the seam.' },
      { path: 'stack.sigma', label: 'Gauss width', type: 'range', min: 0.4, max: 4, step: 0.05, unit: ' oct', showIf: (p) => p.stack.shape === 'gauss' },
      { path: 'stack.tilt', label: 'Tilt', type: 'range', min: -8, max: 4, step: 0.1, unit: ' dB/oct',
        hint: 'Negative darkens the top of the stack. The main tool for making a dense stack sit still in a mix.' },
      { path: 'stack.levelLock', label: 'Level lock', type: 'toggle',
        hint: 'Normalise the stack to constant RMS, so tilt cannot introduce loudness pumping as it slides.' },
    ],
  },
  {
    id: 'tone',
    title: 'Tone',
    hint: 'The synthesised voice and its chord.',
    controls: [
      { path: 'tone.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'tone.gain', label: 'Level', type: 'range', min: 0, max: 0.6, step: 0.005 },
      { path: 'tone.waveform', label: 'Waveform', type: 'select',
        options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['saw', 'Saw'], ['square', 'Square'], ['organ', 'Organ'], ['glass', 'Glass']] },
      { path: 'tone.voicing', label: 'Chord', type: 'select', options: chordOptions,
        hint: 'Each chord voice is the same stack read at a phase offset, so the chord can never drift out of tune.' },
      { path: 'tone.just', label: 'Just intonation', type: 'toggle',
        hint: 'Pure ratios instead of equal temperament. On an endlessly sustained chord, tempered thirds beat and never resolve.' },
      { path: 'tone.rootShift', label: 'Transpose', type: 'range', min: -12, max: 12, step: 1, unit: ' st' },
      { path: 'tone.detune', label: 'Detune', type: 'range', min: 0, max: 30, step: 0.5, unit: ' ¢' },
      { path: 'tone.spread', label: 'Stereo spread', type: 'range', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'sample',
    title: 'Sample',
    hint: 'Turn a loaded sound into the stack. Load a file below first.',
    controls: [
      { path: 'sample.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'sample.gain', label: 'Level', type: 'range', min: 0, max: 1.2, step: 0.01 },
      { path: 'sample.mode', label: 'Mode', type: 'select',
        options: [['grain', 'Granular (keeps tempo)'], ['rate', 'Varispeed (tape)']],
        hint: 'Granular holds every layer to the same groove while spanning octaves — use it for anything rhythmic. Varispeed is richer on sustained material.' },
      { path: 'sample.grainMs', label: 'Grain', type: 'range', min: 20, max: 240, step: 1, unit: ' ms', showIf: (p) => p.sample.mode === 'grain',
        hint: 'Short grains track transients; long grains sound smoother and more tonal.' },
      { path: 'sample.pitchShift', label: 'Pitch', type: 'range', min: -24, max: 24, step: 1, unit: ' st' },
      { path: 'sample.spread', label: 'Stereo spread', type: 'range', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'drone',
    title: 'Anchor drone',
    hint: 'A fixed pedal tone. The rise needs something stationary to be measured against.',
    controls: [
      { path: 'drone.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'drone.gain', label: 'Level', type: 'range', min: 0, max: 0.5, step: 0.005 },
      { path: 'drone.octave', label: 'Octave', type: 'range', min: 0, max: 3, step: 1 },
      { path: 'drone.waveform', label: 'Waveform', type: 'select',
        options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['sawtooth', 'Saw'], ['square', 'Square']] },
      { path: 'drone.cutoff', label: 'Tone', type: 'range', min: 80, max: 2000, step: 10, unit: ' Hz', log: true },
      { path: 'drone.detune', label: 'Detune', type: 'range', min: 0, max: 25, step: 0.5, unit: ' ¢' },
    ],
  },
  {
    id: 'rhythm',
    title: 'Acceleration',
    hint: 'The Risset rhythm: a pulse that speeds up forever.',
    controls: [
      { path: 'rhythm.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'rhythm.gain', label: 'Level', type: 'range', min: 0, max: 1, step: 0.01 },
      { path: 'rhythm.baseTempo', label: 'Base tempo', type: 'range', min: 0.15, max: 4, step: 0.05, unit: ' /s', log: true,
        hint: 'Tempo at the bottom of the span, in beats per second.' },
      { path: 'rhythm.layers', label: 'Layers', type: 'range', min: 3, max: 7, step: 1 },
      { path: 'rhythm.voice', label: 'Voice', type: 'select', options: percussionOptions },
      { path: 'rhythm.baseFreq', label: 'Pitch', type: 'range', min: 25, max: 220, step: 1, unit: ' Hz', log: true },
      { path: 'rhythm.pitchTrack', label: 'Pitch tracking', type: 'range', min: 0, max: 1, step: 0.01,
        hint: 'How much a layer\'s pitch follows its tempo. Coupling them is what makes the beat read as one accelerating object.' },
      { path: 'rhythm.decay', label: 'Decay', type: 'range', min: 0.05, max: 1, step: 0.01, unit: ' s' },
      { path: 'rhythm.tone', label: 'Character', type: 'range', min: 0, max: 1, step: 0.01 },
      { path: 'pulse.depth', label: 'Pulse depth', type: 'range', min: 0, max: 0.9, step: 0.01,
        hint: 'How much the beat ducks the tonal stack. A little makes the whole texture breathe with the acceleration.' },
    ],
  },
  {
    id: 'fx',
    title: 'Space',
    hint: 'Saturation, filtering and the tail that hides the seam.',
    controls: [
      { path: 'fx.drive', label: 'Drive', type: 'range', min: 0, max: 1, step: 0.01 },
      { path: 'fx.cutoff', label: 'Lowpass', type: 'range', min: 200, max: 18000, step: 50, unit: ' Hz', log: true },
      { path: 'fx.resonance', label: 'Resonance', type: 'range', min: 0.1, max: 8, step: 0.1 },
      { path: 'fx.highpass', label: 'Highpass', type: 'range', min: 15, max: 400, step: 1, unit: ' Hz', log: true },
      { path: 'fx.chorus', label: 'Chorus', type: 'range', min: 0, max: 1, step: 0.01 },
      { path: 'fx.delayTime', label: 'Delay time', type: 'range', min: 0.05, max: 1.5, step: 0.01, unit: ' s' },
      { path: 'fx.delayFeedback', label: 'Delay feedback', type: 'range', min: 0, max: 0.9, step: 0.01 },
      { path: 'fx.delayMix', label: 'Delay mix', type: 'range', min: 0, max: 0.8, step: 0.01 },
      { path: 'fx.reverbSize', label: 'Reverb size', type: 'range', min: 0.3, max: 10, step: 0.1, unit: ' s' },
      { path: 'fx.reverbMix', label: 'Reverb mix', type: 'range', min: 0, max: 0.9, step: 0.01 },
      { path: 'fx.width', label: 'Width', type: 'range', min: 0, max: 2, step: 0.01 },
      { path: 'fx.output', label: 'Output', type: 'range', min: 0, max: 1.2, step: 0.01 },
    ],
  },
];

/* -------------------------------------------------------------------------- */

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const patch = {};
  let node = patch;
  for (let i = 0; i < keys.length - 1; i++) {
    node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return patch;
}

/**
 * Logarithmic slider mapping. Frequencies and times are perceived
 * logarithmically, so a linear slider spends most of its travel in a range
 * nobody wants. `log: true` on a control fixes that.
 */
function toSlider(value, c) {
  if (!c.log) return value;
  const lo = Math.log(c.min);
  const hi = Math.log(c.max);
  return ((Math.log(Math.max(value, c.min)) - lo) / (hi - lo)) * 1000;
}

function fromSlider(pos, c) {
  if (!c.log) return parseFloat(pos);
  const lo = Math.log(c.min);
  const hi = Math.log(c.max);
  return Math.exp(lo + (pos / 1000) * (hi - lo));
}

function formatValue(value, c) {
  if (c.type === 'toggle') return value ? 'on' : 'off';
  if (c.type === 'select') {
    const opt = c.options.find(([k]) => String(k) === String(value ?? ''));
    return opt ? opt[1] : String(value);
  }
  if (typeof value !== 'number') return String(value);
  const abs = Math.abs(value);
  const decimals = c.step >= 1 ? 0 : abs >= 100 ? 0 : abs >= 10 ? 1 : c.step >= 0.05 ? 2 : 3;
  return value.toFixed(decimals) + (c.unit || '');
}

/**
 * Build the control surface.
 *
 * @param {HTMLElement} root
 * @param {() => object} getParams
 * @param {(patch: object) => void} onChange
 * @returns {{refresh: () => void}}
 */
export function buildControls(root, getParams, onChange) {
  root.innerHTML = '';
  const refreshers = [];

  for (const group of CONTROL_SPEC) {
    const section = document.createElement('section');
    section.className = 'panel';
    section.dataset.group = group.id;

    const header = document.createElement('div');
    header.className = 'panel-head';
    const h = document.createElement('h2');
    h.textContent = group.title;
    header.appendChild(h);
    if (group.hint) {
      const hint = document.createElement('p');
      hint.className = 'panel-hint';
      hint.textContent = group.hint;
      header.appendChild(hint);
    }
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    section.appendChild(body);

    for (const c of group.controls) {
      const row = document.createElement('div');
      row.className = `ctl ctl-${c.type}`;
      if (c.hint) row.title = c.hint;

      const label = document.createElement('label');
      label.className = 'ctl-label';
      label.textContent = c.label;
      const readout = document.createElement('span');
      readout.className = 'ctl-value';
      label.appendChild(readout);
      row.appendChild(label);

      let input;
      if (c.type === 'range') {
        input = document.createElement('input');
        input.type = 'range';
        if (c.log) {
          input.min = 0; input.max = 1000; input.step = 1;
        } else {
          input.min = c.min; input.max = c.max; input.step = c.step;
        }
        input.addEventListener('input', () => {
          let v = fromSlider(input.value, c);
          if (!c.log && c.step >= 1) v = Math.round(v);
          onChange(setPath({}, c.path, v));
          readout.textContent = formatValue(v, c);
        });
      } else if (c.type === 'select') {
        input = document.createElement('select');
        for (const [value, text] of c.options) {
          const opt = document.createElement('option');
          opt.value = String(value);
          opt.textContent = text;
          input.appendChild(opt);
        }
        input.addEventListener('change', () => {
          let v = input.value;
          if (c.numeric) v = parseFloat(v);
          if (c.nullable && v === '') v = null;
          onChange(setPath({}, c.path, v));
        });
      } else if (c.type === 'toggle') {
        input = document.createElement('button');
        input.type = 'button';
        input.className = 'toggle';
        input.addEventListener('click', () => {
          const next = !getPath(getParams(), c.path);
          onChange(setPath({}, c.path, next));
        });
      }

      input.className += ' ctl-input';
      row.appendChild(input);
      body.appendChild(row);

      refreshers.push(() => {
        const params = getParams();
        const value = getPath(params, c.path);

        if (c.showIf) row.style.display = c.showIf(params) ? '' : 'none';

        if (c.type === 'range') {
          const sliderPos = toSlider(value, c);
          if (document.activeElement !== input) input.value = sliderPos;
          readout.textContent = formatValue(value, c);
        } else if (c.type === 'select') {
          input.value = value === null || value === undefined ? '' : String(value);
          readout.textContent = '';
        } else if (c.type === 'toggle') {
          input.textContent = value ? 'ON' : 'OFF';
          input.classList.toggle('on', !!value);
          readout.textContent = '';
        }
      });
    }

    root.appendChild(section);
  }

  const refresh = () => refreshers.forEach((fn) => fn());
  refresh();
  return { refresh };
}
