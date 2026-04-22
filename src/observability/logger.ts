import type { Logger } from '../types.js';

/** Discards all log output. Default when the user configures no logger. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/** Minimal console-backed logger, useful for local debugging. */
export const consoleLogger: Logger = {
  debug(msg, meta) {
    // eslint-disable-next-line no-console
    console.debug(`[flowguard] ${msg}`, meta ?? '');
  },
  info(msg, meta) {
    // eslint-disable-next-line no-console
    console.info(`[flowguard] ${msg}`, meta ?? '');
  },
  warn(msg, meta) {
    // eslint-disable-next-line no-console
    console.warn(`[flowguard] ${msg}`, meta ?? '');
  },
  error(msg, meta) {
    // eslint-disable-next-line no-console
    console.error(`[flowguard] ${msg}`, meta ?? '');
  },
  child(meta) {
    return {
      debug(m, x) {
        consoleLogger.debug(m, { ...meta, ...x });
      },
      info(m, x) {
        consoleLogger.info(m, { ...meta, ...x });
      },
      warn(m, x) {
        consoleLogger.warn(m, { ...meta, ...x });
      },
      error(m, x) {
        consoleLogger.error(m, { ...meta, ...x });
      },
    };
  },
};
