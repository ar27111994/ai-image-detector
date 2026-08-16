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
 * @param {Array<{label: string, score: number|null, error?: string}>} rows
 * @param {number} threshold
 * @returns {object} confusion stats plus `ci95: [low, high]` (95% Wilson interval on BA)
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
 * @param {Array<{label: string, score: number|null, error?: string}>} rows
 * @param {number[]} thresholds
 * @returns {Array<{ threshold: number } & ReturnType<typeof confusionAtThreshold>>}
 */
export function thresholdSweep(rows, thresholds) {
  return thresholds.map((t) => ({ threshold: t, ...confusionAtThreshold(rows, t) }));
}

/**
 * Expected Calibration Error (ECE): how well predicted probabilities match empirical outcomes.
 * Bins scored samples by confidence, averages |accuracy - meanConfidence| weighted by bin size.
 * Lower is better; 0 = perfectly calibrated. Independent of the decision threshold.
 *
 * @param {Array<{label: string, score: number|null, error?: string}>} rows
 * @param {number} bins number of confidence bins
 * @returns {{ ece: number, bins: Array<{ center: number, accuracy: number, meanConfidence: number, count: number }> }}
 */
export function expectedCalibrationError(rows, bins = 10) {
  const scored = rows.filter((r) => r.score != null && !r.error && !Number.isNaN(r.score));
  if (scored.length === 0) return { ece: 0, bins: [] };

  const buckets = Array.from({ length: bins }, () => ({ sumConf: 0, correct: 0, count: 0 }));
  for (const row of scored) {
    const s = Math.min(1, Math.max(0, row.score));
    // Confidence = strength of the prediction regardless of class: max(p_ai, 1 - p_ai).
    const confidence = Math.max(s, 1 - s);
    const b = Math.min(bins - 1, Math.floor(confidence * bins));
    const predFake = s >= 0.5;
    const isCorrect = (predFake && row.label === 'fake') || (!predFake && row.label === 'real');
    buckets[b].sumConf += confidence;
    if (isCorrect) buckets[b].correct++;
    buckets[b].count++;
  }

  let ece = 0;
  const outBins = [];
  for (let i = 0; i < bins; i++) {
    const { sumConf, correct, count } = buckets[i];
    if (count === 0) continue;
    const meanConfidence = sumConf / count;
    const accuracy = correct / count;
    ece += (count / scored.length) * Math.abs(accuracy - meanConfidence);
    outBins.push({ center: (i + 0.5) / bins, accuracy, meanConfidence, count });
  }
  return { ece, bins: outBins };
}

/**
 * Group rows by a key and compute balanced accuracy per group (sorted by group size, desc).
 * @param {Array<{label: string, score: number|null, error?: string}>} rows
 * @param {(row: object) => string} keyFn
 * @param {number} threshold
 * @returns {Array<{ group: string, count: number } & ReturnType<typeof confusionAtThreshold>>}
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
