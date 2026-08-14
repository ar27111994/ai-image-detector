/**
 * E2E smoke test: loads the built extension (dist/) into headless Chrome and verifies
 *  1. the service worker registers and responds to ping,
 *  2. the content script injects into a served page and reaches the service worker.
 *
 * Phase 5 extends this into the full suite (setup flow, badges, inference).
 *
 * Usage: npm run build && npm run test:e2e
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(repoRoot, 'dist');

/**
 * Launch Chrome-for-Testing with the extension and connect via CDP.
 *
 * We spawn Chrome directly instead of puppeteer.launch() because launch() injects
 * `--enable-automation`, which (on Chrome 139 / CfT) unreliably suppresses
 * `--load-extension`. Spawning ourselves and connecting via the DevTools endpoint is
 * deterministic. A fresh temp profile per run mirrors the maintainers' clean-profile eval.
 */
async function launchWithExtension() {
  const chrome = puppeteer.executablePath();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-e2e-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no devtools endpoint from Chrome')), 30000);
    proc.stderr.on('data', (d) => {
      const m = d.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', () => reject(new Error('Chrome exited before DevTools endpoint')));
  });
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  return { browser, proc, profile };
}

function killChrome(proc, profile) {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const FIXTURE_PAGE = `<!doctype html>
<html><head><title>e2e fixture</title></head>
<body><h1>fixture</h1><img src="/pixel.png" width="64" height="64" alt=""></body></html>`;

// 1x1 transparent PNG
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function startFixtureServer() {
  const server = createServer((req, res) => {
    if (req.url === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PIXEL_PNG);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE_PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitForServiceWorker(browser, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = browser
      .targets()
      .find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    if (target) return target;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('extension service worker never appeared');
}

async function main() {
  const { server, port } = await startFixtureServer();
  let ctx = null;
  try {
    ctx = await launchWithExtension();
    const { browser } = ctx;

    // MV3 service workers start lazily — only when a page they match is loaded or an event
    // fires. Navigate to a matching page FIRST, then poll for the worker target.
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));
    page.on('pageerror', (err) => consoleLines.push(`pageerror: ${err.message}`));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });

    const swTarget = await waitForServiceWorker(browser);
    console.log('[e2e] service worker target found:', swTarget.url());

    // Content script should have injected and set its DOM marker after SW ping/pong.
    // (console from content scripts is not reliably surfaced in headless Chrome.)
    const deadline = Date.now() + 8000;
    let connected = false;
    while (Date.now() < deadline && !connected) {
      connected = await page.evaluate(
        () => document.documentElement.getAttribute('data-ai-detector-connected') === 'true',
      );
      if (!connected) await new Promise((r) => setTimeout(r, 300));
    }
    if (!connected) {
      throw new Error(`content script did not connect; console: ${JSON.stringify(consoleLines)}`);
    }

    console.log('[e2e] smoke test passed: SW alive, content script connected');
  } finally {
    if (ctx) {
      await ctx.browser.disconnect();
      killChrome(ctx.proc, ctx.profile);
    } else {
      server.close();
    }
    server.close();
  }
}

main().catch((err) => {
  console.error('[e2e] FAILED:', err);
  process.exitCode = 1;
});
