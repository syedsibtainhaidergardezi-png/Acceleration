/**
 * acceleration-engine.js
 *
 * Top-level instrument. Owns the audio graph, the parameter state, and the
 * transport that keeps the pitch illusion and the rhythm illusion on one clock.
 *
 * Graph:
 *
 *   shepard-osc (worklet) ----+
 *   shepard-sampler (worklet)-+--> toneBus --> FXChain --> destination
 *   drone (oscillators) ------+                  ^
 *   RissetRhythm (scheduled) --------------------+
 *
 * The same engine class drives both real-time playback and offline rendering;
 * the only difference is who pumps the rhythm scheduler. That is deliberate --
 * an export that does not match what you auditioned is worse than no export.
 */

import { FXChain } from './fx.js';
import { RissetRhythm } from './risset-rhythm.js';
import { resolveVoicing, buildScaleTable } from './voicing.js';
import { ratePerSecond } from './shepard-math.js';

const OSC_WORKLET_URL = new URL('../worklets/shepard-osc-processor.js', import.meta.url);
const SAMPLER_WORKLET_URL = new URL('../worklets/shepard-sampler-processor.js', import.meta.url);

/** Seconds of rhythm scheduled ahead of the playhead in real time. */
const LOOKAHEAD = 0.6;
const SCHEDULE_INTERVAL_MS = 120;

export const DEFAULT_PARAMS = {
  transport: {
    secondsPerOctave: 14,   // time for the illusion to complete one cycle
    direction: 1,           // 1 = rising forever, -1 = falling forever
    swoop: 0,               // rate shaping: acceleration within each octave
    stepDivisions: 0,       // 0 = continuous glissando, else steps per octave
    scale: null,            // scale name for musical stepping, or null
    glide: 0.0,             // portamento between steps, seconds
    link: true,             // rhythm doubling time follows secondsPerOctave
  },
  stack: {
    baseFreq: 27.5,         // bottom of the span (A0)
    octaves: 8,
    shape: 'hann',
    sigma: 8 / 6,
    tilt: -1.5,
    levelLock: true,
  },
  tone: {
    enabled: true,
    gain: 0.28,
    waveform: 'organ',
    voicing: 'minor9',
    just: true,
    detune: 6,
    rootShift: 0,
    spread: 0.65,
  },
  sample: {
    enabled: false,
    gain: 0.5,
    mode: 'grain',          // 'grain' preserves tempo, 'rate' is varispeed
    grainMs: 80,
    pitchShift: 0,
    spread: 0.6,
  },
  drone: {
    enabled: true,
    gain: 0.16,
    octave: 1,              // octaves above stack base
    waveform: 'sawtooth',
    detune: 7,
    cutoff: 320,
  },
  rhythm: {
    enabled: true,
    baseTempo: 0.9,
    layers: 5,
    voice: 'kick',
    baseFreq: 55,
    pitchTrack: 0.5,
    decay: 0.3,
    gain: 0.45,
    tone: 0.5,
    shape: 'hann',
    tilt: 0,
  },
  pulse: {
    depth: 0,               // rhythm ducks the tonal bus
  },
  fx: {
    drive: 0.15,
    cutoff: 6500,
    resonance: 0.8,
    highpass: 26,
    chorus: 0.35,
    delayTime: 0.42,
    delayFeedback: 0.34,
    delayMix: 0.18,
    reverbMix: 0.3,
    reverbSize: 3.5,
    width: 1.15,
    output: 0.6,
  },
};

/** Recursive merge that never mutates the incoming patch. */
export function mergeParams(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch) return out;
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) {
      out[key] = mergeParams(base[key] || {}, v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

export function clonePresetParams(params) {
  return mergeParams(DEFAULT_PARAMS, params);
}

export class AccelerationEngine {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} [params]
   */
  static async create(ctx, params = {}) {
    // Both worklets must load before any node is constructed. If addModule
    // fails we surface it loudly rather than producing a silent instrument.
    await Promise.all([
      ctx.audioWorklet.addModule(OSC_WORKLET_URL),
      ctx.audioWorklet.addModule(SAMPLER_WORKLET_URL),
    ]);
    return new AccelerationEngine(ctx, params);
  }

  constructor(ctx, params = {}) {
    this.ctx = ctx;
    this.params = mergeParams(DEFAULT_PARAMS, params);
    this.isOffline = typeof ctx.startRendering === 'function' && !ctx.resume;
    this.running = false;
    this.phase = 0;
    this.sampleInfo = null;
    this.onPhase = null;
    this.onBeat = null;

    // --- buses ------------------------------------------------------------
    this.fx = new FXChain(ctx);
    this.toneBus = ctx.createGain();   // pitched material, duckable by pulse
    this.rhythmBus = ctx.createGain(); // percussion, never ducked
    this.toneBus.connect(this.fx.input);
    this.rhythmBus.connect(this.fx.input);

    // --- worklet nodes ----------------------------------------------------
    this.oscNode = new AudioWorkletNode(ctx, 'shepard-osc', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.oscGain = ctx.createGain();
    this.oscNode.connect(this.oscGain).connect(this.toneBus);
    this.oscNode.port.onmessage = (e) => {
      if (e.data && e.data.type === 'phase') {
        this.phase = e.data.phase;
        if (this.onPhase) this.onPhase(e.data.phase, e.data.smooth);
      }
    };

    this.samplerNode = new AudioWorkletNode(ctx, 'shepard-sampler', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.samplerGain = ctx.createGain();
    this.samplerGain.gain.value = 0;
    this.samplerNode.connect(this.samplerGain).connect(this.toneBus);
    this.samplerNode.port.onmessage = (e) => {
      if (e.data && e.data.type === 'sampleReady') {
        this.sampleReady = true;
      }
    };

    // --- drone ------------------------------------------------------------
    // A fixed pedal tone. This is the single cheapest thing that turns a
    // Shepard glissando from "siren" into "music": the ear needs something
    // stationary to measure the rise against. Without it there is no
    // reference, and the illusion has nothing to be an illusion *relative to*.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 320;
    this.droneFilter.Q.value = 0.9;
    this.droneOscs = [];
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = (i - 1) * 7;
      osc.connect(this.droneFilter);
      this.droneOscs.push(osc);
    }
    this.droneFilter.connect(this.droneGain).connect(this.toneBus);

    // --- rhythm -----------------------------------------------------------
    this.rhythm = new RissetRhythm(ctx, this.rhythmBus);
    this.rhythm.onBeat = (ev) => {
      this.applyPulse(ev);
      if (this.onBeat) this.onBeat(ev);
    };

    this.schedulerTimer = null;
    this.applyAll();
  }

  connect(destination) {
    this.fx.connect(destination);
    return this;
  }

  get analyser() {
    return this.fx.analyser;
  }

  /* ---------------------------------------------------------------------- */
  /* Parameters                                                              */
  /* ---------------------------------------------------------------------- */

  setParams(patch) {
    this.params = mergeParams(this.params, patch);
    this.applyAll(patch);
    return this.params;
  }

  /** Shared stack/transport values, sent to both worklets so they stay locked. */
  buildStackMessage(target) {
    const { transport, stack } = this.params;
    const src = this.params[target];
    const voicing = resolveVoicing(this.params.tone.voicing, {
      just: this.params.tone.just,
      detune: this.params.tone.detune,
      rootShift: this.params.tone.rootShift,
    });

    return {
      rate: ratePerSecond(transport.secondsPerOctave, transport.direction),
      swoop: transport.swoop,
      octaves: stack.octaves,
      baseFreq: stack.baseFreq,
      shape: stack.shape,
      sigma: stack.sigma,
      tilt: stack.tilt,
      levelLock: stack.levelLock,
      stepDivisions: transport.stepDivisions,
      scaleTable: transport.scale ? buildScaleTable(transport.scale) : null,
      glide: transport.glide,
      spread: src.spread,
      voiceOffsets: voicing.offsets,
      voiceGains: voicing.gains,
    };
  }

  applyAll() {
    const p = this.params;
    const t = this.ctx.currentTime;
    const ramp = (param, value, time = 0.04) => {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, Math.max(time, 0.005) / 3);
    };

    // --- oscillator stack --------------------------------------------------
    this.oscNode.port.postMessage({
      type: 'params',
      params: {
        ...this.buildStackMessage('tone'),
        waveform: p.tone.waveform,
        gain: 1,
      },
    });
    ramp(this.oscGain.gain, p.tone.enabled ? p.tone.gain : 0);

    // --- sampler stack -----------------------------------------------------
    this.samplerNode.port.postMessage({
      type: 'params',
      params: {
        ...this.buildStackMessage('sample'),
        mode: p.sample.mode,
        grainMs: p.sample.grainMs,
        pitchShift: p.sample.pitchShift,
        gain: 1,
      },
    });
    ramp(this.samplerGain.gain, p.sample.enabled && this.sampleInfo ? p.sample.gain : 0);

    // --- drone -------------------------------------------------------------
    const droneFreq = p.stack.baseFreq * Math.pow(2, p.drone.octave);
    for (let i = 0; i < this.droneOscs.length; i++) {
      const osc = this.droneOscs[i];
      osc.type = p.drone.waveform;
      ramp(osc.frequency, droneFreq, 0.08);
      osc.detune.value = (i - 1) * p.drone.detune + p.tone.rootShift * 100;
    }
    ramp(this.droneFilter.frequency, p.drone.cutoff, 0.08);
    ramp(this.droneGain.gain, p.drone.enabled && this.running ? p.drone.gain : 0);

    // --- rhythm ------------------------------------------------------------
    // When `link` is on, one octave of pitch takes exactly as long as one
    // doubling of tempo. The two illusions then share a period, and every
    // cycle of the pitch spiral lines up with a full turn of the rhythm
    // spiral -- which is what makes the whole thing feel like one machine
    // winding up rather than two effects running side by side.
    const doubling =
      p.transport.link
        ? p.transport.secondsPerOctave * (p.transport.direction >= 0 ? 1 : -1)
        : p.rhythm.doubling || 8;
    this.rhythm.setConfig({
      ...p.rhythm,
      doubling,
      sigma: p.rhythm.layers / 6,
    });

    // --- fx ----------------------------------------------------------------
    this.fx.set(p.fx);
    if (this._reverbSize !== p.fx.reverbSize) {
      this._reverbSize = p.fx.reverbSize;
      this.fx.setReverbSize(p.fx.reverbSize);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Sample loading                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Hand a prepared sample (see sample-prep.js) to the sampler worklet.
   * Buffers are transferred, not copied, so a long source does not double
   * peak memory during the handover.
   */
  setSample(prepared) {
    this.sampleInfo = prepared;
    const transfer = prepared.mips.map((m) => {
      const copy = new Float32Array(m); // keep the caller's copy intact
      return copy.buffer;
    });
    this.samplerNode.port.postMessage(
      {
        type: 'sample',
        mips: transfer,
        length: prepared.length,
        sourceRate: prepared.sourceRate,
        loopStart: prepared.loopStart,
        loopEnd: prepared.loopEnd,
      },
      transfer
    );
    this.applyAll();
  }

  setLoop(loopStart, loopEnd) {
    if (!this.sampleInfo) return;
    this.sampleInfo.loopStart = loopStart;
    this.sampleInfo.loopEnd = loopEnd;
    this.samplerNode.port.postMessage({ type: 'loop', loopStart, loopEnd });
  }

  /* ---------------------------------------------------------------------- */
  /* Pulse (rhythm ducking the tonal bus)                                    */
  /* ---------------------------------------------------------------------- */

  applyPulse(ev) {
    const depth = this.params.pulse.depth;
    if (!depth || ev.gain < 0.45) return;
    // Only the layer nearest the centre of the tempo window drives the duck;
    // ducking on every layer at once would just lower the average level.
    const g = this.toneBus.gain;
    const t = ev.time;
    const amount = 1 - depth * ev.gain;
    const attack = 0.008;
    const release = Math.min(0.35, 0.5 / Math.max(ev.tempo, 0.5));
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(amount, t + attack);
    g.linearRampToValueAtTime(1, t + attack + release);
  }

  /* ---------------------------------------------------------------------- */
  /* Transport                                                               */
  /* ---------------------------------------------------------------------- */

  start(when = this.ctx.currentTime + 0.05, { resetPhase = false } = {}) {
    if (this.running) return;
    this.running = true;

    for (const osc of this.droneOscs) {
      if (!osc._started) {
        osc.start(when);
        osc._started = true;
      }
    }

    // Explicitly align both worklets' phase accumulators at start. They
    // integrate independently and identically thereafter, but they may have
    // been constructed a block apart.
    const msg = { type: 'transport', running: true, resetPhase };
    this.oscNode.port.postMessage(msg);
    this.samplerNode.port.postMessage(msg);
    if (resetPhase) {
      this.oscNode.port.postMessage({ type: 'setPhase', phase: 0 });
      this.samplerNode.port.postMessage({ type: 'setPhase', phase: 0 });
    }

    this.rhythm.start(when);
    this.applyAll();

    if (!this.isOffline) this.startScheduler();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    const msg = { type: 'transport', running: false };
    this.oscNode.port.postMessage(msg);
    this.samplerNode.port.postMessage(msg);
    this.rhythm.stop();
    this.stopScheduler();

    const t = this.ctx.currentTime;
    this.droneGain.gain.cancelScheduledValues(t);
    this.droneGain.gain.setTargetAtTime(0, t, 0.08);
  }

  startScheduler() {
    this.stopScheduler();
    const tick = () => {
      this.rhythm.advance(this.ctx.currentTime + LOOKAHEAD);
    };
    tick();
    this.schedulerTimer = setInterval(tick, SCHEDULE_INTERVAL_MS);
  }

  stopScheduler() {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /** Pre-schedule the entire rhythm for an offline render. */
  prescheduleRhythm(duration) {
    this.rhythm.advance(duration);
  }

  dispose() {
    this.stop();
    try {
      for (const osc of this.droneOscs) osc.stop();
    } catch (_) {
      /* never started */
    }
    this.fx.dispose();
    try {
      this.oscNode.disconnect();
      this.samplerNode.disconnect();
    } catch (_) {
      /* already gone */
    }
  }
}
