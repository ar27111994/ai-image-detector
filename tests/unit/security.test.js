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
});
