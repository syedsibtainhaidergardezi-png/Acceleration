/**
 * risset-rhythm.js
 *
 * The rhythmic half of the illusion: a pulse that accelerates forever.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MATTERS FOR "ACCELERATION"
 * ---------------------------------------------------------------------------
 * A Shepard glissando alone reads as *rising*, not as *accelerating*. Pitch
 * has no speed. What sells acceleration to the body rather than the ear is
 * tempo -- a beat that keeps getting faster and never arrives. Run the two
 * together on a shared clock (one octave of pitch per doubling of tempo) and
 * the two illusions reinforce each other: the whole texture reads as a single
 * object winding up without limit. That is the neutron-star spin-up.
 *
 * ---------------------------------------------------------------------------
 * EXACT BEAT PLACEMENT
 * ---------------------------------------------------------------------------
 * Each layer's tempo is T(t) = T0 * 2^(t/D). The obvious implementation --
 * "wait 1/T seconds, then recompute T" -- is a first-order approximation of an
 * exponential, and it runs late by a factor that grows with the acceleration.
 * At a 4-second doubling it is audibly wrong within a couple of seconds, and
 * the layers drift out of phase alignment with each other, which is exactly
 * the coherence the illusion depends on.
 *
 * Instead we integrate tempo to get accumulated beat count and invert it in
 * closed form (see timeOfBeat in shepard-math.js). Every beat is placed at its
 * exact time, computed from absolute engine time, with no accumulated state to
 * drift. The scheduler below is therefore stateless: give it any time window
 * and it returns exactly the beats that fall inside it. That is what lets the
 * same code drive real-time playback and a deterministic offline render.
 */

import { wrap, windowAt, tiltAt, beatPhaseAt, timeOfBeat, tempoAt } from './shepard-math.js';

/**
 * Per-call cap on scheduled beats. This is a safety valve against a degenerate
 * request (a very fast tempo over a very long window) allocating unbounded
 * work; RissetRhythm.advance() chunks its requests so that normal use never
 * approaches it. Note that hitting the cap drops the remaining *layers*, not
 * just the remaining beats -- which is why staying clear of it matters.
 */
export const MAX_EVENTS_PER_CALL = 4096;

export const PERCUSSION_VOICES = {
  pulse:  { label: 'Pulse',    },
  kick:   { label: 'Kick',     },
  click:  { label: 'Click',    },
  metal:  { label: 'Metallic', },
  sub:    { label: 'Sub drop', },
  noise:  { label: 'Noise burst' },
};

export const PERCUSSION_NAMES = Object.keys(PERCUSSION_VOICES);

/**
 * Enumerate every beat in [fromTime, toTime).
 *
 * Stateless and exact: derives everything from absolute time, so calling it
 * with adjacent windows produces a seamless stream and calling it with one
 * huge window (offline render) produces the identical result.
 *
 * @param {object} cfg
 * @param {number} cfg.startTime  engine time at which the rhythm's phase is 0
 * @param {number} cfg.baseTempo  tempo at the bottom of the span, beats/sec
 * @param {number} cfg.doubling   seconds per tempo doubling (sign = direction)
 * @param {number} cfg.layers     number of octave-spaced layers
 * @param {string} cfg.shape      window shape (shared with the pitch stack)
 * @param {number} cfg.sigma      Gaussian width, if shape is 'gauss'
 * @param {number} cfg.tilt       dB per octave of tempo
 * @param {number} fromTime
 * @param {number} toTime
 * @param {number} [maxEvents]    safety cap
 * @returns {Array<{time:number, layer:number, position:number, gain:number,
 *                  tempo:number}>} sorted by time
 */
export function collectBeats(cfg, fromTime, toTime, maxEvents = MAX_EVENTS_PER_CALL) {
  const {
    startTime = 0,
    baseTempo = 1,
    doubling = 8,
    layers = 5,
    shape = 'hann',
    sigma = layers / 6,
    tilt = 0,
  } = cfg;

  const events = [];
  if (!(toTime > fromTime) || !(baseTempo > 0) || doubling === 0) return events;

  const D = doubling;
  const L = Math.max(2, Math.round(layers));
  for (let k = 0; k < L; k++) {
    // Position of layer k in tempo-octaves, unwrapped: u = k + (t - t0)/D.
    // A "segment" is one traversal of the span, from the bottom of the window
    // to the top; at each segment boundary the layer is silent (tapered
    // window), so restarting its beat count there is inaudible.
    const uFrom = k + (fromTime - startTime) / D;
    const uTo = k + (toTime - startTime) / D;
    const segFrom = Math.floor(Math.min(uFrom, uTo) / L);
    const segTo = Math.floor(Math.max(uFrom, uTo) / L);

    for (let seg = segFrom; seg <= segTo; seg++) {
      // `birth` is the moment this layer's position is at the bottom of the
      // span; `birth + D*L` is the moment it reaches the top. When D is
      // negative (decelerating) the layer traverses the span downward, so that
      // second time is *earlier* than birth -- hence min/max rather than
      // assuming an order.
      const birth = startTime + D * (seg * L - k);
      const other = birth + D * L;
      const lo = Math.max(fromTime, Math.min(birth, other));
      const hi = Math.min(toTime, Math.max(birth, other));
      if (!(hi > lo)) continue;

      // Beat index at the start of our window within this segment.
      const thetaLo = beatPhaseAt(lo - birth, baseTempo, D);
      let n = Math.floor(thetaLo) + 1;

      for (let guard = 0; guard < maxEvents; guard++) {
        const dt = timeOfBeat(n, baseTempo, D);
        if (!isFinite(dt)) break;
        const t = birth + dt;
        if (t >= hi) break;
        if (t >= lo) {
          const e = wrap(k + (t - startTime) / D, L);
          const gain = windowAt(e, L, shape, sigma) * tiltAt(e, L, tilt);
          if (gain > 1e-3) {
            events.push({
              time: t,
              layer: k,
              position: e,
              gain,
              tempo: tempoAt(t - birth, baseTempo, D),
            });
          }
        }
        n++;
        if (events.length >= maxEvents) break;
      }
    }
    if (events.length >= maxEvents) break;
  }

  events.sort((a, b) => a.time - b.time);
  return events;
}

/**
 * Synthesises one percussive hit into the graph at an exact time.
 *
 * Every hit is built from fresh nodes and scheduled with absolute times, which
 * is the only way to get sample-accurate placement in Web Audio -- and it is
 * what makes the offline render bit-identical to what was auditioned.
 *
 * Hits track the layer's position in the tempo window: faster layers are
 * higher and shorter, slower layers are lower and longer. That coupling is
 * what makes the rhythm read as one accelerating object rather than as several
 * unrelated pulse trains.
 */
export function scheduleHit(ctx, destination, event, opts) {
  const {
    voice = 'kick',
    baseFreq = 60,
    pitchTrack = 0.5,
    decay = 0.28,
    layers = 5,
    gain: masterGain = 0.5,
    tone = 0.5,
  } = opts;

  const { time, position, gain } = event;
  const centred = position - layers / 2;

  // Faster layers get shorter hits, or the stack turns to mud once the top
  // layer is firing 16 times a second.
  const tempoScale = Math.pow(2, -centred * 0.5);
  const dur = Math.max(0.012, Math.min(1.2, decay * tempoScale));
  const freq = baseFreq * Math.pow(2, centred * pitchTrack);

  const amp = ctx.createGain();
  amp.gain.value = 0;
  amp.connect(destination);

  const peak = Math.max(0.0001, gain * masterGain);
  const attack = Math.min(0.006, dur * 0.1);

  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(peak, time + attack);
  // Exponential decay to a floor, then a short linear run to true zero --
  // exponentialRampToValueAtTime cannot reach 0, and leaving it at the floor
  // leaves a DC step behind when the node is disconnected.
  amp.gain.exponentialRampToValueAtTime(peak * 0.0016, time + dur);
  amp.gain.linearRampToValueAtTime(0, time + dur + 0.005);

  const stopAt = time + dur + 0.02;
  const nodes = [];

  const makeOsc = (type, f0, f1, sweepTime) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, time);
    if (f1 && f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), time + sweepTime);
    }
    osc.start(time);
    osc.stop(stopAt);
    nodes.push(osc);
    return osc;
  };

  const makeNoise = () => {
    const len = Math.max(1, Math.ceil((dur + 0.02) * ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Seeded from the hit's position *within the tempo span*, not from absolute
    // time. Both give a deterministic render, but only this one repeats every
    // cycle: a layer passing through the same position one period later gets
    // the same noise. Seeding from absolute time made every cycle's noise
    // different, which silently broke the seamless loop for the click and
    // noise voices. Successive hits still differ, because their positions do.
    let seed = ((Math.round(position * 1e6) * 2654435761 + event.layer * 40503) >>> 0) % 2147483647 + 1;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 2147483648 - 1) * 0.7;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.start(time);
    src.stop(stopAt);
    nodes.push(src);
    return src;
  };

  switch (voice) {
    case 'kick': {
      // Pitch-drop sine: the classic. Sweep depth scales with the hit length
      // so fast layers click and slow layers boom.
      const osc = makeOsc('sine', freq * 4, freq, dur * 0.35);
      const shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve(0.3 + tone * 0.5);
      osc.connect(shaper).connect(amp);
      break;
    }
    case 'sub': {
      const osc = makeOsc('sine', freq * 1.6, freq * 0.5, dur * 0.6);
      osc.connect(amp);
      break;
    }
    case 'click': {
      const src = makeNoise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(ctx.sampleRate * 0.45, freq * 24);
      bp.Q.value = 1.2 + tone * 4;
      src.connect(bp).connect(amp);
      break;
    }
    case 'noise': {
      const src = makeNoise();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(Math.min(ctx.sampleRate * 0.4, freq * 8), time);
      hp.frequency.exponentialRampToValueAtTime(
        Math.max(60, Math.min(ctx.sampleRate * 0.4, freq * 2)),
        time + dur
      );
      src.connect(hp).connect(amp);
      break;
    }
    case 'metal': {
      // Inharmonic FM: a carrier rung by a non-integer-ratio modulator gives
      // the bell/anvil character without a sample.
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = freq * 6;
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * 6 * 1.4142; // sqrt(2): maximally inharmonic
      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(freq * 12 * (0.5 + tone), time);
      modGain.gain.exponentialRampToValueAtTime(freq * 0.5, time + dur);
      mod.connect(modGain).connect(carrier.frequency);
      carrier.start(time); carrier.stop(stopAt);
      mod.start(time); mod.stop(stopAt);
      nodes.push(carrier, mod);
      carrier.connect(amp);
      break;
    }
    case 'pulse':
    default: {
      // A soft sine blip -- the least intrusive way to feel the acceleration
      // under a dense pad.
      const osc = makeOsc('sine', freq * 2, freq * 2, 0);
      osc.connect(amp);
      break;
    }
  }

  // Release the graph once the hit has rung out. Without this, a long session
  // accumulates thousands of dead nodes and the audio thread slowly dies.
  const last = nodes[nodes.length - 1];
  if (last && typeof last.addEventListener === 'function') {
    last.onended = () => {
      try {
        amp.disconnect();
      } catch (_) {
        /* already torn down */
      }
    };
  }

  return { amp, nodes, endTime: stopAt };
}

/** Soft-saturation curve shared by the kick shaper and the FX drive stage. */
export function driveCurve(amount, samples = 1024) {
  const curve = new Float32Array(samples);
  const k = 1 + amount * 24;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/**
 * Real-time scheduler wrapper. Keeps a lookahead window filled with scheduled
 * hits, and can also pre-schedule an entire offline render in one call.
 */
export class RissetRhythm {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.startTime = 0;
    this.scheduledUpTo = 0;
    this.running = false;
    this.onBeat = null; // optional callback for the visualiser

    this.cfg = {
      enabled: true,
      baseTempo: 1.0,
      doubling: 8,
      layers: 5,
      shape: 'hann',
      sigma: 5 / 6,
      tilt: 0,
      voice: 'kick',
      baseFreq: 55,
      pitchTrack: 0.5,
      decay: 0.3,
      gain: 0.5,
      tone: 0.5,
    };
  }

  setConfig(patch) {
    Object.assign(this.cfg, patch);
    if (this.cfg.sigma === undefined) this.cfg.sigma = this.cfg.layers / 6;
  }

  start(when) {
    this.startTime = when;
    this.scheduledUpTo = when;
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  /**
   * Schedule everything up to `horizon` (absolute context time).
   *
   * Work is done in bounded chunks rather than one call, because collectBeats
   * has a per-call event cap and hitting it drops whole layers rather than
   * degrading gracefully. Real-time scheduling never comes close -- it asks for
   * 0.6 s at a time -- but an offline render pre-schedules the entire piece in
   * a single call, and a minute of a fast six-layer pattern is comfortably
   * thousands of beats. That silently truncated the percussion in long exports.
   *
   * The chunk size is derived from the fastest layer's tempo, so it adapts
   * instead of relying on a fixed guess.
   */
  advance(horizon) {
    if (!this.running || !this.cfg.enabled) {
      this.scheduledUpTo = Math.max(this.scheduledUpTo, horizon);
      return 0;
    }
    if (!(horizon > this.scheduledUpTo)) return 0;

    // Total beats per second across all layers: a geometric series in tempo,
    // summing to baseTempo * (2^layers - 1).
    const layers = Math.max(2, Math.round(this.cfg.layers));
    const eventsPerSecond = Math.max(1, this.cfg.baseTempo * (Math.pow(2, layers) - 1));
    // Aim for a quarter of the cap per chunk, so the cap stays a safety valve
    // rather than something we routinely brush against.
    const chunkSeconds = Math.max(0.25, (MAX_EVENTS_PER_CALL * 0.25) / eventsPerSecond);

    let total = 0;
    let guard = 0;
    while (this.scheduledUpTo < horizon && guard++ < 10000) {
      const from = this.scheduledUpTo;
      const to = Math.min(horizon, from + chunkSeconds);
      const events = collectBeats({ ...this.cfg, startTime: this.startTime }, from, to);
      for (const ev of events) {
        scheduleHit(this.ctx, this.destination, ev, this.cfg);
        if (this.onBeat) this.onBeat(ev);
      }
      total += events.length;
      this.scheduledUpTo = to;
    }
    return total;
  }
}
