/**
 * XMP packet extraction and AI-provenance detection.
 *
 * XMP appears as a JPEG APP1 segment ("http://ns.adobe.com/xap/1.0/\0" + XML) and as a WebP
 * 'XMP ' chunk. The canonical AI signals are IPTC DigitalSourceType values and known
 * xmp:CreatorTool strings.
 */
import { DOMParser } from 'linkedom';
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
  const parser = new DOMParser();
  for (const xml of packets) {
    // Namespace-aware parse: a real XML parser resolves each property's namespace in its element
    // scope (a later sibling rebinding a prefix does not affect an earlier property) and handles
    // quoted attribute values correctly (a literal `>` inside a value doesn't end the tag). This
    // replaces the regex matcher, which could not model element-scoped namespaces.
    let doc;
    try {
      doc = parser.parseFromString(xml, 'text/xml');
    } catch {
      continue; // malformed XML — no XMP signal
    }
    if (!doc || doc.querySelector('parsererror')) continue;

    // Walk the parsed tree with an element-scoped namespace stack (linkedom parses structure but
    // does not resolve namespaces). Each element inherits its ancestors' bindings and may add/
    // override its own; attributes without a prefix are unqualified (no namespace), and a prefixed
    // name resolves against the in-scope bindings. This models XML namespace scoping correctly.
    const walk = (el, scope) => {
      const local = new Map(scope);
      let defaultNs = scope.get('') ?? null; // inherit the ancestor default namespace
      for (const a of el.attributes ?? []) {
        if (a.name === 'xmlns') {
          // An empty xmlns="" RESETS the default namespace to "no namespace" (null), per XML
          // Namespaces — it must not linger as an empty string (which fails the ns===null check).
          defaultNs = a.value === '' ? null : a.value;
        } else if (a.name.startsWith('xmlns:')) local.set(a.name.slice(6), a.value);
      }
      local.set('', defaultNs); // propagate the (possibly overridden) default ns to children
      // Per XML Namespaces: the DEFAULT namespace applies to unprefixed ELEMENT names, never to
      // unprefixed ATTRIBUTES. Resolve the two differently.
      const resolveElement = (prefixedName) => {
        const colon = prefixedName.indexOf(':');
        if (colon === -1) {
          // Unprefixed element: its namespace is the in-scope DEFAULT namespace (a foreign default
          // makes this foreign — not namespace-free IPTC).
          return { local: prefixedName, ns: defaultNs ?? null };
        }
        const prefix = prefixedName.slice(0, colon);
        // A prefixed name whose prefix is NOT declared in scope is foreign — mark it so it is
        // rejected (do not fall back to "unqualified"). Only a prefix that resolves to the
        // canonical namespace (or no prefix at all) is trusted.
        const uri = local.get(prefix);
        return { local: prefixedName.slice(colon + 1), ns: uri ?? 'foreign' };
      };
      const resolveAttribute = (name) => {
        const colon = name.indexOf(':');
        if (colon === -1) {
          // Unprefixed attribute: always namespace-less (default ns does NOT apply to attributes).
          return { local: name, ns: null };
        }
        const prefix = name.slice(0, colon);
        const uri = local.get(prefix);
        return { local: name.slice(colon + 1), ns: uri ?? 'foreign' };
      };
      for (const a of el.attributes ?? []) {
        if (a.name.startsWith('xmlns')) continue;
        const { local, ns } = resolveAttribute(a.name);
        if (local === 'DigitalSourceType' && (ns === null || ns === IPTC_NS)) {
          for (const dst of AI_DIGITAL_SOURCE_TYPES) {
            if (isExactDstValue(a.value, dst)) {
              digitalSourceType = dst;
              signals.push(`xmp:DigitalSourceType=${dst}`);
            }
          }
        }
        if (local === 'CreatorTool' && (ns === null || ns === XMP_NS)) {
          const tool = a.value.toLowerCase();
          const hit = AI_CREATOR_TOOLS.find((t) => tool.includes(t));
          if (hit) signals.push(`xmp:CreatorTool="${a.value}"`);
        }
      }
      // Element form: a DigitalSourceType/CreatorTool element in the right namespace (default ns
      // applies to unprefixed element names).
      const self = resolveElement(el.tagName ?? '');
      if (self.local === 'DigitalSourceType' && (self.ns === null || self.ns === IPTC_NS)) {
        const value = el.textContent.trim();
        for (const dst of AI_DIGITAL_SOURCE_TYPES) {
          if (isExactDstValue(value, dst)) {
            digitalSourceType = dst;
            signals.push(`xmp:DigitalSourceType=${dst}`);
          }
        }
      }
      if (self.local === 'CreatorTool' && (self.ns === null || self.ns === XMP_NS)) {
        const tool = el.textContent.toLowerCase();
        const hit = AI_CREATOR_TOOLS.find((t) => tool.includes(t));
        if (hit) signals.push(`xmp:CreatorTool="${el.textContent}"`);
      }
      for (const child of el.children ?? []) walk(child, local);
    };
    walk(doc.documentElement, new Map());
  }
  return { hit: signals.length > 0, signals, digitalSourceType };
}
