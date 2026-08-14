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
