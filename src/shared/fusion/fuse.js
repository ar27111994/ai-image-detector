/**
 * Fusion layer: combines the neural model score with forensic signals into one calibrated
 * AI-probability score and a verdict.
 *
 * Policy:
 *  - Definitive forensic hit (C2PA generative claim, PNG geninfo, XMP DigitalSourceType, EXIF
 *    generator tag) => score 0.99 (provenance is stronger than any classifier).
 *  - Otherwise logistic fusion over [neuralScore, weak forensic features] using coefficients
 *    fitted on public benchmark data (src/shared/fusion/calibration.json). Defaults are
 *    conservative (near-passthrough of the neural score) until calibration is fitted.
 */
import { VERDICT } from '../constants.js';
import { clamp01 } from '../math.js';
import { CALIBRATION } from './calibration.js';

const DEFAULT_THRESHOLD = 0.65;

/**
 * Logistic (Platt-style) calibration of the neural score.
 * p = sigmoid(a * logit(neuralScore) + b)
 * Falls back to identity when calibration is disabled/invalid.
 * @param {number} neuralScore raw model probability in [0,1]
 * @param {{ enabled?: boolean, a?: number, b?: number }} [cal] calibration params (defaults to
 *   the fitted, frozen CALIBRATION)
 * @returns {number} calibrated probability in [0,1]
 */
export function calibrate(neuralScore, cal = CALIBRATION) {
  // Guard against non-finite/NaN scores from a hostile or broken model — clamp to [0,1].
  const s = Number.isFinite(neuralScore) ? clamp01(neuralScore) : 0.5;
  if (!cal?.enabled || typeof cal.a !== 'number' || typeof cal.b !== 'number') return s;
  const logit = Math.log((s + 1e-9) / (1 - s + 1e-9));
  return clamp01(1 / (1 + Math.exp(-(cal.a * logit + cal.b))));
}

/**
 * Fuse neural + forensic signals.
 * @param {{ neuralScore: number, forensic: { definitive: boolean, summary: string[], features: object } }} input
 * @param {{ threshold?: number }} [opts]
 * @returns {{ score: number, verdict: string, reasons: string[] }}
 */
export function fuseSignals({ neuralScore, forensic }, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cal = opts.calibration ?? CALIBRATION;
  const reasons = [...(forensic?.summary ?? [])];

  if (forensic?.definitive) {
    return { score: 0.99, verdict: VERDICT.AI, reasons };
  }

  const calibrated = calibrate(neuralScore, cal);

  // Weak-signal nudge: photographic JPEG with zero camera EXIF slightly raises suspicion;
  // presence of camera EXIF slightly lowers it. Small, bounded, and documented.
  let adjusted = calibrated;
  if (forensic?.features?.hasCameraExif === true) {
    adjusted = clamp01(calibrated * 0.9);
    reasons.push('camera EXIF present');
  } else if (forensic?.features?.hasCameraExif === false && forensic?.features?.format === 'jpeg') {
    adjusted = clamp01(calibrated * 1.05 + 0.01);
    reasons.push('no camera EXIF (weak signal)');
  }

  return { score: adjusted, verdict: verdictFor(adjusted, threshold), reasons };
}

/**
 * Threshold-band verdict: >= threshold AI; < 1-threshold REAL; else UNCERTAIN.
 * @param {number} score calibrated AI probability in [0,1]
 * @param {number} [threshold]
 * @returns {string} one of VERDICT
 */
export function verdictFor(score, threshold = DEFAULT_THRESHOLD) {
  if (score >= threshold) return VERDICT.AI;
  if (score < 1 - threshold) return VERDICT.REAL;
  return VERDICT.UNCERTAIN;
}
