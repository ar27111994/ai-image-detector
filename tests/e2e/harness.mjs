/**
 * Shared e2e harness: launch Chrome-for-Testing with the extension via spawn + CDP connect,
 * serve a local fixture site, and expose helpers to read extension state via DOM markers.
 *
 * Why spawn+connect instead of puppeteer.launch: launch() injects --enable-automation, which
 * unreliably suppresses --load-extension on Chrome 139 / CfT. Spawning directly is deterministic.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_DIR = path.join(repoRoot, 'dist');

// 1x1 transparent PNG (decodable, no AI signature)
export const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Serve a fixture site. `routes` maps pathname -> { contentType, body }. */
export function startFixtureServer(routes = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes[url.pathname];
    if (route) {
      res.writeHead(200, { 'content-type': route.contentType });
      res.end(route.body);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export function htmlPage(bodyHtml) {
  return {
    contentType: 'text/html',
    body: `<!doctype html><html><head><title>fixture</title></head><body>${bodyHtml}</body></html>`,
  };
}

export function pngRoute() {
  return { contentType: 'image/png', body: PIXEL_PNG };
}

export async function launchWithExtension({ extraArgs = [] } = {}) {
  const chrome = puppeteer.executablePath();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-e2e-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      '--remote-debugging-port=0',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no devtools endpoint')), 30000);
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

export function cleanup({ browser, proc, profile }) {
  return browser
    .disconnect()
    .catch(() => {})
    .finally(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
}

/** Poll until fn() returns truthy or timeout. */
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function waitForServiceWorker(browser, timeoutMs = 90000) {
  return await waitFor(
    async () =>
      browser
        .targets()
        .find((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://')),
    { timeoutMs, intervalMs: 1000 },
  ).then((t) => {
    if (!t) throw new Error('extension service worker never appeared');
    return t;
  });
}
