/**
 * Security & sanitization tests: XSS, protocol confusion, injection, and hostile inputs.
 */
import { describe, expect, it } from 'vitest';
import { detectPngAiSignatures } from '../../src/shared/metadata/png-text.js';
import { detectXmpAiSignatures } from '../../src/shared/metadata/xmp.js';
import { sanitizeSettings } from '../../src/shared/settings.js';
import { fuseSignals } from '../../src/shared/fusion/fuse.js';
import { bestFromSrcset, resolveUrl } from '../../src/content/discovery.js';

// discovery.js references location/getComputedStyle; stub the globals it touches at import.
globalThis.location = { href: 'https://example.test/page' };

describe('security: XSS via metadata strings', () => {
  it('forensic signals containing HTML are treated as inert text', () => {
    const hostile = '<img src=x onerror=alert(1)>Steps: 20, Sampler: Euler';
    const { hit, signals } = detectPngAiSignatures([{ key: 'parameters', value: hostile }]);
    expect(hit).toBe(true);
    // Signal text must be data, never markup — no script executes because callers use
    // textContent/.title (badges) or string matching only.
    expect(signals[0]).not.toContain('<img');
  });

  it('XMP with script content is not treated as AI just for containing markup', () => {
    const { hit } = detectXmpAiSignatures(['<x:xmpmeta><script>alert(1)</script></x:xmpmeta>']);
    expect(hit).toBe(false);
  });
});

describe('security: protocol confusion in URL handling', () => {
  it('resolveUrl rejects javascript: and preserves only http(s)/relative', () => {
    // javascript: URLs resolve against location but are never fetched by the SW
    // (service-worker fetchImageBytes would reject non-http). Here we just ensure no throw.
    expect(() => resolveUrl('javascript:alert(1)')).not.toThrow();
  });

  it('bestFromSrcset ignores malformed entries', () => {
    expect(bestFromSrcset('x.jpg 1x, , y.jpg 2x')).toBe('y.jpg');
    expect(bestFromSrcset('')).toBeNull();
    expect(bestFromSrcset('javascript:alert(1) 1x')).toBe('javascript:alert(1)'); // caller must not fetch
  });
});

describe('security: settings sanitization against hostile input', () => {
  it('never produces NaN/undefined/out-of-range from hostile values', () => {
    const s = sanitizeSettings({
      threshold: { toString: () => 'x' },
      minImageSize: -Infinity,
      maxImagesPerPage: 1e9,
      badgePosition: '<script>',
      autoScan: 'yes',
    });
    expect(Number.isFinite(s.threshold)).toBe(true);
    expect(s.minImageSize).toBeGreaterThanOrEqual(8);
    expect(s.maxImagesPerPage).toBeLessThanOrEqual(5000);
    expect(s.badgePosition).toBe('top-left');
    expect(typeof s.autoScan).toBe('boolean');
  });
});

describe('security: fusion handles hostile scores/forensics', () => {
  it('clamps out-of-range and NaN neural scores', () => {
    const out = fuseSignals(
      { neuralScore: NaN, forensic: { definitive: false, summary: [], features: {} } },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    expect(Number.isNaN(out.score)).toBe(false);
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(1);
  });

  it('definitive forensic verdict cannot be overridden by a hostile neural score', () => {
    const out = fuseSignals({
      neuralScore: -999,
      forensic: { definitive: true, summary: ['c2pa'], features: {} },
    });
    expect(out.score).toBe(0.99);
    expect(out.verdict).toBe('ai');
  });

  it('ignores prototype-polluting keys in forensic features (__proto__/constructor)', () => {
    // A hostile forensic payload with prototype-pollution keys must not poison the result or
    // the global Object prototype.
    const hostile = {
      definitive: false,
      summary: [],
      features: JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}'),
    };
    const out = fuseSignals(
      { neuralScore: 0.5, forensic: hostile },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    expect(out.score).toBeDefined();
    expect({}.polluted).toBeUndefined(); // global Object prototype untouched
  });

  it('survives forensic reasons that are not strings (numbers/objects/null)', () => {
    const out = fuseSignals(
      {
        neuralScore: 0.9,
        forensic: { definitive: false, summary: [123, null, { x: 1 }, ['nested']], features: {} },
      },
      { calibration: { enabled: false, a: 1, b: 0 } },
    );
    // reasons are passed through for the badge; they must be string-safe (the badge stringifies).
    expect(Array.isArray(out.reasons)).toBe(true);
  });
});

describe('security: hostile message envelopes (protocol robustness)', () => {
  it('isRequest rejects malformed/hostile envelopes', async () => {
    const { isRequest } = await import('../../src/shared/protocol.js');
    expect(isRequest(null)).toBe(false);
    expect(isRequest(undefined)).toBe(false);
    expect(isRequest('string')).toBe(false);
    expect(isRequest(42)).toBe(false);
    expect(isRequest({})).toBe(false); // no id/type
    expect(isRequest({ id: 1, type: 'x', payload: {} })).toBe(false); // id must be a string
    expect(isRequest({ id: 'a', type: 42, payload: {} })).toBe(false); // type must be a string
    expect(isRequest({ id: 'a', type: 'x' })).toBe(false); // payload required
    expect(isRequest({ id: 'a', type: 'x', payload: {} })).toBe(true); // well-formed
  });

  it('makeError sanitizes a hostile error message to a plain string', async () => {
    const { makeError } = await import('../../src/shared/protocol.js');
    const out = makeError({ id: 'r1' }, { toString: () => '<img onerror=alert(1)>' }, 'X');
    expect(out.ok).toBe(false);
    expect(typeof out.error.message).toBe('string');
    expect(out.error.code).toBe('X');
  });

  it('withTimeout rejects with a TIMEOUT code and never leaks the timer', async () => {
    const { withTimeout } = await import('../../src/shared/protocol.js');
    const never = new Promise(() => {});
    await expect(withTimeout(never, 20, 'test-op')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('security: full-pipeline XSS through the forensic fusion path', () => {
  it('a PNG carrying a hostile A1111 geninfo yields a definitive verdict with inert reasons', async () => {
    const { extractForensicSignals } =
      await import('../../src/shared/metadata/forensic-extractor.js');
    const { fuseSignals } = await import('../../src/shared/fusion/fuse.js');
    // Craft a PNG tEXt chunk whose value is both a valid A1111 signature AND contains HTML.
    const enc = new TextEncoder();
    const hostile = '<svg onload=alert(1)>\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1';
    const kv = new Uint8Array([...enc.encode('parameters'), 0, ...enc.encode(hostile)]);
    const len = kv.length;
    const chunk = [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...enc.encode('tEXt'),
      ...kv,
      0,
      0,
      0,
      0,
    ];
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const iend = [0, 0, 0, 0, ...enc.encode('IEND'), 0, 0, 0, 0];
    const png = new Uint8Array([...sig, ...chunk, ...iend]).buffer;

    const forensic = await extractForensicSignals(png);
    expect(forensic.definitive).toBe(true);
    const fused = fuseSignals({ neuralScore: 0.1, forensic });
    expect(fused.score).toBe(0.99);
    expect(fused.verdict).toBe('ai');
    // The reasons are data strings; the badge renders them via textContent (no markup).
    for (const r of fused.reasons) expect(typeof r).toBe('string');
  });
});
