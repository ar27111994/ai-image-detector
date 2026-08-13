/**
 * Balanced-accuracy evaluation math — pure functions, shared between the benchmark CLI and
 * unit tests. No I/O.
 */

/**
 * Confusion stats at a decision threshold. Scores are P(AI-generated) in [0,1].
 * label 'fake' = AI (positive class), 'real' = negative class.
 *
 * @param {Array<{label: string, score: number|null, error?: string}>} rows
 * @param {number} threshold score >= threshold counts as predicted-AI
 * @returns {{
 *   tp: number, tn: number, fp: number, fn: number,
 *   tpr: number, tnr: number, balancedAccuracy: number,
 *   positives: number, negatives: number, errors: number
 * }}
 */
export function confusionAtThreshold(rows, threshold) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let errors = 0;
  for (const row of rows) {
    if (row.error || row.score == null || Number.isNaN(row.score)) {
      errors++;
      continue;
    }
    const predictedFake = row.score >= threshold;
    if (row.label === 'fake') {
      if (predictedFake) tp++;
      else fn++;
    } else if (row.label === 'real') {
      if (predictedFake) fp++;
      else tn++;
    }
  }
  const positives = tp + fn;
  const negatives = tn + fp;
  const tpr = positives ? tp / positives : 0;
  const tnr = negatives ? tn / negatives : 0;
  return {
    tp,
    tn,
    fp,
    fn,
    tpr,
    tnr,
    balancedAccuracy: (tpr + tnr) / 2,
    positives,
    negatives,
    errors,
  };
}

/**
 * Wilson score interval for a binomial proportion.
 * @param {number} successes
 * @param {number} total
 * @param {number} z z-value (1.96 for 95%)
 * @returns {[number, number]} [low, high]
 */
export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return [0, 0];
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Balanced accuracy with a 95% CI. The CI is conservative: we take the Wilson interval of the
 * balanced proportion (treating BA as a proportion over positives+negatives balanced draws).
 *
 * @param {Array} rows
 * @param {number} threshold
 */
export function balancedAccuracyWithCi(rows, threshold) {
  const c = confusionAtThreshold(rows, threshold);
  // Approximate CI for BA: propagate per-class CIs (independent classes assumption).
  const [tprLo, tprHi] = wilsonInterval(c.tp, c.positives);
  const [tnrLo, tnrHi] = wilsonInterval(c.tn, c.negatives);
  return {
    ...c,
    ci95: [(tprLo + tnrLo) / 2, (tprHi + tnrHi) / 2],
  };
}

/**
 * Sweep thresholds and return balanced accuracy at each.
 * @param {Array} rows
 * @param {number[]} thresholds
 */
export function thresholdSweep(rows, thresholds) {
  return thresholds.map((t) => ({ threshold: t, ...confusionAtThreshold(rows, t) }));
}

/**
 * Group rows by a key and compute balanced accuracy per group.
 * @param {Array} rows
 * @param {(row) => string} keyFn
 * @param {number} threshold
 */
export function perGroupMetrics(rows, keyFn, threshold) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row) ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const [key, groupRows] of groups) {
    const c = confusionAtThreshold(groupRows, threshold);
    out.push({ group: key, count: groupRows.length, ...c });
  }
  return out.sort((a, b) => b.count - a.count);
}
