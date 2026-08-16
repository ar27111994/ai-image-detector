/**
 * Shared model-variant selection. Used by BOTH the service worker (which variant to download)
 * and the offscreen document (which variant to load for a given execution provider), so the two
 * can never disagree.
 */

/**
 * Pick the manifest variant for an execution-provider preference.
 * Prefers an exact EP match (`webgpu` -> fp16, `wasm` -> int8/fp32), falling back to the other
 * kind, then to the first declared variant.
 *
 * @param {object} manifest models/manifest.json ({ variants: Array<{kind:string, ...}> })
 * @param {string} epPreference 'webgpu' | 'wasm'
 * @returns {object} the chosen variant
 * @throws if the manifest declares no variants
 */
export function pickVariantForEp(manifest, epPreference) {
  const variants = manifest?.variants;
  if (!variants?.length) throw new Error('model manifest has no variants');
  const wanted = epPreference === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm', 'webgpu'];
  for (const kind of wanted) {
    const hit = variants.find((v) => v.kind === kind);
    if (hit) return hit;
  }
  return variants[0];
}
