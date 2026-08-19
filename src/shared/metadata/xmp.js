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

/** Canonical namespace URIs. A prefix is only trusted when it resolves to one of these. */
const IPTC_NS = 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/';
const XMP_NS = 'http://ns.adobe.com/xap/1.0/';

/**
 * The full controlled-vocabulary URI for a DigitalSourceType value, used to accept the CV-URI form
 * in addition to the bare value.
 * @param {string} dst one of AI_DIGITAL_SOURCE_TYPES
 * @returns {string} the controlled-vocabulary URI for the value
 */
const CV_URI = (dst) => `http://cv.iptc.org/newscodes/digitalsourcetype/${dst}`;

/**
 * Resolve the `xmlns:prefix` bindings declared in an XMP packet, with their positions.
 * @param {string} xml the XMP packet
 * @returns {Array<{ prefix: string, uri: string, index: number }>} bindings in document order
 */
function xmlnsBindings(xml) {
  const out = [];
  // XML permits single- or double-quoted attribute values; capture either with a matching delimiter.
  for (const m of xml.matchAll(/xmlns:([A-Za-z0-9]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out.push({ prefix: m[1], uri: m[2] ?? m[3], index: m.index });
  }
  return out;
}

/**
 * Resolve `prefix` against the bindings in scope at a property. XML namespace declarations are
 * scoped to the element where they appear (and inherited by descendants); we use the most recent
 * declaration at or before the end of the property's own start tag, so a later sibling rebinding a
 * prefix does not change how this property resolves.
 * @param {Array<{ prefix: string, uri: string, index: number }>} bindings positioned declarations
 * @param {string|null} prefix the property's namespace prefix (null when unqualified)
 * @param {string} namespaceUri the canonical namespace URI to require
 * @param {number} scopeEnd index just past the property's own start tag
 * @returns {boolean}
 */
function prefixResolvesTo(bindings, prefix, namespaceUri, scopeEnd) {
  if (prefix == null) return true; // intentionally-supported unqualified form
  // Most recent binding for this prefix declared at or before `scopeEnd` — the end of the
  // property's own start tag — so the element's own xmlns (which may textually follow the
  // attribute within the same `<tag …>`) counts, while a later sibling's rebinding does not.
  let resolved;
  for (const b of bindings) {
    if (b.prefix === prefix && b.index <= scopeEnd) resolved = b.uri;
  }
  return resolved === namespaceUri;
}

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
    const ns = xmlnsBindings(xml);
    // Extract DigitalSourceType only from the exact IPTC property AND only when its prefix resolves
    // to the canonical IPTC namespace. `prefix:(…)` is captured and validated, so a packet that binds
    // Iptc4xmpCore to an unrelated URI, or uses a foreign prefix (ex:DigitalSourceType), is rejected.
    // The extracted value must equal the AI value exactly (or its controlled-vocabulary URI).
    // Attribute form: the property must be a real start-tag attribute (inside a `<tag …>`), so the
    // string can't be matched out of ordinary element text (e.g. a dc:description body). We require
    // a `<tagname` opener somewhere before the attribute on the same tag. Both quote styles allowed.
    const attrRe =
      /<[A-Za-z0-9:]+(?:\s+[A-Za-z0-9:]+\s*=\s*(?:"[^"]*"|'[^']*'))*?\s+(?:([A-Za-z0-9]+):)?(DigitalSourceType)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    const liRe =
      /<(?:([A-Za-z0-9]+):)?(DigitalSourceType)[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?DigitalSourceType>/gi;
    const candidates = [];
    for (const m of xml.matchAll(attrRe)) {
      // Scope = up to the end of this start tag (its `>`), so the element's own xmlns counts.
      const tagEnd = xml.indexOf('>', m.index);
      if (prefixResolvesTo(ns, m[1] ?? null, IPTC_NS, tagEnd)) candidates.push(m[3] ?? m[4]);
    }
    for (const m of xml.matchAll(liRe)) {
      const tagEnd = xml.indexOf('>', m.index);
      if (!prefixResolvesTo(ns, m[1] ?? null, IPTC_NS, tagEnd)) continue;
      // The container's value is the text of its rdf:li item(s).
      for (const li of m[3].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/gi)) candidates.push(li[1]);
    }
    for (const value of candidates) {
      for (const dst of AI_DIGITAL_SOURCE_TYPES) {
        if (isExactDstValue(value, dst)) {
          digitalSourceType = dst;
          signals.push(`xmp:DigitalSourceType=${dst}`);
        }
      }
    }
    // CreatorTool: only the exact `xmp:CreatorTool` property (prefix must resolve to the canonical
    // XMP namespace) or the intentionally-supported unqualified form — a foreign/longer name
    // (ex:CreatorTool, ex:NotCreatorTool) is not the XMP property.
    const ctAttrRe =
      /<[A-Za-z0-9:]+(?:\s+[A-Za-z0-9:]+\s*=\s*(?:"[^"]*"|'[^']*'))*?\s+(?:([A-Za-z0-9]+):)?(CreatorTool)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const m of xml.matchAll(ctAttrRe)) {
      const tagEnd = xml.indexOf('>', m.index);
      if (!prefixResolvesTo(ns, m[1] ?? null, XMP_NS, tagEnd)) continue;
      const tool = (m[3] ?? m[4]).toLowerCase();
      const hit = AI_CREATOR_TOOLS.find((t) => tool.includes(t));
      if (hit) signals.push(`xmp:CreatorTool="${m[3] ?? m[4]}"`);
    }
    // rdf:li style creator tool (exact xmp:CreatorTool element, namespace-validated).
    const ctLiRe = /<(?:([A-Za-z0-9]+):)?(CreatorTool)[^>]*>\s*<rdf:li>([^<]+)<\/rdf:li>/gi;
    for (const m of xml.matchAll(ctLiRe)) {
      const tagEnd = xml.indexOf('>', m.index);
      if (!prefixResolvesTo(ns, m[1] ?? null, XMP_NS, tagEnd)) continue;
      const hit = AI_CREATOR_TOOLS.find((t) => m[3].toLowerCase().includes(t));
      if (hit) signals.push(`xmp:CreatorTool="${m[3]}"`);
    }
  }
  return { hit: signals.length > 0, signals, digitalSourceType };
}
