/**
 * main.js
 *
 * Application shell: audio lifecycle, preset handling, sample ingestion,
 * export, and keyboard control.
 */

import { AccelerationEngine, DEFAULT_PARAMS, mergeParams } from './engine/acceleration-engine.js';
import { prepareSample, peakEnvelope, MAX_SAMPLE_SECONDS } from './engine/sample-prep.js';
import { PRESETS, getPreset } from './ui/presets.js';
import { buildControls } from './ui/controls.js';
import { Visualizer, drawWaveform } from './ui/visualizer.js';
import { renderOffline, encodeWav, downloadBlob, snapToCycles } from './export/wav.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  ctx: null,
  engine: null,
  viz: null,
  controls: null,
  params: mergeParams(DEFAULT_PARAMS, getPreset('neutron-star').params),
  prepared: null,     // prepared sample payload
  sampleName: null,
  sampleEnvelope: null,
  activePreset: 'neutron-star',
  exporting: false,
};

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

/* -------------------------------------------------------------------------- */
/* Audio lifecycle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The AudioContext is created on the first user gesture. Browsers block audio
 * until then, and a context created earlier starts suspended and silently
 * stays that way -- the single most common reason a Web Audio app "doesn't
 * work".
 */
async function ensureEngine() {
  if (state.engine) {
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    return state.engine;
  }

  // Fail loudly and specifically on file://. Both ES module imports and
  // AudioWorklet.addModule are blocked by that origin, so the page loads,
  // renders perfectly, and makes no sound -- with an error in the console the
  // user has no particular reason to open. Saying so up front costs nothing.
  if (window.location.protocol === 'file:') {
    setStatus(
      'this page must be served over http:// — run "npm start" and open http://localhost:8080 ' +
      '(opening the file directly blocks the audio engine)',
      'error'
    );
    throw new Error('file:// origin cannot load AudioWorklets');
  }

  setStatus('starting audio engine…');
  const ctx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: 'playback', // favour stability over latency: this is a pad, not a keyboard
  });
  state.ctx = ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  try {
    state.engine = await AccelerationEngine.create(ctx, state.params);
  } catch (err) {
    console.error(err);
    setStatus(
      'could not load the audio worklets — the page must be served over http(s), not opened as a file://',
      'error'
    );
    throw err;
  }

  state.engine.connect(ctx.destination);

  state.viz = new Visualizer({
    spectrumCanvas: $('#spectrum'),
    rhythmCanvas: $('#rhythmview'),
    engine: state.engine,
  });
  state.viz.start();

  if (state.prepared) state.engine.setSample(state.prepared);

  setStatus('ready');
  return state.engine;
}

async function play() {
  const engine = await ensureEngine();
  if (engine.running) return;
  engine.start(state.ctx.currentTime + 0.06);
  $('#play').classList.add('playing');
  $('#play').textContent = '■  Stop';
  setStatus('running');
}

function stop() {
  if (!state.engine || !state.engine.running) return;
  state.engine.stop();
  $('#play').classList.remove('playing');
  $('#play').textContent = '▶  Play';
  setStatus('stopped');
}

function toggle() {
  if (state.engine && state.engine.running) stop();
  else play();
}

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

function applyPatch(patch) {
  state.params = mergeParams(state.params, patch);
  if (state.engine) state.engine.setParams(patch);
  if (state.controls) state.controls.refresh();
  updateDerivedReadouts();
}

function loadPreset(id) {
  const preset = getPreset(id);
  state.activePreset = id;
  state.params = mergeParams(DEFAULT_PARAMS, preset.params);

  // A preset that turns sample mode on with nothing loaded would be silent and
  // confusing, so keep it off until there is something to play.
  if (!state.prepared) state.params.sample.enabled = false;

  if (state.engine) state.engine.setParams(state.params);
  if (state.controls) state.controls.refresh();

  document.querySelectorAll('.preset').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  $('#preset-blurb').textContent = preset.blurb;
  updateDerivedReadouts();
}

/** Surface the numbers that follow from the settings but are not settings. */
function updateDerivedReadouts() {
  const p = state.params;
  const period = Math.abs(p.transport.secondsPerOctave);
  const doubling = p.transport.link ? period : 8;

  $('#readout-period').textContent = `${period.toFixed(1)} s`;
  $('#readout-span').textContent =
    `${p.stack.baseFreq.toFixed(1)} Hz – ${(p.stack.baseFreq * Math.pow(2, p.stack.octaves) / 1000).toFixed(1)} kHz`;
  $('#readout-doubling').textContent = p.rhythm.enabled ? `${doubling.toFixed(1)} s` : '—';

  const approx = parseFloat($('#export-duration').value) || 60;
  const snapped = snapToCycles(approx, period);
  $('#export-actual').textContent =
    `${snapped.seconds.toFixed(1)} s — ${snapped.cycles} cycle${snapped.cycles === 1 ? '' : 's'}`;
}

/* -------------------------------------------------------------------------- */
/* Sample ingestion                                                            */
/* -------------------------------------------------------------------------- */

async function loadAudioFile(file) {
  if (!file) return;
  setStatus(`decoding ${file.name}…`);

  try {
    const arrayBuffer = await file.arrayBuffer();
    // A context is needed to decode; make sure one exists even if the user
    // dropped a file before pressing play.
    await ensureEngine();
    const audioBuffer = await state.ctx.decodeAudioData(arrayBuffer);

    if (audioBuffer.duration > MAX_SAMPLE_SECONDS) {
      setStatus(
        `${file.name} is ${audioBuffer.duration.toFixed(0)}s — using the first ${MAX_SAMPLE_SECONDS}s`,
        'warn'
      );
    }

    // Enough mips to cover upward transposition across half the span, which is
    // as far up as the centred mapping ever reads.
    const mipCount = Math.max(3, Math.ceil(state.params.stack.octaves / 2) + 1);
    const prepared = prepareSample(audioBuffer, { mipCount, autoLoop: true });

    state.prepared = prepared;
    state.sampleName = file.name;
    state.sampleEnvelope = peakEnvelope(prepared.mips[0]);

    state.engine.setSample(prepared);

    $('#sample-name').textContent = file.name;
    $('#sample-meta').textContent =
      `${prepared.duration.toFixed(2)}s · ${prepared.sourceRate} Hz · loop ${(prepared.loopStart / prepared.sourceRate).toFixed(2)}–${(prepared.loopEnd / prepared.sourceRate).toFixed(2)}s`;
    redrawWaveform();

    // Loading a sample is an unambiguous statement of intent, so switch the
    // sample layer on and duck the synth stack out of its way.
    applyPatch({ sample: { enabled: true }, tone: { gain: Math.min(state.params.tone.gain, 0.12) } });
    setStatus(`loaded ${file.name}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`could not decode ${file.name} — try WAV, MP3, FLAC or OGG`, 'error');
  }
}

function redrawWaveform() {
  drawWaveform(
    $('#waveform'),
    state.sampleEnvelope,
    state.prepared ? { start: state.prepared.loopStart, end: state.prepared.loopEnd } : null,
    state.prepared ? state.prepared.length : 0
  );
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

async function exportWav() {
  if (state.exporting) return;
  state.exporting = true;

  const btn = $('#export');
  btn.disabled = true;

  try {
    const approx = parseFloat($('#export-duration').value) || 60;
    const seamless = $('#export-seamless').checked;
    const bitDepth = parseInt($('#export-depth').value, 10);
    const sampleRate = parseInt($('#export-rate').value, 10);

    const period = Math.abs(state.params.transport.secondsPerOctave);
    const snapped = seamless ? snapToCycles(approx, period) : { seconds: approx, cycles: 0 };
    const duration = snapped.seconds;

    setStatus(`rendering ${duration.toFixed(1)}s…`);
    btn.textContent = 'Rendering…';

    const buffer = await renderOffline({
      params: state.params,
      duration,
      sampleRate,
      sample: state.params.sample.enabled ? state.prepared : null,
      seamless,
      onProgress: (p) => {
        btn.textContent = `Rendering ${Math.round(p * 100)}%`;
      },
    });

    const blob = encodeWav(buffer, { bitDepth });
    const base = state.sampleName
      ? `acceleration-${state.activePreset}-${state.sampleName.replace(/\.[^.]+$/, '')}`
      : `acceleration-${state.activePreset}`;
    const name = `${base}-${duration.toFixed(0)}s${seamless ? '-loop' : ''}.wav`;

    downloadBlob(blob, name);
    setStatus(
      seamless
        ? `exported ${name} — loops seamlessly (${snapped.cycles} cycles)`
        : `exported ${name}`,
      'ok'
    );
  } catch (err) {
    console.error(err);
    setStatus(`export failed: ${err.message}`, 'error');
  } finally {
    state.exporting = false;
    btn.disabled = false;
    btn.textContent = 'Export WAV';
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

function buildPresetBar() {
  const bar = $('#presets');
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.dataset.id = preset.id;
    btn.textContent = preset.name;
    btn.title = preset.blurb;
    btn.addEventListener('click', () => loadPreset(preset.id));
    bar.appendChild(btn);
  }
}

function setupDropZone() {
  const zone = $('#sample-zone');
  const input = $('#file-input');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) loadAudioFile(input.files[0]);
  });

  for (const ev of ['dragenter', 'dragover']) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('drag');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('drag');
    });
  }
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) loadAudioFile(file);
  });

  // Accept a drop anywhere on the page, not just on the small target.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('audio')) loadAudioFile(file);
  });
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea, button')) {
      if (e.code !== 'Space') return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'r' || e.key === 'R') {
      // Restart the illusion from phase 0 -- useful for A/B-ing a change from
      // an identical starting point.
      if (state.engine) {
        state.engine.stop();
        state.engine.start(state.ctx.currentTime + 0.05, { resetPhase: true });
        $('#play').classList.add('playing');
        $('#play').textContent = '■  Stop';
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      applyPatch({
        transport: {
          secondsPerOctave: Math.max(2, Math.min(60, state.params.transport.secondsPerOctave + delta)),
        },
      });
    }
  });
}

function init() {
  buildPresetBar();
  state.controls = buildControls($('#controls'), () => state.params, applyPatch);
  setupDropZone();
  setupKeyboard();
  redrawWaveform();

  $('#play').addEventListener('click', toggle);
  $('#export').addEventListener('click', exportWav);
  $('#export-duration').addEventListener('input', updateDerivedReadouts);
  $('#randomize').addEventListener('click', randomize);

  window.addEventListener('resize', () => {
    redrawWaveform();
  });

  loadPreset('neutron-star');
  setStatus('press play — audio starts on your first click');
}

/**
 * Randomise the musical choices while leaving the illusion's structure alone.
 * Randomising everything mostly produces noise; randomising chord, waveform,
 * voice and space produces something worth hearing almost every time.
 */
function randomize() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  applyPatch({
    transport: {
      secondsPerOctave: rand(8, 30),
      swoop: Math.random() < 0.5 ? 0 : rand(0.1, 0.6),
    },
    tone: {
      waveform: pick(['sine', 'triangle', 'organ', 'glass', 'saw']),
      voicing: pick(['fifth', 'majorTriad', 'minorTriad', 'sus2', 'sus4', 'minor7', 'major7', 'minor9', 'quartal']),
      detune: rand(0, 14),
    },
    stack: {
      tilt: rand(-4.5, -0.5),
      shape: pick(['hann', 'blackman', 'blackmanHarris']),
    },
    rhythm: {
      voice: pick(['kick', 'click', 'metal', 'sub', 'pulse']),
      baseTempo: rand(0.4, 1.6),
      pitchTrack: rand(0.2, 0.8),
    },
    fx: {
      cutoff: rand(2500, 10000),
      chorus: rand(0.2, 0.7),
      reverbMix: rand(0.2, 0.5),
      delayMix: rand(0.1, 0.35),
    },
  });
  setStatus('randomised — musical parameters only', 'ok');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
