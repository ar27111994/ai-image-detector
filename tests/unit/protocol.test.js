import { describe, expect, it, vi } from 'vitest';
import {
  isRequest,
  isResponse,
  makeError,
  makeOk,
  makeRequest,
  nextId,
  registerHandler,
  sendRequest,
  withTimeout,
} from '../../src/shared/protocol.js';

describe('protocol', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => nextId()));
    expect(ids.size).toBe(1000);
  });

  it('builds well-formed request envelopes', () => {
    const req = makeRequest('analyze', { url: 'x' }, 'offscreen');
    expect(isRequest(req)).toBe(true);
    expect(req.type).toBe('analyze');
    expect(req.target).toBe('offscreen');
    expect(req.payload).toEqual({ url: 'x' });
  });

  it('builds ok/error responses that round-trip the id', () => {
    const req = makeRequest('t', {});
    const ok = makeOk(req, { score: 0.9 });
    expect(isResponse(ok)).toBe(true);
    expect(ok.id).toBe(req.id);
    expect(ok.result.score).toBe(0.9);
    const err = makeError(req, 'boom', 'BAD_INPUT');
    expect(isResponse(err)).toBe(true);
    expect(err.error.code).toBe('BAD_INPUT');
  });

  it('rejects malformed messages', () => {
    expect(isRequest(null)).toBe(false);
    expect(isRequest({})).toBe(false);
    expect(isRequest({ id: 1, type: 'x', payload: {} })).toBe(false);
    expect(isResponse({ id: 'x' })).toBe(false);
  });

  it('withTimeout resolves before deadline', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
  });

  it('withTimeout rejects after deadline with TIMEOUT code', async () => {
    const slow = new Promise((r) => setTimeout(r, 200));
    await expect(withTimeout(slow, 20, 'test-op')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('withTimeout propagates underlying rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 100)).rejects.toThrow('nope');
  });
});

describe('protocol.registerHandler + sendRequest', () => {
  it('dispatches by type and returns ok response', async () => {
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: vi.fn(async (msg) => {
          // simulate the round trip through the registered listener
          for (const fn of listeners) {
            let responded = null;
            const isAsync = fn(msg, {}, (r) => (responded = r));
            if (isAsync) {
              await new Promise((r) => setTimeout(r, 10));
              if (responded) return responded;
            }
          }
          return undefined;
        }),
      },
    };
    registerHandler({ ping: async () => ({ pong: true }) });
    const res = await sendRequest(makeRequest('ping', {}, null));
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ pong: true });
  });

  it('returns an error response when the handler throws', async () => {
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: vi.fn(async (msg) => {
          for (const fn of listeners) {
            let responded = null;
            if (fn(msg, {}, (r) => (responded = r))) {
              await new Promise((r) => setTimeout(r, 10));
              return responded;
            }
          }
          return undefined;
        }),
      },
    };
    registerHandler({
      boom: async () => {
        throw new Error('kaboom');
      },
    });
    const res = await sendRequest(makeRequest('boom', {}, null));
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('kaboom');
  });

  it('ignores messages with no matching handler', () => {
    const listeners = [];
    globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } };
    registerHandler({ a: () => 1 });
    const fn = listeners[0];
    const responded = [];
    const isAsync = fn(makeRequest('unhandled', {}, null), {}, (r) => responded.push(r));
    expect(isAsync).toBe(false);
    expect(responded).toEqual([]);
  });

  it('respects targetFilter', () => {
    const listeners = [];
    globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } };
    registerHandler({ a: () => 1 }, { targetFilter: 'offscreen' });
    const fn = listeners[0];
    // wrong target -> ignored
    expect(fn(makeRequest('a', {}, 'background'), {}, () => {})).toBe(false);
    // matching target -> handled (async)
    const responded = [];
    const isAsync = fn(makeRequest('a', {}, 'offscreen'), {}, (r) => responded.push(r));
    expect(isAsync).toBe(true);
  });
});
