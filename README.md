# Acceleration

A synthesiser for the sound of infinite acceleration.

It builds two auditory illusions and locks them to the same clock:

- a **Shepard–Risset glissando** — a pitch that rises forever without ever getting higher;
- a **Risset rhythm** — a pulse that accelerates forever without ever getting faster.

Running together, they read as a single object winding up without limit. A neutron
star spinning up, and never arriving.

It also works the other way round: drop in any sound — a voice, a drum loop, a chord,
a field recording — and it becomes the material the spiral is built from.

Everything runs in the browser. No build step, no dependencies, no uploads.

```bash
git clone https://github.com/syedsibtainhaidergardezi-png/Acceleration.git
cd Acceleration
npm start            # → http://localhost:8080
```

That is the whole setup. There are **no dependencies** — `npm install` is not
needed and installs nothing. The server is ~60 lines of Node standard library;
if the default port is taken it steps to the next free one, and `PORT=3000 npm
start` overrides it.

No Node? Any static server works, because the app is just files:

```bash
python3 -m http.server 8080
```

**It must be served over `http://`.** Opening `index.html` from disk does not
work: the `file://` origin blocks both ES modules and
`AudioWorklet.addModule`, so the page loads and looks perfectly fine while
making no sound. The app detects this case and says so rather than leaving you
guessing.

```bash
npm test             # 58 tests, no dependencies
```

There is also a browser-level check, which is where the claims about levels and
loop joins in this README come from. It drives a headless Chromium, renders
every preset through the real Web Audio graph, and verifies there is no
clipping, no NaN, and no audible seam. It needs Playwright, so it is kept out of
`npm test`:

```bash
npm start                          # in one terminal
npx playwright install chromium
npm run verify
```

### Deploying it

It is a static site — no build step, and nothing runs on a server. `npm start`
is a local convenience only. So any static host works; Vercel is the shortest
path:

```bash
npx vercel          # preview
npx vercel --prod   # production
```

Or import the repo at [vercel.com/new](https://vercel.com/new) — no settings to
change. `vercel.json` pins framework detection off and the build command to
none, so Vercel serves the repo root as-is instead of guessing; `.vercelignore`
keeps the tests, tooling and dev server out of the upload.

Hosting it does two useful things beyond convenience. It gives you HTTPS, which
is a **secure context** — the same requirement that makes opening `index.html`
from disk fail. And every path in the app is relative and the worklet URLs
resolve through `import.meta.url`, so it works unchanged at a project root, on a
preview URL, or under a subpath.

GitHub Pages, Netlify, Cloudflare Pages and S3 all work the same way; there is
nothing Vercel-specific about the app itself.

One caveat worth knowing: browsers will not start audio until you interact with
the page, so the first click on **Play** is what creates the AudioContext. That
is expected everywhere, not a deployment problem.

---

## The idea

A Shepard tone is a stack of sine partials spaced exactly one octave apart, whose
amplitudes are read from a **fixed window in log-frequency space**. The partials
slide upward through that window; each fades in at the bottom, swells through the
middle, and fades out at the top. Because the window never moves, the spectrum
after one octave of travel is *identical* to where it started. The rise has no
beginning and no end.

Track a single scalar `phase`, in octaves. Partial *i* sits at

```
e_i = (i + phase) mod N          position in the span, octaves
f_i = baseFreq · 2^(e_i)         frequency
a_i = window(e_i)                amplitude
```

The rhythm is the same construction with tempo on the axis instead of pitch.
Layers at octave-spaced tempi accelerate through a fixed window: each fades in
slow, speeds up through the audible middle, and fades out fast while a new slow
layer materialises underneath.

### Why the window shape matters

Most descriptions of Shepard tones reach for a Gaussian. This uses a **Hann**
window by default, and the reason is worth stating, because it is the difference
between an illusion with a seam and one without.

Any cosine-sum window — Hann, Blackman, Blackman-Harris — has an exact property
when sampled at unit spacing: for every integer *k* ≥ 1, the sum of
cos(2π·k·(i + phase)/N) over i = 0…N−1 vanishes identically. Therefore

```
Σ w((i + phase) mod N)  =  a₀ · N        for ALL phase
```

The stack's total amplitude is **mathematically constant** as it slides — not
approximately, exactly — so there is no loudness pumping. And Hann reaches exactly
zero at both window edges, so a partial wrapping from the top of the span back to
the bottom does so in **perfect silence**. No click, no seam.

A Gaussian does neither. It only approximates constant sum, and it is nonzero at
the edges, so the wrap sits around −27 dB for typical widths — audible if you know
what to listen for. It is still offered, because it has a rounder timbre that some
material wants, but it is not the default.

This is asserted in the tests to float precision, not just described:

```
✔ summed amplitude of the sliding stack is EXACTLY constant
✔ cosine-sum windows vanish at both span edges
✔ stack repeats exactly after one octave of phase
```

### Making it music, not a siren

A bare Shepard glissando is a fine demonstration and exhausting to listen to. Four
things carry it into being musical, and they are the parts worth understanding
before you touch anything else:

**Chords, for free.** Transposing the stack by *s* semitones multiplies every
partial by 2^(s/12) — which is *identical* to advancing that stack's phase by
s/12 octaves, because the stack is octave-periodic by construction. So a chord
voice is not a second oscillator bank with its own frequencies to track; it is the
same bank read at a phase offset. One accumulator drives the whole chord, every
voice stays locked in tune forever, and no voice can drift out of the window while
its neighbours sit inside it.

**An anchor.** A fixed pedal drone underneath. This is the single cheapest thing
that turns a siren into music: the ear needs something stationary to measure the
rise against. Without a reference, the illusion has nothing to be an illusion
*relative to*.

**Just intonation.** On a chord that sustains forever, tempered thirds beat — and
those beats never resolve. Pure ratios are the better default here in a way they
are not for music that moves on.

**Spectral tilt.** The stack necessarily has energy across the whole spectrum. A
few dB per octave of downward tilt is what lets it sit in a mix instead of
screaming. It costs almost nothing: even at a steep −8 dB/oct, the Hann stack's
level still varies by only ~0.07 dB across a cycle, and `levelLock` takes that to
exactly zero.

### Acceleration, specifically

Constant-rate rising reads as *steady*, not as *accelerating* — pitch has no
speed. Two things fix that.

**Swoop** modulates the instantaneous rate with a function periodic in *phase*:

```
dPhase/dt = rate · (1 + a·cos(2π·phase))
```

Because the shaping has mean exactly 1 over a cycle, the average time per octave
is unchanged, so the illusion's period — and therefore the loop length — is
preserved exactly. Because it is periodic in phase rather than in time, every
octave is shaped identically and the seam stays invisible. And because all
partials share one phase, they remain perfectly octave-spaced throughout.

**The Risset rhythm** is what sells acceleration to the body rather than the ear.
Turn on transport **linking** and one octave of pitch takes exactly as long as one
doubling of tempo; the two illusions share a period, and the whole texture becomes
one machine winding up rather than two effects running side by side.

Beat times are solved in closed form rather than counted. With tempo
T(t) = T₀·2^(t/D), the accumulated beat count is the integral

```
θ(t) = (T₀·D / ln2) · (2^(t/D) − 1)
```

which inverts analytically, so every beat is placed exactly. The obvious
alternative — "wait 1/T seconds, then recompute T" — is a first-order
approximation of an exponential and runs measurably late within a few seconds,
smearing the grid and drifting the layers out of the phase alignment the illusion
depends on. There is a test that demonstrates the drift.

---

## Turning a sound into a Shepard tone

Drop an audio file anywhere on the page. It is mono-summed, DC-corrected,
normalised, and the sustained region is auto-detected for looping (looping the
whole file would re-trigger its attack on every pass). Then enable the **Sample**
layer.

Two transposition modes, and the choice matters:

| Mode | Behaviour | Use it for |
|---|---|---|
| **Granular** | Pitch shifts, speed does not | Anything rhythmic — drum loops, speech, riffs |
| **Varispeed** | Pitch and speed together, like tape | Sustained texture — pads, vowels, room tone, cymbals |

Granular is the one that makes this musical rather than a curiosity: overlapping
grains are read at the transposed rate while the grain *stream* advances at 1×, so
every layer of the stack stays locked to the same groove while spanning eight
octaves. **The loop keeps its time; only its pitch spirals.**

Grain windows are Hann at 50% overlap, which sums to exactly unity, so the grain
stream adds no amplitude ripple of its own.

### Anti-aliasing

The stack reads its source at octave-spaced rates. Reading a buffer at 8× shifts
everything up three octaves, including whatever sat just under Nyquist — which
folds back down as aliasing. On a sweeping stack, that folded content moves
*downward* while the real content moves upward: the exact artefact that destroys
the illusion, and it is instantly audible as a gritty shimmer going the wrong way.

So both the synthesised waveforms and the loaded sample are **mip-mapped**: one
band-limited copy per octave of upward transposition, with fractional-octave
crossfading between adjacent mips so nothing steps as it glides. The sample's
mips are filtered zero-phase (forward then backward), so they stay time-aligned
and crossfading between them cannot comb-filter.

Verified rather than assumed — `test/parity.test.js` runs a DFT over the generated
wavetables and asserts that no harmonic which would alias is present.

---

## Export

Rendered offline, faster than real time, from the exact settings you are hearing.
24-bit by default: this material is dense, sustained and low-crest-factor with long
quiet tails, which is precisely where 16-bit quantisation noise becomes audible as
a grainy floor under the fades.

### What "seamless" means here

Worth being precise, because the obvious approach does not work.

The illusion is periodic in its **spectrum**, not in its **waveform**. After one
octave the partials sit at identical frequencies with identical gains — but each
is a free-running oscillator carrying its own accumulated phase, and those phases
do not realign. Measured, cycle 2 of a raw render differs from cycle 1 by about
+3 dB of difference energy: statistically identical, sample-for-sample unrelated.
Cutting at a cycle boundary clicks on every loop even though nothing about the
sound has changed.

So a seamless export does three things:

1. **Reaches steady state** — a pre-roll sized from the actual reverb and delay
   settings is rendered and discarded, so the captured region is not still
   building up.

2. **Makes every free-running component share the period**, so the two sides of
   the join line up in everything except phase:
   - the chorus LFOs (deliberately incommensurate at 0.19 and 0.23 Hz, so they
     never repeat) snap to a whole number of cycles per loop;
   - the rhythm's tempo-doubling time snaps to an exact divisor of the loop
     length, so percussion lands at matching positions on both sides;
   - the **drone** snaps too, for a subtler reason. Unlike the stack, it is a
     fixed-frequency oscillator, so across the join it is the *same* signal
     offset by whatever phase it accumulated. Crossfading a sine against a
     phase-shifted copy of itself does not preserve its level — at half a cycle
     of offset the two cancel outright. That measured as up to 1.2 dB of level
     movement varying unpredictably by preset. Snapping makes the offset exactly
     zero; the frequency shift required is under a tenth of a cent.

3. **Crossfades the join** — briefly (≤0.4 s), with an equal-power law because
   the two sides are uncorrelated and a linear fade would dip 3 dB in the
   middle. The blended region is then passed through the same soft ceiling the
   FX chain applies, since summing two uncorrelated signals can peak √2 higher
   than either alone.

Step 3 is where the spectral periodicity pays off: the two sides are not merely
similar, they are spectrally identical by construction, at identical loudness,
with aligned percussion. That is exactly the case where a crossfade is
undetectable — which is why it can be kept short.

Measured across all presets: the step at the wrap is **0.01–0.54×** the file's
own largest naturally-occurring sample-to-sample step, so there is nothing to
hear; energy through the fade sits within about **1 dB** with no systematic dip;
and no preset clips or needs level-trimming.

The export length is snapped to a whole number of cycles automatically.

---

## Controls worth knowing

| Control | Why you'd reach for it |
|---|---|
| **Octave time** | The master tempo of the whole thing, and the exact loop length of a seamless export |
| **Swoop** | Makes a steady rise feel like acceleration, without changing its period |
| **Link rhythm to pitch** | Locks both illusions to one period. The single biggest change to how unified it sounds |
| **Window** | `hann`/`blackman` are seamless; `gauss` deliberately is not — switch to hear the seam |
| **Tilt** | The main tool for making a dense stack sit in a mix |
| **Step scale** | Off = continuous glissando. Anything else walks that scale upward forever (the Shepard *scale*) |
| **Pulse depth** | Lets the beat duck the tonal stack, so the texture breathes with the acceleration |
| **Span bottom / width** | How much of the spectrum the illusion occupies |

Keyboard: <kbd>Space</kbd> play/stop · <kbd>R</kbd> restart from phase 0 ·
<kbd>↑</kbd><kbd>↓</kbd> octave time.

**Start with `Barber Pole`** if you want to hear the mechanism naked — pure sines,
one pitch class, no effects. Then `Neutron Star` for what the instrument is
actually for.

---

## Layout

```
index.html · styles.css
src/
  engine/
    shepard-math.js          pure, tested maths — windows, phase, Risset timing
    voicing.js               chords as phase offsets; scales; just intonation
    acceleration-engine.js   graph, parameters, transport
    risset-rhythm.js         closed-form beat scheduling + percussion synthesis
    fx.js                    drive, filter, chorus, ping-pong delay, reverb, ceiling
    sample-prep.js           mono-sum, DC, normalise, loop detection, mip chain
  worklets/
    shepard-osc-processor.js      band-limited wavetable stack
    shepard-sampler-processor.js  granular / varispeed sample stack
  export/wav.js              offline render, seamless looping, WAV encoding
  ui/                        presets, generated controls, canvas visualisers
test/                        58 tests, `node --test`
```

Synthesis runs in **AudioWorklets** — on the audio thread, sample-accurate. The
alternative (automating oscillator parameters from the main thread) quantises the
sweep to control-rate steps, and on a slow continuous glissando that is audible as
zipper noise.

### One deliberate piece of duplication

The worklets re-implement `wrap`, `windowAt` and `tiltAt` instead of importing
them from `shepard-math.js`. AudioWorklet module imports are not reliably
supported across browsers, and a failed `addModule` means total silence rather
than a helpful error.

The cost of that decision is the risk of the two copies drifting apart, so
`test/parity.test.js` loads the real worklet source and asserts it agrees with the
shared implementation to float precision. Edit one without the other and the tests
fail.

---

## Requirements

Any browser with AudioWorklet support — Chrome, Firefox, Safari 14.1+, Edge.
Node 18+ for the dev server and tests.

Dropped audio never leaves your machine; there is no network path for it to take.

## Licence

MIT.
