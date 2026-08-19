# Phase 1 — Task 4: Model evaluation, selection & manifest lock

## Objective

Run the full internal benchmark (~800+ images: OpenFakeTiny + diffusiondb + COCO, plus augmented
splits) across all candidate models/variants; pick the production model (or 2-model ensemble) by
balanced accuracy @ 0.65 with robustness on augmented splits; lock `models/manifest.json`
(production URLs + SHA-256 + input spec); record everything in docs/BENCHMARK.md.

## Steps

1. Assemble dataset: 400 real (COCO 250 + OpenFake real 150) + 400 AI (OpenFake spread across
   modern generators 250 + diffusiondb SD1.x 150); fixed seed 1337; 50/50 stratified train/test.
2. Run candidates A(fp32/int8), B(fp32/int8), C(fp32/int8-if-feasible) on raw split; record
   per-image scores.
3. Repeat on augmented split (JPEG q70, q85, resize50) for robustness table.
4. Evaluate single models + pairwise/triple mean-score ensembles; pick winner by test-split
   balanced accuracy @ 0.65 (train split reserved for Phase 4 calibration fit; report both).
5. Write `docs/BENCHMARK.md` (methodology, sources, per-generator table, chosen model rationale)
   and final `models/manifest.json`.
6. Update STATE.md + 01-4-SUMMARY.md with the selection and numbers.

## Verification

- `npm run bench` reproduces the metrics table from cache; chosen model beats the 80% internal
  gate @ 0.65 on the test split (if not: escalate with data — consider ensemble or alternate
  candidate before Phase 2).

## Done When

- manifest.json locked; BENCHMARK.md committed; selection decision recorded with numbers.

## Parallel: no (needs 01-2 + 01-3)

## Estimated Complexity: medium
