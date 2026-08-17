/**
 * fx.js
 *
 * The post-synthesis signal path. Nothing exotic, but a few of these stages
 * exist specifically to solve problems the Shepard stack creates.
 *
 * Signal flow:
 *
 *   input -> drive -> filter -> chorus -+-> dry ------------+
 *                                       +-> delay (ping-pong) -+-> width -> out
 *                                       +-> reverb -----------+
 *
 * WHY EACH STAGE
 *
 *  drive    A stack of 8 partials x 4 chord voices is arithmetically dense but
 *           dynamically flat -- it has no transients at all. Gentle saturation
 *           adds intermodulation products that give the ear something to bite
 *           on, and glues the layers into one object.
 *
 *  filter   The single most important control for making this listenable. The
 *           stack necessarily has energy across the whole spectrum; without a
 *           movable ceiling it is relentlessly bright.
 *
 *  chorus   Decorrelates the layers. The stack's partials are exact octaves,
 *           so they phase-lock into something that can sound synthetic and
 *           static; slow independent modulation breaks that up.
 *
 *  reverb   Blurs the octave wrap. Even with a Hann window the wrap is
 *           mathematically seamless but *perceptually* detectable if you know
 *           what to listen for; a tail longer than the wrap period hides it
 *           completely.
 *
 *  limiter  The stack's level is constant by construction, but drive, delay
 *           feedback and reverb are not. This is a safety net, not a sound.
 */

import { driveCurve } from './risset-rhythm.js';

/**
 * Generate a stereo impulse response procedurally -- no asset to ship, no
 * fetch to fail, and it works identically in an OfflineAudioContext.
 *
 * Built as exponentially-decaying noise with a frequency-dependent decay
 * rate (highs die faster than lows, as they do in any real space) and a
 * short pre-delay. The two channels use independent noise so the tail is
 * fully decorrelated, which is what makes it sound wide rather than like a
 * mono reverb panned centre.
 */
export function createImpulseResponse(ctx, { seconds = 3.5, decay = 2.2, damping = 0.55 } = {}) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const impulse = ctx.createBuffer(2, len, rate);

  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    // Deterministic PRNG per channel: presets and offline renders must be
    // reproducible, and Math.random() would make every reload sound different.
    let seed = c === 0 ? 22222 : 99991;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2147483648 - 1;
    };

    // One-pole lowpass state, for the damping of the tail over time.
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      // Damping increases with time: the tail gets progressively darker.
      const coeff = 1 - damping * t;
      lp += (rnd() - lp) * Math.max(0.02, coeff);
      data[i] = lp * env;
    }

    // Short fade-in so the IR does not start with a hard click, and a fade-out
    // so it ends in true silence.
    const fadeIn = Math.min(len, Math.floor(rate * 0.004));
    for (let i = 0; i < fadeIn; i++) data[i] *= i / fadeIn;
    const fadeOut = Math.min(len, Math.floor(rate * 0.05));
    for (let i = 0; i < fadeOut; i++) data[len - 1 - i] *= i / fadeOut;
  }

  return impulse;
}

/**
 * A bounded output ceiling.
 *
 * DynamicsCompressorNode is a compressor, not a brickwall limiter: with a
 * finite ratio and a 2 ms attack it overshoots, and measurements on this
 * material showed peaks of 1.05 getting through with the compressor working
 * hard. Anything above 1.0 clips on export.
 *
 * This curve is transparent below `knee` -- slope exactly 1, no colouration on
 * normal material -- and above it bends smoothly to an asymptote at `ceiling`,
 * so no input, however hot, can produce an output beyond it. Clipping becomes
 * structurally impossible rather than merely unlikely.
 *
 * The curve is defined over an input domain of +/-2 (the caller halves the
 * signal going in) because WaveShaperNode clamps its input to +/-1 before
 * lookup. Without that headroom a 1.6 peak would be hard-clipped at the edge of
 * the table -- exactly the artefact this is meant to prevent.
 */
export function softCeiling(x, knee = 0.75, ceiling = 0.99) {
  const a = Math.abs(x);
  if (a <= knee) return x;
  const span = ceiling - knee;
  return Math.sign(x) * (knee + span * Math.tanh((a - knee) / span));
}

export function ceilingCurve(knee = 0.75, ceiling = 0.99, samples = 2048) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = ((i / (samples - 1)) * 2 - 1) * 2; // domain +/-2
    curve[i] = softCeiling(x, knee, ceiling);
  }
  return curve;
}

export class FXChain {
  constructor(ctx) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // --- drive -------------------------------------------------------------
    this.preGain = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = driveCurve(0);
    this.shaper.oversample = '4x'; // saturation folds harmonics; oversample or alias
    this.postGain = ctx.createGain();

    // --- filter ------------------------------------------------------------
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 8000;
    this.filter.Q.value = 0.7;

    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 24;
    this.hpf.Q.value = 0.7;

    // --- chorus ------------------------------------------------------------
    this.chorusSplit = ctx.createGain();
    this.chorusL = ctx.createDelay(0.05);
    this.chorusR = ctx.createDelay(0.05);
    this.chorusL.delayTime.value = 0.011;
    this.chorusR.delayTime.value = 0.017;
    this.chorusLfoL = ctx.createOscillator();
    this.chorusLfoR = ctx.createOscillator();
    this.chorusLfoL.frequency.value = 0.19;
    this.chorusLfoR.frequency.value = 0.23; // deliberately incommensurate
    this.chorusDepthL = ctx.createGain();
    this.chorusDepthR = ctx.createGain();
    this.chorusDepthL.gain.value = 0;
    this.chorusDepthR.gain.value = 0;
    this.chorusMerge = ctx.createChannelMerger(2);
    this.chorusMix = ctx.createGain();
    this.chorusMix.gain.value = 0;

    this.chorusLfoL.connect(this.chorusDepthL).connect(this.chorusL.delayTime);
    this.chorusLfoR.connect(this.chorusDepthR).connect(this.chorusR.delayTime);

    // --- delay (ping-pong) -------------------------------------------------
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0;
    this.delayL = ctx.createDelay(4);
    this.delayR = ctx.createDelay(4);
    this.delayL.delayTime.value = 0.5;
    this.delayR.delayTime.value = 0.5;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.35;
    this.delayDamp = ctx.createBiquadFilter();
    this.delayDamp.type = 'lowpass';
    this.delayDamp.frequency.value = 3200;
    this.delayMerge = ctx.createChannelMerger(2);
    this.delayReturn = ctx.createGain();

    // Cross-coupled: left feeds right, right feeds left through the damped
    // feedback path, so repeats alternate across the stereo field.
    this.delaySend.connect(this.delayL);
    this.delayL.connect(this.delayDamp);
    this.delayDamp.connect(this.delayFb);
    this.delayFb.connect(this.delayR);
    this.delayR.connect(this.delayL);
    this.delayL.connect(this.delayMerge, 0, 0);
    this.delayR.connect(this.delayMerge, 0, 1);
    this.delayMerge.connect(this.delayReturn);

    // --- reverb ------------------------------------------------------------
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createImpulseResponse(ctx, { seconds: 3.5 });
    this.reverbReturn = ctx.createGain();
    this.reverbPre = ctx.createBiquadFilter();
    this.reverbPre.type = 'highpass';
    this.reverbPre.frequency.value = 180; // keep the sub out of the tail
    this.reverbSend.connect(this.reverbPre).connect(this.convolver).connect(this.reverbReturn);

    // --- stereo width (mid/side) -------------------------------------------
    this.widthIn = ctx.createGain();
    this.splitter = ctx.createChannelSplitter(2);
    this.midGain = ctx.createGain();
    this.sideGain = ctx.createGain();
    this.sideInvert = ctx.createGain();
    this.sideInvert.gain.value = -1;
    this.widthMerge = ctx.createChannelMerger(2);
    this.widthOut = ctx.createGain();
    this.buildWidthNetwork();

    // --- master ------------------------------------------------------------
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -5;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.25;

    // Final bounded ceiling. Halve going in, shape, and the curve's +/-2 domain
    // restores the level -- see ceilingCurve().
    this.ceilingPre = ctx.createGain();
    this.ceilingPre.gain.value = 0.5;
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = ceilingCurve(0.75, 0.99);
    this.ceiling.oversample = '2x';

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.72;

    // --- wire it together --------------------------------------------------
    this.input
      .connect(this.preGain)
      .connect(this.shaper)
      .connect(this.postGain)
      .connect(this.hpf)
      .connect(this.filter);

    // chorus: parallel wet path
    this.filter.connect(this.chorusSplit);
    this.chorusSplit.connect(this.chorusL);
    this.chorusSplit.connect(this.chorusR);
    this.chorusL.connect(this.chorusMerge, 0, 0);
    this.chorusR.connect(this.chorusMerge, 0, 1);
    this.chorusMerge.connect(this.chorusMix);

    const preSends = ctx.createGain();
    this.preSends = preSends;
    this.filter.connect(preSends);      // dry
    this.chorusMix.connect(preSends);   // chorus wet

    preSends.connect(this.widthIn);            // dry into width stage
    preSends.connect(this.delaySend);
    preSends.connect(this.reverbSend);
    this.delayReturn.connect(this.widthIn);
    this.reverbReturn.connect(this.widthIn);

    this.widthOut
      .connect(this.master)
      .connect(this.limiter)
      .connect(this.ceilingPre)
      .connect(this.ceiling)
      .connect(this.analyser);
    this.analyser.connect(this.output);

    try {
      this.chorusLfoL.start();
      this.chorusLfoR.start();
    } catch (_) {
      /* already started */
    }
  }

  /**
   * Mid/side width control.
   *
   * mid  = (L + R) / 2   ->  both output channels
   * side = (L - R) / 2   ->  added to L, subtracted from R, scaled by width
   *
   * width 0 collapses to mono, 1 is unchanged, >1 exaggerates. Worth having
   * because the per-partial panning in the worklets can push the image very
   * wide, and mono compatibility is easy to lose.
   */
  buildWidthNetwork() {
    const ctx = this.ctx;
    this.widthIn.connect(this.splitter);

    const lToMid = ctx.createGain();
    const rToMid = ctx.createGain();
    lToMid.gain.value = 0.5;
    rToMid.gain.value = 0.5;
    this.splitter.connect(lToMid, 0);
    this.splitter.connect(rToMid, 1);
    lToMid.connect(this.midGain);
    rToMid.connect(this.midGain);

    const lToSide = ctx.createGain();
    const rToSide = ctx.createGain();
    lToSide.gain.value = 0.5;
    rToSide.gain.value = -0.5;
    this.splitter.connect(lToSide, 0);
    this.splitter.connect(rToSide, 1);
    lToSide.connect(this.sideGain);
    rToSide.connect(this.sideGain);

    this.midGain.gain.value = 1;
    this.sideGain.gain.value = 1;

    // L = mid + side, R = mid - side
    this.midGain.connect(this.widthMerge, 0, 0);
    this.midGain.connect(this.widthMerge, 0, 1);
    this.sideGain.connect(this.widthMerge, 0, 0);
    this.sideGain.connect(this.sideInvert).connect(this.widthMerge, 0, 1);

    this.widthMerge.connect(this.widthOut);
  }

  /** Apply a parameter patch. Unspecified keys are left alone. */
  set(params, rampTime = 0.03) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const ramp = (audioParam, value) => {
      if (value === undefined || !isFinite(value)) return;
      audioParam.cancelScheduledValues(t);
      audioParam.setTargetAtTime(value, t, Math.max(rampTime, 0.005) / 3);
    };

    if (params.drive !== undefined) {
      const d = Math.max(0, Math.min(1, params.drive));
      this.shaper.curve = driveCurve(d);
      // Compensate output for the gain saturation adds, so the drive control
      // changes character rather than loudness.
      ramp(this.preGain.gain, 1 + d * 2.5);
      ramp(this.postGain.gain, 1 / (1 + d * 1.8));
    }
    if (params.cutoff !== undefined) ramp(this.filter.frequency, params.cutoff);
    if (params.resonance !== undefined) ramp(this.filter.Q, params.resonance);
    if (params.highpass !== undefined) ramp(this.hpf.frequency, params.highpass);

    if (params.chorus !== undefined) {
      const c = Math.max(0, Math.min(1, params.chorus));
      ramp(this.chorusMix.gain, c * 0.7);
      ramp(this.chorusDepthL.gain, c * 0.004);
      ramp(this.chorusDepthR.gain, c * 0.005);
    }

    if (params.delayTime !== undefined) {
      ramp(this.delayL.delayTime, params.delayTime);
      ramp(this.delayR.delayTime, params.delayTime * 1.5); // dotted feel
    }
    if (params.delayFeedback !== undefined) {
      ramp(this.delayFb.gain, Math.max(0, Math.min(0.92, params.delayFeedback)));
    }
    if (params.delayMix !== undefined) ramp(this.delaySend.gain, params.delayMix);
    if (params.reverbMix !== undefined) ramp(this.reverbSend.gain, params.reverbMix);
    if (params.width !== undefined) {
      ramp(this.sideGain.gain, Math.max(0, Math.min(2, params.width)));
    }
    if (params.output !== undefined) ramp(this.master.gain, params.output);
    if (params.limiterThreshold !== undefined) {
      ramp(this.limiter.threshold, params.limiterThreshold);
    }
  }

  /**
   * Set the chorus LFO rates. Used by the seamless exporter to snap them to a
   * whole number of cycles per loop -- free-running modulation is the one part
   * of this signal path that is not periodic with the illusion, and a loop is
   * only as seamless as its least periodic component.
   */
  setChorusRates(hzLeft, hzRight) {
    this.chorusLfoL.frequency.value = hzLeft;
    this.chorusLfoR.frequency.value = hzRight;
  }

  /** Rebuild the reverb tail. Comparatively expensive; call on change only. */
  setReverbSize(seconds, decay = 2.2) {
    this.convolver.buffer = createImpulseResponse(this.ctx, {
      seconds: Math.max(0.2, Math.min(10, seconds)),
      decay,
    });
  }

  connect(destination) {
    this.output.connect(destination);
    return destination;
  }

  dispose() {
    try {
      this.chorusLfoL.stop();
      this.chorusLfoR.stop();
    } catch (_) {
      /* not started */
    }
    try {
      this.output.disconnect();
    } catch (_) {
      /* already disconnected */
    }
  }
}
