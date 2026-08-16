/**
 * Minimal bounded LRU cache (Map-backed, O(1) get/set). Used for analysis results and
 * content-hash dedup. Pure JS — unit-tested.
 */
export class LruCache {
  /**
   * @param {number} maxEntries maximum entries before LRU eviction
   */
  constructor(maxEntries = 512) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('LruCache: maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    /** @type {Map<string, *>} */
    this.map = new Map();
  }

  /**
   * Get a value, refreshing its recency.
   * @param {string} key
   * @returns {*} the cached value, or undefined when absent
   */
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // refresh recency
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /**
   * Insert/update a value, evicting least-recently-used entries beyond the cap.
   * @param {string} key
   * @param {*} value
   * @returns {void}
   */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      // evict least-recently-used (first key in insertion order)
      this.map.delete(this.map.keys().next().value);
    }
  }

  /**
   * @param {string} key
   * @returns {boolean} true if present
   */
  has(key) {
    return this.map.has(key);
  }

  /**
   * @param {string} key
   * @returns {boolean} true if an entry was removed
   */
  delete(key) {
    return this.map.delete(key);
  }

  /** Remove every entry. @returns {void} */
  clear() {
    this.map.clear();
  }

  /** @returns {number} current entry count */
  get size() {
    return this.map.size;
  }
}
