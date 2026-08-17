/**
 * Unit tests for the build-time content-script IIFE validator (build.mjs hasTopLevelEsm).
 * This guards the MV3 invariant that content scripts are classic scripts (no ESM), and proves
 * the scanner is not fooled by strings/comments/identifiers that merely mention import/export.
 */
import { describe, expect, it } from 'vitest';
import { hasTopLevelEsm } from '../../build.mjs';

describe('hasTopLevelEsm (content-script IIFE validator)', () => {
  it('accepts a plain IIFE bundle', () => {
    expect(hasTopLevelEsm('(()=>{var g=1;})();')).toBe(false);
  });

  it('flags a top-level export', () => {
    expect(hasTopLevelEsm('export const x = 1;')).toBe(true);
  });

  it('flags a top-level import', () => {
    expect(hasTopLevelEsm('import { a } from "./x.js";')).toBe(true);
  });

  it('ignores "export" inside a double-quoted string', () => {
    expect(hasTopLevelEsm('const s = "export const y = 2";')).toBe(false);
  });

  it('ignores "export" inside a line comment', () => {
    expect(hasTopLevelEsm('// export default 1\n(()=>{})();')).toBe(false);
  });

  it('ignores "import" inside a block comment', () => {
    expect(hasTopLevelEsm('/* import x from y */ (()=>{})();')).toBe(false);
  });

  it('ignores "export" inside a template literal', () => {
    expect(hasTopLevelEsm('const t = `export foo`; (()=>{})();')).toBe(false);
  });

  it('does not match identifiers that merely contain the keyword', () => {
    expect(hasTopLevelEsm('const exported = 1; const importer = 2;')).toBe(false);
  });

  it('flags ESM even when nested (a real bundle never nests a top-level statement)', () => {
    // A minified ESM chunk may wrap code; any import/export keyword in code state = ESM.
    expect(hasTopLevelEsm('function f(){ return 1 } export { f };')).toBe(true);
  });

  it('accepts a real esbuild IIFE bundle shape and rejects a real esbuild ESM chunk shape', () => {
    // Representative of esbuild's actual output formats (not read from dist/, which is absent
    // in CI's test job — these fixtures are self-contained).
    const iife = '(()=>{var g=Object.freeze({A:"a"});function r(){return g.A}return r();})();';
    expect(hasTopLevelEsm(iife)).toBe(false);
    const esmChunk = 'import { a } from "./chunk-AAAA.js";\nconst b = a + 1;\nexport { b };\n';
    expect(hasTopLevelEsm(esmChunk)).toBe(true);
  });
});
