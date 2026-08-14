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

/** Extract raw XMP XML strings from image bytes (JPEG APP1 and/or WebP XMP chunk). */
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
    for (const dst of AI_DIGITAL_SOURCE_TYPES) {
      if (xml.includes(dst)) {
        digitalSourceType = dst;
        signals.push(`xmp:DigitalSourceType=${dst}`);
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
