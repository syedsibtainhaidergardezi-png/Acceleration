#!/usr/bin/env node
/**
 * Browser-level audio verification.
 *
 * The unit tests in test/ cover the maths, but they cannot answer the question
 * that actually matters: does the instrument load in a real browser and produce
 * correct audio? This drives a headless Chromium, renders every preset offline
 * through the real Web Audio graph, and checks the results.
 *
 * It is a development tool, not part of `npm test`, because it needs Playwright
 * and a browser binary. Run it after touching the worklets, the FX chain, or
 * the exporter -- those are the parts unit tests cannot reach.
 *
 *   npm start                      # in one terminal
 *   npx playwright install chromium
 *   node tools/verify-audio.mjs
 *
 * Environment:
 *   BASE          server URL          (default http://localhost:8080)
 *   CHROME_PATH   browser executable  (default: Playwright's own)
 *
 * What it checks, and why each one earned its place:
 *
 *   loads         The worklets resolve and the UI builds. A failed addModule
 *                 produces a silent instrument with no visible error.
 *   NaN           Any non-finite sample. Poisons a render irrecoverably.
 *   peak          Must stay below 1.0, or the exported WAV clips.
 *   trim          The exporter's safety scale. Should be 1.0 -- anything less
 *                 means the render exceeded the ceiling and lost level.
 *   wrap step     The sample-to-sample step at the loop point, as a multiple of
 *                 the file's own 99.99th-percentile step. Above ~1 means the
 *                 loop clicks.
 *   fade energy   Energy through the crossfade versus the same render without
 *                 one. A wrong fade law shows up here as a dip toward -3 dB.
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const launchOpts = {
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
};
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
} catch (err) {
  console.error(`Could not reach ${BASE} — is the dev server running? (npm start)`);
  await browser.close();
  process.exit(1);
}

const ui = await page.evaluate(() => ({
  presets: document.querySelectorAll('.preset').length,
  controls: document.querySelectorAll('.ctl').length,
}));

// Start real-time audio, so the worklets and scheduler are exercised live and
// not only through the offline path.
await page.click('#play');
await page.waitForTimeout(2000);
const live = await page.evaluate(() => document.querySelector('#status').textContent);

const results = await page.evaluate(async () => {
  const { renderOffline, snapToCycles } = await import('/src/export/wav.js');
  const { DEFAULT_PARAMS, mergeParams } = await import('/src/engine/acceleration-engine.js');
  const { PRESETS } = await import('/src/ui/presets.js');

  const rows = [];
  for (const preset of PRESETS) {
    const params = mergeParams(DEFAULT_PARAMS, preset.params);
    params.sample.enabled = false; // nothing loaded in an automated run

    // The loop length MUST be a whole number of cycles; that is the
    // precondition the entire seamless scheme rests on.
    const period = Math.abs(params.transport.secondsPerOctave);
    const duration = snapToCycles(period, period).seconds;
    const opts = { params, duration, sampleRate: 44100 };

    const faded = await renderOffline({ ...opts, seamless: true });
    // Reference differs ONLY by the crossfade -- it is still period-corrected,
    // so the comparison isolates the fade and nothing else.
    const plain = await renderOffline({ ...opts, seamless: true, crossfade: 0 });

    const L = faded.getChannelData(0);
    const R = faded.getChannelData(1);
    const n = L.length;

    let peak = 0;
    let sumSq = 0;
    let nan = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) nan++;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sumSq += l * l + r * r;
    }

    // Wrap discontinuity, relative to the file's own extreme transients.
    const steps = new Float64Array(n - 1);
    for (let i = 1; i < n; i++) steps[i - 1] = Math.abs(L[i] - L[i - 1]);
    steps.sort();
    const p9999 = steps[Math.floor(steps.length * 0.9999)];
    const wrapRatio = Math.abs(L[0] - L[n - 1]) / Math.max(p9999, 1e-12);

    // Energy through the crossfade, faded vs not.
    const xf = Math.floor((faded.crossfadeSeconds || 0) * faded.sampleRate);
    const P = plain.getChannelData(0);
    let eF = 0;
    let eP = 0;
    for (let i = 0; i < xf; i++) {
      eF += L[i] * L[i];
      eP += P[i] * P[i];
    }
    const fadeDb = xf > 0 ? 10 * Math.log10(Math.max(eF, 1e-30) / Math.max(eP, 1e-30)) : 0;

    rows.push({
      id: preset.id,
      dur: +faded.duration.toFixed(1),
      rms: +(20 * Math.log10(Math.sqrt(sumSq / (n * 2)))).toFixed(1),
      peak: +peak.toFixed(3),
      trim: +faded.trimApplied.toFixed(3),
      nan,
      wrapRatio: +wrapRatio.toFixed(2),
      fadeDb: +fadeDb.toFixed(2),
    });
  }
  return rows;
});

console.log(`\nUI: ${ui.presets} presets, ${ui.controls} controls · realtime: ${live}\n`);
console.log('  preset              len     rms    peak   trim   wrap   fade');
console.log('  ' + '-'.repeat(63));

let failures = 0;
for (const r of results) {
  const bad = [];
  if (r.nan > 0) bad.push('NaN');
  if (r.peak >= 1.0) bad.push('clip');
  if (r.trim < 0.999) bad.push('trimmed');
  if (r.wrapRatio > 1.5) bad.push('click');
  if (Math.abs(r.fadeDb) > 2.0) bad.push('fade');
  if (bad.length) failures++;

  console.log(
    `  ${r.id.padEnd(18)} ${String(r.dur).padStart(4)}s ` +
    `${String(r.rms).padStart(6)}dB ${String(r.peak).padStart(6)} ` +
    `${String(r.trim).padStart(6)} ${String(r.wrapRatio).padStart(6)} ` +
    `${String(r.fadeDb).padStart(6)}dB  ${bad.length ? '✗ ' + bad.join(',') : 'ok'}`
  );
}

if (errors.length) {
  console.log(`\nConsole errors:\n  ${errors.join('\n  ')}`);
  failures++;
} else {
  console.log('\nNo console errors.');
}

await browser.close();
console.log(failures ? `\n${failures} problem(s).\n` : '\nAll presets verified.\n');
process.exit(failures ? 1 : 0);
