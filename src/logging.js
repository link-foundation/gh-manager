/**
 * Console output and on-failure artifacts.
 *
 * Every failure that happens while a browser page is open leaves a screenshot
 * and the page HTML in `<app-dir>/logs/`, so a broken selector can be diagnosed
 * from the artifacts, never guessed at.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Create a logger.
 * @param {Object} [options] - Logger options
 * @param {boolean} [options.verbose] - Emit debug lines
 * @param {(line: string) => void} [options.stdout] - Standard output sink
 * @param {(line: string) => void} [options.stderr] - Standard error sink
 * @returns {{info: Function, warn: Function, error: Function, debug: Function, verbose: boolean}} Logger
 */
export function createLogger({
  verbose = false,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  return {
    verbose,
    info: (message) => stdout(message),
    warn: (message) => stderr(`warning: ${message}`),
    error: (message) => stderr(`error: ${message}`),
    debug: (message) => {
      if (verbose) {
        stderr(`debug: ${message}`);
      }
    },
  };
}

/**
 * Build a filesystem-safe slug for artifact names.
 * @param {string} value - Arbitrary label
 * @returns {string} Slug usable in a file name
 */
export function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'run';
}

/**
 * Timestamp used to order artifacts and log lines.
 * @param {Date} [date] - Instant to format
 * @returns {string} File-name-safe ISO timestamp
 */
export function artifactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Append a structured line to the run log.
 * @param {Object} options - Log options
 * @param {string} options.logsDir - Directory holding run logs
 * @param {Object} options.entry - JSON-serializable entry
 * @returns {string|null} Path of the log file, or null when logging failed
 */
export function appendRunLog({ logsDir, entry }) {
  try {
    mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'runs.log');
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    appendFileSync(logFile, `${line}\n`);
    return logFile;
  } catch {
    return null;
  }
}

/**
 * Capture a screenshot and the page HTML for a failed operation.
 *
 * Artifact capture must never mask the original failure, so every step is
 * best-effort and the collected paths are returned for the error message.
 * @param {Object} options - Capture options
 * @param {string} options.logsDir - Directory to write artifacts into
 * @param {Object} [options.page] - Playwright or Puppeteer page
 * @param {string} options.label - Label describing the failed operation
 * @returns {Promise<string[]>} Paths of the artifacts that were written
 */
export async function captureFailureArtifacts({ logsDir, page, label }) {
  if (!page) {
    return [];
  }

  const written = [];
  const base = path.join(logsDir, `${artifactTimestamp()}-${slugify(label)}`);

  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    return written;
  }

  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    written.push(`${base}.png`);
  } catch {
    // A screenshot can fail if the page or browser is already gone.
  }

  try {
    writeFileSync(`${base}.html`, await page.content());
    written.push(`${base}.html`);
  } catch {
    // Same as above: the page may no longer be reachable.
  }

  return written;
}
