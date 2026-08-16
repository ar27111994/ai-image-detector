/**
 * Typed message protocol between extension contexts (content script, service worker,
 * offscreen document). All messages are plain JSON-serializable objects.
 *
 * Envelope: { id, type, target, payload }
 *   id      unique request id (uuid-ish); responses echo it
 *   type    one of MSG
 *   target  'offscreen' | 'background' | 'content' | null (broadcast)
 *   payload message-specific data
 *
 * Responses: { id, ok, result?, error? } where error is { message, code }.
 */
import { TIMEOUTS } from './constants.js';

let counter = 0;

/**
 * Generate a collision-safe request id (time + counter + random, no crypto needed).
 * @param {string} [prefix]
 * @returns {string} unique request id
 */
export function nextId(prefix = 'req') {
  counter = (counter + 1) % 0xffff;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(
    Math.random() * 0xffff,
  ).toString(36)}`;
}

/**
 * Build a request envelope.
 * @param {string} type one of MSG
 * @param {object} payload message-specific data
 * @param {string|null} target 'offscreen' | 'background' | 'content' | null (broadcast)
 * @returns {{ id: string, type: string, target: string|null, payload: object }}
 */
export function makeRequest(type, payload = {}, target = null) {
  return { id: nextId(type), type, target, payload };
}

/**
 * Build a success response envelope echoing the request id.
 * @param {object} request
 * @param {*} result
 * @returns {{ id: string, ok: true, result: * }}
 */
export function makeOk(request, result) {
  return { id: request?.id, ok: true, result };
}

/**
 * Build an error response envelope echoing the request id.
 * @param {object} request
 * @param {string} message
 * @param {string} [code]
 * @returns {{ id: string, ok: false, error: { message: string, code: string } }}
 */
export function makeError(request, message, code = 'INTERNAL') {
  return { id: request?.id, ok: false, error: { message: String(message), code } };
}

/**
 * True if `msg` is a well-formed request envelope.
 * @param {*} msg
 * @returns {boolean}
 */
export function isRequest(msg) {
  return (
    msg != null &&
    typeof msg === 'object' &&
    typeof msg.id === 'string' &&
    typeof msg.type === 'string' &&
    'payload' in msg
  );
}

/**
 * True if `msg` is a well-formed response envelope.
 * @param {*} msg
 * @returns {boolean}
 */
export function isResponse(msg) {
  return msg != null && typeof msg === 'object' && typeof msg.ok === 'boolean' && 'id' in msg;
}

/**
 * Promise wrapper around chrome.runtime.sendMessage with a timeout.
 * Rejects with { code: 'TIMEOUT' } after timeoutMs.
 *
 * @param {object} message
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>} the response envelope
 */
export async function sendRequest(message, { timeoutMs = TIMEOUTS.MESSAGE_MS } = {}) {
  return await withTimeout(chrome.runtime.sendMessage(message), timeoutMs, message.type);
}

/**
 * Wrap a promise with a timeout. Rejects { code:'TIMEOUT' } on expiry.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms timeout in milliseconds
 * @param {string} label used in the timeout error message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Register a chrome.runtime.onMessage listener that dispatches request envelopes to `handlers`
 * keyed by message type. Handlers may be sync or async; returning a Promise keeps the message
 * channel open. Unknown types are ignored (return false) so other listeners can handle them.
 *
 * @param {Record<string, (payload:object, sender:object, request:object) => Promise<*>|*>} handlers
 * @param {{ targetFilter?: string }} [opts] only handle messages whose target matches
 */
export function registerHandler(handlers, { targetFilter = undefined } = {}) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRequest(message)) return false;
    if (targetFilter !== undefined && message.target !== targetFilter) return false;
    const handler = handlers[message.type];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(message.payload, sender, message))
      .then((result) => sendResponse(makeOk(message, result)))
      .catch((err) => sendResponse(makeError(message, err?.message ?? String(err), err?.code)));
    return true; // async response
  });
}
