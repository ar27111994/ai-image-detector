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

let counter = 0;

/** Generate a collision-safe request id (time + counter + random, no crypto needed). */
export function nextId(prefix = 'req') {
  counter = (counter + 1) % 0xffff;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(
    Math.random() * 0xffff,
  ).toString(36)}`;
}

/** @param {string} type @param {object} payload @param {string|null} target */
export function makeRequest(type, payload = {}, target = null) {
  return { id: nextId(type), type, target, payload };
}

/** @param {object} request @param {*} result */
export function makeOk(request, result) {
  return { id: request?.id, ok: true, result };
}

/** @param {object} request @param {string} message @param {string} [code] */
export function makeError(request, message, code = 'INTERNAL') {
  return { id: request?.id, ok: false, error: { message: String(message), code } };
}

/** True if `msg` is a well-formed request envelope. */
export function isRequest(msg) {
  return (
    msg != null &&
    typeof msg === 'object' &&
    typeof msg.id === 'string' &&
    typeof msg.type === 'string' &&
    'payload' in msg
  );
}

/** True if `msg` is a well-formed response envelope. */
export function isResponse(msg) {
  return msg != null && typeof msg === 'object' && typeof msg.ok === 'boolean' && 'id' in msg;
}

/**
 * Promise wrapper around chrome.runtime.sendMessage with a timeout.
 * Rejects with { code: 'TIMEOUT' } after timeoutMs.
 *
 * @param {object} message
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function sendRequest(message, { timeoutMs = 120000 } = {}) {
  return await withTimeout(chrome.runtime.sendMessage(message), timeoutMs, message.type);
}

/**
 * Wrap a promise with a timeout. Rejects { code:'TIMEOUT' } on expiry.
 * @param {Promise} promise @param {number} ms @param {string} label
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
