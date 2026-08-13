/**
 * Deterministic PRNG (mulberry32) used for reproducible benchmark sampling.
 */

/** @param {number} seed */
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher–Yates shuffle.
 * @template T
 * @param {T[]} arr
 * @param {number} seed
 * @returns {T[]} new shuffled array
 */
export function seededShuffle(arr, seed) {
  const rng = createRng(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
