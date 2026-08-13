# Forensic/Metadata Signals Research (verified 2026-08-13)

Signal catalog for the non-neural layer. All parsing is local, byte-level, no network.

## Tier 1 (ship in v1 — high precision, low effort)

1. **PNG text chunks** (hand-rolled parser; chunks = len(4BE)+type(4)+data+crc(4)):
   - A1111/Fooocus/Civitai: tEXt/iTXt key `parameters`; value regex
     `/(Steps|Sampler|CFG scale|Seed|Size|Model hash)\s*:/` => AI ~ certain
   - ComfyUI: keys `prompt` / `workflow` (JSON; prompt chunk contains `"class_type":`)
   - NovelAI: `Software`=`NovelAI`; `Comment`=JSON with `uc` key; `Description`=prompt
   - InvokeAI: `invokeai_metadata` / `invokeai_graph` (JSON), legacy `sd-metadata`
   - zTXt/compressed iTXt: inflate via DecompressionStream('deflate')
2. **JPEG EXIF UserComment (0x9286)**: A1111 writes geninfo there for JPEG/WebP
   (`UNICODE\0\0` + UTF-16LE). Same `Steps:/Sampler:` regex => AI.
3. **XMP DigitalSourceType**: raw XMP string contains
   `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`
   (IPTC standard; Adobe/Google/Microsoft/Getty) => AI ~ certain.
4. **EXIF Software / XMP CreatorTool matches**: Midjourney, NovelAI, Adobe Firefly, DALL-E,
   Stable Diffusion, DreamStudio, Playground, Leonardo.AI, Ideogram, Bing Image Creator,
   Microsoft Designer, ImageFX => AI ~ certain.

## Tier 2 (ship in v1 — byte scans, ~0 FP)

5. **C2PA/JUMBF presence + claim_generator scan** (no heavy WASM lib; hand-rolled):
   - JPEG: APP11 `FF EB` segments whose payload starts `4A 50` ("JP"); JUMBF superbox follows;
     manifest store UUID `63 32 6D 61 00 11 00 10 80 00 00 AA 00 38 9B 71` ("c2ma...")
   - PNG: `caBX` chunk; WebP: RIFF chunk `C2PA`; AVIF/BMFF: box `C2PA`
   - Extract printable strings; `claim_generator` ~ Firefly/DALL-E 3/Designer/Bing/ImageFX;
     presence of `c2pa.ai.generative` action or trainedAlgorithmicMedia in claim => AI.
   - (Full validation via @contentauth/c2pa-web rejected for v1: +2-3MB WASM, value-add small.)
6. **Camera-EXIF absence prior** (weak; fusion feature only, never standalone):
   JPEG lacking ALL of Make/Model/ExposureTime/FNumber/ISO/Flash/FocalLength.

## Tier 3 (v1 as fusion features)

7. **JPEG DQT fingerprint**: parse `FF DB` tables; compare vs known Pillow/libjpeg default tables
   at common qualities (AI tools) vs camera-vendor tables. Medium signal; fusion feature.
8. **FFT radial spectrum** (fft.js MIT): 256x256 grayscale center-crop, 2D FFT, 20 log-spaced
   radial energy bins + high-frequency ratio (r>N/4). Weak alone (55-80%), fusion feature only.

## Rejected / infeasible client-side
- Google SynthID (no public decoder), Meta Stable Signature / WAM (neural extractor too heavy),
  SD DWT-DCT invisible watermark (no JS decoder, fragile to re-hosting), double-JPEG DCT histogram
  analysis (CPU-heavy, low value).

## Libraries
- exifr (MIT): EXIF/XMP/IPTC across JPEG/PNG/WebP/AVIF/HEIC; works in SW/offscreen; ~1ms/file.
- fft.js (MIT): 1D FFT composed to 2D; 256x256 2D ~5-15ms.
- DecompressionStream (native): zTXt/iTXt inflate.

## Fusion policy (locked)
- Any Tier-1/Tier-2 DEFINITIVE hit => score 0.99 (still record neural score for display/debug).
- Otherwise calibrated logistic fusion over [neural score(s), exif_absent, dqt_match, fft features]
  fit on internal benchmark train split; coefficients serialized to `src/ensemble/calibration.json`
  with provenance recorded in docs/BENCHMARK.md.
