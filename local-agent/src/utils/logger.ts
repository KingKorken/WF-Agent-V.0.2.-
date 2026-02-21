/**
 * Safe Logger — Wraps console.log/warn/error in try-catch blocks.
 *
 * In Electron, writing to stdout can sometimes fail with "Error: write EIO"
 * when the parent terminal closes or the stream is broken. This causes
 * uncaught exceptions that crash the app.
 *
 * This logger silently swallows those I/O errors so logging never
 * takes down the agent process.
 */

export const log = (...args: unknown[]): void => {
  try {
    console.log(...args);
  } catch { /* swallow write EIO and other stdout errors */ }
};

export const warn = (...args: unknown[]): void => {
  try {
    console.warn(...args);
  } catch { /* swallow write EIO and other stdout errors */ }
};

export const error = (...args: unknown[]): void => {
  try {
    console.error(...args);
  } catch { /* swallow write EIO and other stderr errors */ }
};
