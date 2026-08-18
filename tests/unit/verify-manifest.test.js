/**
 * Unit tests for tools/verify-manifest.mjs (validateManifest): structure, integrity pins,
 * per-variant shape. Pure function — no I/O. Guards the `npm run models:manifest` gate.
 */
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../tools/verify-manifest.mjs';

const sha = 'a'.repeat(64);
function validVariant(over = {}) {
  return {
    kind: 'wasm',
    key: 'primary-int8',
    url: 'https://example.test/m.onnx',
    sha256: sha,
    sizeBytes: 326220562,
    inputSize: 256,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    ...over,
  };
}

describe('verify-manifest.validateManifest', () => {
  it('accepts a valid manifest', () => {
    expect(validateManifest({ variants: [validVariant()] })).toEqual([]);
  });

  it('rejects a non-object manifest', () => {
    expect(validateManifest(null)).not.toEqual([]);
    expect(validateManifest([])).not.toEqual([]);
    expect(validateManifest('x')).not.toEqual([]);
  });

  it('rejects an empty/missing variants array', () => {
    expect(validateManifest({})).not.toEqual([]);
    expect(validateManifest({ variants: [] })).not.toEqual([]);
  });

  it('rejects a variant without a valid sha256 pin', () => {
    expect(validateManifest({ variants: [validVariant({ sha256: 'nothex' })] })).not.toEqual([]);
    expect(validateManifest({ variants: [validVariant({ sha256: undefined })] })).not.toEqual([]);
  });

  it('rejects a non-https url', () => {
    expect(
      validateManifest({ variants: [validVariant({ url: 'http://x.test/m.onnx' })] }),
    ).not.toEqual([]);
  });

  it('rejects duplicate variant keys', () => {
    const m = { variants: [validVariant(), validVariant()] };
    expect(validateManifest(m).some((p) => /duplicate key/.test(p))).toBe(true);
  });

  it('rejects an invalid kind', () => {
    expect(validateManifest({ variants: [validVariant({ kind: 'gpu' })] })).not.toEqual([]);
  });

  it('rejects non-positive/!integer sizeBytes and inputSize', () => {
    expect(validateManifest({ variants: [validVariant({ sizeBytes: -1 })] })).not.toEqual([]);
    expect(validateManifest({ variants: [validVariant({ inputSize: 0 })] })).not.toEqual([]);
  });

  it('rejects malformed mean/std', () => {
    expect(validateManifest({ variants: [validVariant({ mean: [0.5] })] })).not.toEqual([]);
    expect(validateManifest({ variants: [validVariant({ std: [0.2, 0, 0.2] })] })).not.toEqual([]);
  });

  it('rejects an unrecognized outputType', () => {
    expect(validateManifest({ variants: [validVariant({ outputType: 'garbage' })] })).not.toEqual(
      [],
    );
  });

  it('rejects an out-of-range aiLogitIndex for logits variants', () => {
    expect(
      validateManifest({ variants: [validVariant({ outputType: 'logits', aiLogitIndex: 99 })] }),
    ).not.toEqual([]);
  });

  it('accepts valid output semantics (logits idx 0/1, p_real)', () => {
    expect(
      validateManifest({ variants: [validVariant({ outputType: 'logits', aiLogitIndex: 0 })] }),
    ).toEqual([]);
    expect(
      validateManifest({ variants: [validVariant({ outputType: 'logits', aiLogitIndex: 1 })] }),
    ).toEqual([]);
    expect(
      validateManifest({
        variants: [validVariant({ outputType: 'p_real', aiLogitIndex: undefined })],
      }),
    ).toEqual([]);
  });
});
