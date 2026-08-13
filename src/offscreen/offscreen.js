/**
 * Offscreen document entry: owns the ONNX Runtime inference session(s).
 * Phase 1 scaffold: responds to ping so e2e can verify the document is alive.
 * Phase 2 adds: ORT session management, preprocessing, forensic analysis.
 */
import { MSG } from '../shared/constants.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (message?.type === MSG.PING) {
    sendResponse({ type: MSG.PONG, context: 'offscreen', ts: Date.now() });
    return false;
  }
  return false;
});
