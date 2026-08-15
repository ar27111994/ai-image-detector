/**
 * Tests for the docs auto-sync marker replacement (tools/sync-docs.mjs).
 * We test the marker regex + replacement logic against a fixture string, without running the
 * full vitest/benchmark computation (that's covered by the tool's own --check in CI).
 */
import { describe, expect, it } from 'vitest';

// The marker regex must match the tool's (kept in sync).
const MARKER_RE = /<!--\s*AUTO:([A-Z0-9_]+)\s*-->([\s\S]*?)<!--\s*\/AUTO:\1\s*-->/g;

function applyValues(content, values) {
  return content.replace(MARKER_RE, (match, key, oldValue) => {
    const value = values[key];
    if (value == null) return match;
    return `<!-- AUTO:${key} -->${value}<!-- /AUTO:${key} -->`;
  });
}

describe('sync-docs marker replacement', () => {
  it('replaces a marked value', () => {
    const doc = 'Tests: <!-- AUTO:TEST_COUNT -->157<!-- /AUTO:TEST_COUNT --> cases.';
    const out = applyValues(doc, { TEST_COUNT: '209' });
    expect(out).toBe('Tests: <!-- AUTO:TEST_COUNT -->209<!-- /AUTO:TEST_COUNT --> cases.');
  });

  it('leaves unmarked text untouched', () => {
    const doc = 'No markers here.';
    expect(applyValues(doc, { TEST_COUNT: '209' })).toBe(doc);
  });

  it('leaves markers with unknown keys untouched', () => {
    const doc = '<!-- AUTO:UNKNOWN_KEY -->x<!-- /AUTO:UNKNOWN_KEY -->';
    expect(applyValues(doc, { TEST_COUNT: '209' })).toBe(doc);
  });

  it('replaces multiple different markers independently', () => {
    const doc =
      '<!-- AUTO:VERSION -->1.0.0<!-- /AUTO:VERSION --> and <!-- AUTO:TEST_COUNT -->100<!-- /AUTO:TEST_COUNT -->';
    const out = applyValues(doc, { VERSION: '2.0.0', TEST_COUNT: '209' });
    expect(out).toContain('2.0.0');
    expect(out).toContain('209');
    expect(out).not.toContain('1.0.0');
    expect(out).not.toContain('>100<');
  });

  it('handles a whole-line badge marker', () => {
    const doc =
      '<!-- AUTO:BA_BADGE -->[![Balanced accuracy: 84.5%](https://img.shields.io/badge/x)](b.md)<!-- /AUTO:BA_BADGE -->';
    const newBadge = '[![Balanced accuracy: 85.1%](https://img.shields.io/badge/y)](b.md)';
    const out = applyValues(doc, { BA_BADGE: newBadge });
    expect(out).toContain('85.1%');
    expect(out).toContain('AUTO:BA_BADGE');
  });

  it('is idempotent when the value already matches', () => {
    const doc = '<!-- AUTO:VERSION -->1.0.0<!-- /AUTO:VERSION -->';
    const once = applyValues(doc, { VERSION: '1.0.0' });
    expect(once).toBe(doc);
  });
});
