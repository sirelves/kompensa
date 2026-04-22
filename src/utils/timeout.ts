import { StepTimeoutError } from '../errors.js';

/**
 * Race a promise against a timeout and an optional abort signal. Aborts the
 * internal controller to propagate cancellation to the step if it observes it.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stepName: string,
): Promise<T> {
  if (ms <= 0 || !Number.isFinite(ms)) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StepTimeoutError(stepName, ms));
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
