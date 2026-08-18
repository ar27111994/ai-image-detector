/**
 * XMP packet extraction and AI-provenance detection.
 *
 * XMP appears as a JPEG APP1 segment ("http://ns.adobe.com/xap/1.0/\0" + XML) and as a WebP
 * 'XMP ' chunk. The canonical AI signals are IPTC DigitalSourceType values and known
 * xmp:CreatorTool strings.
 */
import { parseJpegSegments, parseWebpChunks } from './containers.js';

const XMP_JPEG_PREFIX = 'http://ns.adobe.com/xap/1.0/';

/** IPTC DigitalSourceType values that indicate generative-AI content. */
const AI_DIGITAL_SOURCE_TYPES = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia'];

/**
 * IPTC namespace prefix for the DigitalSourceType property. Only `Iptc4xmpCore:` (the canonical
 * IPTC Photo Metadata namespace) or the intentionally-supported unqualified `DigitalSourceType`
 * are accepted — a foreign namespace (e.g. `ex:DigitalSourceType`) is NOT the IPTC property.
 */
const DST_PROPERTY = '(?:Iptc4xmpCore:)?DigitalSourceType';

/**
 * The full controlled-vocabulary URI for a DigitalSourceType value, used to accept the CV-URI form
 * in addition to the bare value.
 * @param {string} dst one of AI_DIGITAL_SOURCE_TYPES
 * @returns {string} the controlled-vocabulary URI for the value
 */
const CV_URI = (dst) => `http://cv.iptc.org/newscodes/digitalsourcetype/${dst}`;

/**
 * True when `value` is exactly the AI DigitalSourceType value `dst` — the bare value, or the exact
 * controlled-vocabulary URI for it. Substrings (e.g. "nottrainedAlgorithmicMedia") are rejected.
 * @param {string} value the extracted DigitalSourceType value
 * @param {string} dst one of AI_DIGITAL_SOURCE_TYPES
 * @returns {boolean}
 */
function isExactDstValue(value, dst) {
  const v = value.trim();
  return v === dst || v === CV_URI(dst);
}

const AI_CREATOR_TOOLS = [
  'midjourney',
  'adobe firefly',
  'dall-e',
  'dalle',
  'stable diffusion',
  'microsoft designer',
  'bing image creator',
  'imagefx',
  'ideogram',
  'leonardo',
  'novelai',
  'dreamstudio',
];

/**
 * Extract raw XMP XML strings from image bytes (JPEG APP1 and/or WebP XMP chunk).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} format 'jpeg' | 'webp' (others yield [])
 * @returns {string[]} raw XMP XML packet strings
 */
export function extractXmpPackets(buffer, format) {
  const packets = [];
  if (format === 'jpeg') {
    for (const seg of parseJpegSegments(buffer)) {
      if (seg.marker !== 0xe1) continue;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(seg.data);
      if (text.startsWith(XMP_JPEG_PREFIX)) {
        let body = text.slice(XMP_JPEG_PREFIX.length);
        while (body.length && body.charCodeAt(0) === 0) body = body.slice(1);
        packets.push(body);
      }
    }
  } else if (format === 'webp') {
    for (const chunk of parseWebpChunks(buffer)) {
      if (chunk.fourcc === 'XMP ') {
        packets.push(new TextDecoder('utf-8', { fatal: false }).decode(chunk.data));
      }
    }
  }
  return packets;
}

/**
 * Detect AI-provenance signals inside XMP XML strings.
 * @param {string[]} packets
 * @returns {{ hit: boolean, signals: string[], digitalSourceType: string|null }}
 */
export function detectXmpAiSignatures(packets) {
  const signals = [];
  let digitalSourceType = null;
  for (const xml of packets) {
    // Extract DigitalSourceType only from the exact IPTC property: the qualified
    // `Iptc4xmpCore:DigitalSourceType` or the intentionally-supported unqualified `DigitalSourceType`.
    // A foreign namespace (ex:DigitalSourceType) or a longer name ending in DigitalSourceType
    // (ex:NotDigitalSourceType) is NOT the IPTC property, and a bare occurrence in an unrelated
    // description/comment is not a claim. The extracted value must equal the AI value exactly
    // (or its controlled-vocabulary URI) — substrings like "nottrainedAlgorithmicMedia" are rejected.
    const attrRe = new RegExp(`(?:^|[\\s<])${DST_PROPERTY}\\s*=\\s*"([^"]*)"`, 'gi');
    const liRe = new RegExp(`<${DST_PROPERTY}[^>]*>([\\s\\S]*?)<\\/${DST_PROPERTY}>`, 'gi');
    const candidates = [];
    for (const m of xml.matchAll(attrRe)) candidates.push(m[1]);
    for (const m of xml.matchAll(liRe)) {
      // The container's value is the text of its rdf:li item(s).
      for (const li of m[1].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/gi)) candidates.push(li[1]);
    }
    for (const value of candidates) {
      for (const dst of AI_DIGITAL_SOURCE_TYPES) {
        if (isExactDstValue(value, dst)) {
          digitalSourceType = dst;
          signals.push(`xmp:DigitalSourceType=${dst}`);
        }
      }
    }
    const lower = xml.toLowerCase();
    const creatorMatch = lower.match(/creatortool\s*=\s*"([^"]+)"/);
    if (creatorMatch) {
      const tool = creatorMatch[1].toLowerCase();
      const hit = AI_CREATOR_TOOLS.find((t) => tool.includes(t));
      if (hit) signals.push(`xmp:CreatorTool="${creatorMatch[1]}"`);
    }
    // rdf:li style creator tool
    const liMatch = lower.match(/<xmp:creatortool>\s*<rdf:li>([^<]+)<\/rdf:li>/);
    if (liMatch) {
      const hit = AI_CREATOR_TOOLS.find((t) => liMatch[1].toLowerCase().includes(t));
      if (hit) signals.push(`xmp:CreatorTool="${liMatch[1]}"`);
    }
  }
  return { hit: signals.length > 0, signals, digitalSourceType };
}
