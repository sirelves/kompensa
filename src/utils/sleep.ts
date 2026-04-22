import { FlowAbortedError } from '../errors.js';

/**
 * Promise-based sleep that respects an AbortSignal. Rejects with
 * FlowAbortedError if the signal fires mid-wait.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new FlowAbortedError(signal.reason));
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FlowAbortedError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new FlowAbortedError(signal?.reason));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
