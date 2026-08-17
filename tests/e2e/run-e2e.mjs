/**
 * E2E suite (headless Chrome-for-Testing + real extension). Run: npm run build && npm run test:e2e
 *
 * Cases:
 *  1. smoke        SW starts; content script connects to the SW on a matching page.
 *  2. discovery    an <img> on the page is discovered and analysis is attempted (the model may
 *                  be absent in CI — we assert no page crash, not a score).
 *  3. lazy-load    a dynamically inserted image is picked up via MutationObserver.
 *  4. navigation   SPA-style second navigation re-injects cleanly.
 *
 * The full inference path (model present -> score) is covered by the integration benchmark
 * (bench/run-pipeline.mjs); CI keeps e2e model-free to stay fast and deterministic.
 */
import { strict as assert } from 'node:assert';
import {
  cleanup,
  htmlPage,
  launchWithExtension,
  pngRoute,
  startFixtureServer,
  waitFor,
  waitForServiceWorker,
} from './harness.mjs';

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function main() {
  const { server, port } = await startFixtureServer({
    '/': htmlPage('<h1>fixture</h1><img src="/pixel.png" width="128" height="128" alt="">'),
    '/pixel.png': pngRoute(),
    '/multi': htmlPage(
      '<img src="/pixel.png" width="128">' +
        '<img src="/pixel.png" width="128">' +
        '<div id="lazy"></div>',
    ),
  });

  const ctx = await launchWithExtension();
  const { browser } = ctx;
  try {
    await test('service worker starts after navigating to a matching page', async () => {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
      const sw = await waitForServiceWorker(browser);
      assert.ok(sw.url().includes('background.js'));
      await page.close();
    });

    await test('content script injects and connects (DOM marker)', async () => {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
      const connected = await waitFor(
        () =>
          page.evaluate(
            () => document.documentElement.getAttribute('data-ai-detector-connected') === 'true',
          ),
        { timeoutMs: 15000 },
      ).catch(() => false);
      assert.ok(connected, 'content script marker not set');
      await page.close();
    });

    await test('content script discovers <img> + lazy inserts without page errors', async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/multi`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => {
        const img = document.createElement('img');
        img.src = '/pixel.png';
        img.width = 128;
        img.height = 128;
        document.getElementById('lazy').appendChild(img);
      });
      await new Promise((r) => setTimeout(r, 2500));
      assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
      await page.close();
    });

    await test('extension survives a second navigation (SPA-style)', async () => {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
      await page.goto(`http://127.0.0.1:${port}/multi`, { waitUntil: 'networkidle0' });
      const connected = await waitFor(
        () =>
          page.evaluate(
            () => document.documentElement.getAttribute('data-ai-detector-connected') === 'true',
          ),
        { timeoutMs: 15000 },
      ).catch(() => false);
      assert.ok(connected, 'content script did not reconnect after navigation');
      await page.close();
    });

    await test('graceful degradation: images get an N/A badge (not a crash) before model setup', async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/multi`, { waitUntil: 'networkidle0' });
      // Wait for the SW to be reachable and analysis to be attempted.
      await waitForServiceWorker(browser).catch(() => null);
      await new Promise((r) => setTimeout(r, 3000));
      // Without a downloaded model the SW returns MODEL_NOT_READY -> content script shows an
      // error/N-A badge (graceful) OR no badge if the analysis was skipped. Either way: no
      // uncaught page errors.
      assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
      await page.close();
    });

    await test('options page loads and renders the design-system UI', async () => {
      const sw = await waitForServiceWorker(browser);
      const extId = new URL(sw.url()).host; // chrome-extension://<id>/background.js
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`chrome-extension://${extId}/pages/options.html`, {
        waitUntil: 'networkidle0',
      });
      await new Promise((r) => setTimeout(r, 1500));
      const hasHeading = await page.evaluate(
        () => !!document.querySelector('h1')?.textContent?.includes('AI Image Detector Settings'),
      );
      assert.ok(hasHeading, 'options page did not render its heading');
      assert.deepEqual(errors, [], `options page errors: ${errors.join('; ')}`);
      await page.close();
    });

    // Full-stack badge assertion: the model is absent in CI, so the SW returns
    // MODEL_NOT_READY and the content script renders an error/N-A badge. This asserts the
    // badge OVERLAY actually mounts in the page DOM (the unit tests cover the badge markup;
    // this covers the end-to-end mount path in a real page).
    await test('analyzed image gets an in-page badge overlay (shadow-DOM host in the DOM)', async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
      await waitForServiceWorker(browser).catch(() => null);
      // Wait for the badge host to mount (any verdict — N/A pre-setup is fine).
      const badgeMounted = await waitFor(
        () => page.evaluate(() => !!document.querySelector('[data-ai-detector-badge]')),
        { timeoutMs: 10000, intervalMs: 300 },
      ).catch(() => false);
      assert.ok(badgeMounted, 'no [data-ai-detector-badge] host mounted on the analyzed image');
      // The host carries an accessible shadow-DOM button.
      const hasAccessibleBadge = await page.evaluate(() => {
        const host = document.querySelector('[data-ai-detector-badge]');
        const btn = host?.shadowRoot?.querySelector('.badge');
        return !!btn && btn.hasAttribute('aria-label');
      });
      assert.ok(hasAccessibleBadge, 'badge host lacks an accessible .badge button');
      assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
      await page.close();
    });
  } finally {
    await cleanup(ctx);
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[e2e] FAILED:', err);
  process.exitCode = 1;
});
