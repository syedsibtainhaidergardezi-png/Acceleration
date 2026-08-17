/**
 * wav.js
 *
 * Offline rendering and WAV encoding.
 *
 * ---------------------------------------------------------------------------
 * THE SEAMLESS LOOP
 * ---------------------------------------------------------------------------
 * This is the export mode that matters, and it rests on one crucial
 * distinction: the illusion is periodic in its SPECTRUM, not in its WAVEFORM.
 *
 * After one octave of travel the stack's partials sit at exactly the same
 * frequencies with exactly the same gains as before -- that identity is the
 * whole illusion. But each partial is a free-running oscillator carrying its
 * own accumulated phase, and those phases do not realign. Measured, cycle 2 of
 * a raw render correlates with cycle 1 at about +3 dB of difference energy:
 * statistically identical, sample-for-sample unrelated. Cutting at a cycle
 * boundary therefore produces a waveform discontinuity -- an audible click on
 * every loop -- even though nothing about the sound has changed.
 *
 * (Phase coherence could be forced, by deriving each partial's phase
 * analytically from its position instead of accumulating it. That does make
 * the waveform exactly periodic, but it locks every partial into a fixed phase
 * relationship, which turns a smooth pad into something buzzy and impulsive.
 * Not worth it.)
 *
 * So the export does three things:
 *
 *  1. REACH STEADY STATE. A pre-roll is rendered and discarded, sized from the
 *     actual reverb and delay settings, so the captured region is not still
 *     building up. An 8-second reverb needs far more lead-in than a 2-second
 *     one.
 *
 *  2. MAKE EVERY MODULATOR SHARE THE PERIOD, so that the loop point and the
 *     material just past it line up in every respect except phase:
 *       - The chorus LFOs run at 0.19 and 0.23 Hz, deliberately incommensurate
 *         so they never repeat. Lovely live, fatal for a loop; they are
 *         snapped to a whole number of cycles per loop.
 *       - The Risset rhythm's period is its tempo doubling time, which equals
 *         the pitch period only when transport linking is on. Otherwise it is
 *         snapped to an exact divisor of the loop length, so percussion hits
 *         land at matching positions on both sides of the join.
 *
 *  3. CROSSFADE THE JOIN. A little audio past the loop point is rendered and
 *     equal-power crossfaded onto the head. This is where the spectral
 *     periodicity pays off: the two sides of the fade are not merely similar,
 *     they are spectrally identical by construction, with identical loudness
 *     and aligned percussion. Crossfading uncorrelated-but-identical material
 *     is exactly the case where a fade is undetectable. An equal-power (sine/
 *     cosine) law is used rather than a linear one because the two sides are
 *     uncorrelated -- a linear fade would dip 3 dB in the middle.
 *
 * An earlier attempt folded the reverb tail back onto the head instead. That
 * technique is valid when rendering from silence, but combined with a pre-roll
 * it double-counts the tail: peaks rose 4-5 dB and the join got worse, not
 * better.
 */

import { AccelerationEngine } from '../engine/acceleration-engine.js';
import { softCeiling } from '../engine/fx.js';

/**
 * Render the instrument offline.
 *
 * @param {object} opts
 * @param {object} opts.params       full parameter tree
 * @param {number} opts.duration     seconds of usable audio to produce
 * @param {number} [opts.sampleRate]
 * @param {object} [opts.sample]     prepared sample payload, if sample mode
 * @param {boolean} [opts.seamless]  make the render loop cleanly
 * @param {number} [opts.crossfade]  join crossfade, seconds; null = automatic,
 *                                   0 = none (leaves the join uncrossfaded but
 *                                   still period-corrected)
 * @param {number} [opts.preRoll]    discarded lead-in, seconds
 * @param {(p:number)=>void} [opts.onProgress]
 * @returns {Promise<AudioBuffer>}
 */
export async function renderOffline({
  params,
  duration,
  sampleRate = 48000,
  sample = null,
  seamless = true,
  crossfade = null,
  preRoll = null,
  onProgress = null,
}) {
  // Size the pre-roll from the actual effect tail: long enough for the reverb
  // to decay and the delay feedback to die away, so the captured region is in
  // steady state. Too short and the loop's first pass is quieter than the
  // rest, which is audible as a pulse once per cycle.
  const reverbSize = params.fx?.reverbSize ?? 3.5;
  const delayTime = params.fx?.delayTime ?? 0.4;
  const feedback = Math.min(params.fx?.delayFeedback ?? 0.3, 0.92);
  // Repeats needed for the delay to fall 60 dB.
  const delayTail = feedback > 0.01 ? delayTime * (Math.log(0.001) / Math.log(feedback)) : delayTime;
  const settle =
    preRoll !== null ? preRoll : Math.min(20, Math.max(2, reverbSize * 1.5 + delayTail));

  // Crossfade length for the join. Kept short deliberately: because both sides
  // are spectrally identical, a brief fade is all it takes to remove the
  // waveform discontinuity (measured wrap steps come out well below the file's
  // own largest natural transient). A long fade buys nothing and gives any
  // residual level artefact more time to be noticed.
  const xfadeSeconds = !seamless
    ? 0
    : crossfade !== null
    ? Math.max(0, crossfade)
    : Math.max(0.12, Math.min(0.4, duration * 0.05));

  const total = settle + duration + xfadeSeconds;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sampleRate), sampleRate);

  const engine = await AccelerationEngine.create(ctx, params);
  engine.connect(ctx.destination);
  if (sample) engine.setSample(sample);

  engine.start(0, { resetPhase: true });

  // Must come after start(), which re-applies the parameter tree and would
  // otherwise overwrite the snapped drone frequencies and rhythm period.
  if (seamless) makePeriodic(engine, duration);

  // Offline contexts have no wall clock to drive the scheduler interval, so
  // every percussion hit for the whole render is placed up front. This has to
  // follow makePeriodic, or the hits are placed on the un-snapped grid.
  engine.prescheduleRhythm(total);

  if (onProgress) onProgress(0.05);
  const rendered = await ctx.startRendering();
  if (onProgress) onProgress(0.85);

  const startSample = Math.floor(settle * sampleRate);
  const bodySamples = Math.min(
    Math.floor(duration * sampleRate),
    rendered.length - startSample
  );
  const xfadeSamples = Math.min(
    Math.floor(xfadeSeconds * sampleRate),
    Math.max(0, rendered.length - startSample - bodySamples),
    Math.floor(bodySamples / 2)
  );

  const result = createBuffer(rendered.numberOfChannels, bodySamples, sampleRate);
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const src = rendered.getChannelData(c);
    const dst = result.getChannelData(c);
    for (let i = 0; i < bodySamples; i++) dst[i] = src[startSample + i];

    // Equal-power crossfade of the overhang onto the head. At i = 0 the output
    // is purely the continuation -- exactly the audio that followed the last
    // sample of the body -- so the wrap is continuous. By i = xfadeSamples it
    // is purely the body again.
    for (let i = 0; i < xfadeSamples; i++) {
      const theta = (Math.PI / 2) * (i / xfadeSamples);
      const continuation = src[startSample + bodySamples + i];
      const mixed = continuation * Math.cos(theta) + dst[i] * Math.sin(theta);
      // Re-apply the engine's output ceiling to the blended region.
      //
      // Summing two uncorrelated signals can peak up to sqrt(2) higher than
      // either alone, so the fade can exceed a ceiling that both inputs
      // respected. Left alone, that tripped the whole-file safety trim and cost
      // ~1.4 dB of level across the entire export for the sake of a few samples
      // in a 0.4 s window.
      //
      // Using the same soft-ceiling function the FX chain already applied is
      // the consistent choice: these samples end up shaped exactly as they
      // would have been had they passed through the chain at this level.
      dst[i] = softCeiling(mixed);
    }
  }
  result.crossfadeSeconds = xfadeSamples / sampleRate;

  // Safety trim. The engine's output ceiling already bounds the signal below
  // 0.99, so this should be a no-op -- it exists so that no future change to
  // gain staging can ever ship a clipped file. A single constant factor is
  // used deliberately: any time-varying gain would break the exact periodicity
  // the seamless loop depends on.
  result.trimApplied = applySafetyTrim(result, 0.99);

  if (onProgress) onProgress(1);
  engine.dispose();
  return result;
}

/**
 * Force every free-running modulator to complete a whole number of cycles per
 * loop, so the render is exactly periodic. See the header note.
 */
function makePeriodic(engine, duration) {
  if (!(duration > 0)) return;

  // Chorus LFOs: snap to the nearest whole cycles-per-loop, keeping the two
  // rates distinct so the stereo image stays decorrelated.
  const snap = (hz) => Math.max(1, Math.round(hz * duration)) / duration;
  let left = snap(0.19);
  let right = snap(0.23);
  if (right === left) right = (Math.round(0.23 * duration) + 1) / duration;
  engine.fx.setChorusRates(left, right);

  // The drone needs the same treatment, for a subtler reason.
  //
  // Unlike the stack, the drone is a fixed-frequency oscillator, so its
  // waveform on the far side of the loop point is the *same* signal as on the
  // near side -- but offset by whatever phase it happened to accumulate over
  // the loop. Equal-power crossfading a sine against a phase-shifted copy of
  // itself does not preserve its level; at half a cycle of offset the two
  // cancel outright. Measured, that showed up as up to 1.2 dB of level
  // movement through the fade, varying unpredictably by preset.
  //
  // Snapping each drone oscillator to a whole number of cycles per loop makes
  // the offset exactly zero, so the two sides are identical and nothing can
  // cancel. The frequency shift needed is under a tenth of a cent.
  for (const osc of engine.droneOscs) {
    const base = osc.frequency.value;
    const detuned = base * Math.pow(2, osc.detune.value / 1200);
    const cycles = Math.max(1, Math.round(detuned * duration));
    osc.detune.cancelScheduledValues(0);
    osc.detune.value = 0;
    osc.frequency.cancelScheduledValues(0);
    osc.frequency.value = cycles / duration;
  }

  // Rhythm: its period is the tempo doubling time. With transport linking on
  // that already equals the pitch period, and the loop length is a whole
  // number of those. Without linking, snap it to an exact divisor.
  const p = engine.params;
  if (p.rhythm.enabled && !p.transport.link) {
    const current = Math.abs(engine.rhythm.cfg.doubling) || 8;
    const cycles = Math.max(1, Math.round(duration / current));
    const snapped = duration / cycles;
    engine.rhythm.setConfig({
      doubling: snapped * Math.sign(engine.rhythm.cfg.doubling || 1),
    });
  }
}

/**
 * Scale a buffer down if it exceeds `ceiling`. Returns the gain applied
 * (1 = untouched), so callers can report it.
 */
export function applySafetyTrim(buffer, ceiling = 0.99) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= ceiling || peak === 0) return 1;

  const gain = ceiling / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
  return gain;
}

/**
 * Plain object standing in for an AudioBuffer, so this module works in Node
 * (for tests) as well as in the browser.
 */
function createBuffer(channels, length, sampleRate) {
  const data = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => data[c],
  };
}

/**
 * Compute a loop duration that is an exact whole number of illusion cycles.
 * Rounding to a cycle boundary is what makes the seamless export possible, so
 * the UI asks for an approximate length and this snaps it.
 */
export function snapToCycles(approxSeconds, secondsPerOctave) {
  const period = Math.abs(secondsPerOctave);
  if (!(period > 0.01)) return approxSeconds;
  const cycles = Math.max(1, Math.round(approxSeconds / period));
  return { seconds: cycles * period, cycles, period };
}

/**
 * Encode to WAV.
 *
 * 24-bit is the default: the material is a sustained, dense, low-crest-factor
 * texture with long quiet reverb tails, which is exactly where 16-bit
 * quantisation noise becomes audible as a grainy floor under the fades.
 *
 * @param {AudioBuffer|object} buffer
 * @param {object} [opts]
 * @param {16|24|32} [opts.bitDepth]  32 selects IEEE float
 * @returns {Blob}
 */
export function encodeWav(buffer, { bitDepth = 24 } = {}) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const isFloat = bitDepth === 32;
  const bytesPerSample = isFloat ? 4 : bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;

  // WAVE_FORMAT_EXTENSIBLE is not needed for stereo, so a plain 44-byte header
  // is fine and maximally compatible.
  const headerSize = 44;
  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));

  let offset = headerSize;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      let s = chans[c][i];
      // Hard clamp before quantising. The limiter should have handled this,
      // but a sample that wraps instead of clipping is a horrible noise.
      if (s > 1) s = 1;
      else if (s < -1) s = -1;

      if (isFloat) {
        view.setFloat32(offset, s, true);
        offset += 4;
      } else if (bitDepth === 16) {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      } else {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      }
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next frame; revoking synchronously can cancel the download
  // in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
