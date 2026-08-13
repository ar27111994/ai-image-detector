/**
 * MV3 service worker: orchestration only.
 * Phase 1 scaffold: lifecycle logging + ping/pong health check.
 * Phase 2 adds: model download manager, image fetching, offscreen routing, cache.
 */
import { MSG } from '../shared/constants.js';

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[ai-detector] installed:', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.info('[ai-detector] browser startup');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MSG.PING) {
    sendResponse({ type: MSG.PONG, ts: Date.now() });
    return false;
  }
  return false;
});
