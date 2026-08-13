import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MSG, STORAGE_KEYS, VERDICT } from '../../src/shared/constants.js';

describe('shared/constants', () => {
  it('uses the bounty-mandated default decision threshold of 0.65', () => {
    expect(DEFAULT_SETTINGS.threshold).toBe(0.65);
  });

  it('message type values are unique', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });

  it('storage keys are unique and namespaced', () => {
    const values = Object.values(STORAGE_KEYS);
    expect(new Set(values).size).toBe(values.length);
    for (const key of values) expect(key).toMatch(/\./);
  });

  it('verdict classes are stable strings', () => {
    expect(VERDICT).toEqual({
      AI: 'ai',
      REAL: 'real',
      UNCERTAIN: 'uncertain',
      ERROR: 'error',
      SKIPPED: 'skipped',
    });
  });
});
