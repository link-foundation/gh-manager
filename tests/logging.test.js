/**
 * Console output and the artifacts a failed run leaves behind.
 *
 * The artifacts are what a broken selector is diagnosed from, so the names
 * they get and the fact that collecting them never throws are both part of the
 * contract, not incidental behaviour.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'test-anywhere';

import {
  appendRunLog,
  artifactTimestamp,
  captureFailureArtifacts,
  createLogger,
  slugify,
} from '../src/logging.js';

/**
 * Create an empty directory for one test.
 * @returns {string} Directory path
 */
function makeLogsDir() {
  return mkdtempSync(join(tmpdir(), 'gh-manager-logs-'));
}

describe('slugify', () => {
  it('keeps a label readable in a file name', () => {
    expect(slugify('Set visibility of box-dind')).toBe(
      'set-visibility-of-box-dind'
    );
  });

  it('collapses punctuation and trims the ends', () => {
    expect(slugify('  @link-foundation/box:latest  ')).toBe(
      'link-foundation-box-latest'
    );
  });

  it('names a label with nothing usable in it', () => {
    expect(slugify('///')).toBe('run');
    expect(slugify('')).toBe('run');
  });

  it('trims a long run of separators', () => {
    expect(slugify(`box${'-'.repeat(200000)}`)).toBe('box');
  });
});

describe('artifactTimestamp', () => {
  it('orders artifacts by name and stays file-name safe', () => {
    const stamp = artifactTimestamp(new Date('2026-09-06T21:52:17.123Z'));

    expect(stamp).toBe('2026-09-06T21-52-17-123Z');
    expect(/[:.]/.test(stamp)).toBe(false);
  });
});

describe('appendRunLog', () => {
  it('appends one JSON object per run', () => {
    const logsDir = makeLogsDir();

    const logFile = appendRunLog({ logsDir, entry: { command: 'first' } });
    appendRunLog({ logsDir, entry: { command: 'second' } });

    const lines = readFileSync(logFile, 'utf8').trim().split('\n');

    expect(lines.length).toBe(2);
    expect(lines.map((line) => JSON.parse(line).command)).toEqual([
      'first',
      'second',
    ]);
    expect(typeof JSON.parse(lines[0]).time).toBe('string');
  });

  it('reports a directory it cannot write to as no log at all', () => {
    const root = makeLogsDir();
    writeFileSync(join(root, 'logs'), 'not a directory');

    expect(appendRunLog({ logsDir: join(root, 'logs'), entry: {} })).toBe(null);
  });
});

describe('captureFailureArtifacts', () => {
  it('writes a screenshot and the page HTML next to each other', async () => {
    const logsDir = makeLogsDir();
    const shots = [];

    const written = await captureFailureArtifacts({
      logsDir,
      label: 'Delete box-dind',
      page: {
        screenshot: async ({ path }) => shots.push(path),
        content: async () => '<html>failed</html>',
      },
    });

    expect(written.length).toBe(2);
    expect(shots).toEqual([written[0]]);
    expect(written[0].endsWith('-delete-box-dind.png')).toBe(true);
    expect(readFileSync(written[1], 'utf8')).toBe('<html>failed</html>');
  });

  it('never masks the failure it was called for', async () => {
    const logsDir = makeLogsDir();

    const written = await captureFailureArtifacts({
      logsDir,
      label: 'gone',
      page: {
        screenshot: async () => {
          throw new Error('Target page, context or browser has been closed');
        },
        content: async () => {
          throw new Error('Target page, context or browser has been closed');
        },
      },
    });

    expect(written).toEqual([]);
  });

  it('has nothing to capture when no page was open', async () => {
    expect(await captureFailureArtifacts({ logsDir: '/nowhere' })).toEqual([]);
  });
});

describe('createLogger', () => {
  it('separates results from diagnostics', () => {
    const out = [];
    const err = [];
    const log = createLogger({
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    log.info('box is public');
    log.warn('the API cannot see this package');
    log.error('the change was not confirmed');
    log.debug('opening the settings page');

    expect(out).toEqual(['box is public']);
    expect(err).toEqual([
      'warning: the API cannot see this package',
      'error: the change was not confirmed',
    ]);
  });

  it('emits debug lines only when asked to', () => {
    const err = [];
    const log = createLogger({
      verbose: true,
      stderr: (line) => err.push(line),
    });

    log.debug('opening the settings page');

    expect(err).toEqual(['debug: opening the settings page']);
  });
});
