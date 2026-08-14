/**
 * Platt/logistic calibration for the neural score, fitted on the internal public benchmark
 * (train split only — never on the bounty evaluation set). p = sigmoid(a * logit(score) + b).
 *
 * `enabled: false` = identity passthrough (pre-fitting default). Phase 4 fits a/b and flips
 * enabled to true, recording provenance below.
 */
export const CALIBRATION = Object.freeze({
  enabled: false,
  a: 1.0,
  b: 0.0,
  fittedOn: null,
  trainSize: null,
});
