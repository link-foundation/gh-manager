/**
 * The organization settings cache.
 *
 * The behaviour worth guarding is that a cached entry is only ever a hint: a
 * miss, an unreadable file, and an expired entry all fall back to reading the
 * page, and a settings change forgets what was cached.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'test-anywhere';

import { createLogger } from '../src/logging.js';
import {
  cacheFile,
  createOrgSettingsCache,
  formatSettings,
  parseSettings,
} from '../src/org/settings-cache.js';

const log = createLogger({
  verbose: false,
  stdout: () => {},
  stderr: () => {},
});

/**
 * Build a cache over a throwaway application directory.
 * @param {Object} [options] - Cache options
 * @param {number} [options.ttlSeconds] - Entry lifetime
 * @param {number} [options.at] - Fixed clock, in epoch seconds
 * @returns {{cache: Object, appDir: string}} Cache and its directory
 */
function cacheIn({ ttlSeconds = 3600, at = 1_757_222_400 } = {}) {
  const appDir = mkdtempSync(path.join(tmpdir(), 'gh-manager-cache-'));
  const cache = createOrgSettingsCache({
    appDir,
    log,
    ttlSeconds,
    now: () => at,
  });

  return { cache, appDir };
}

describe('formatSettings and parseSettings', () => {
  it('round-trips through links notation', () => {
    const entry = {
      org: 'link-foundation',
      fetchedAt: 1_757_222_400,
      containers: { public: true, private: true, internal: false },
    };

    const parsed = parseSettings(formatSettings(entry));

    expect(parsed.org).toBe('link-foundation');
    expect(parsed.fetchedAt).toBe(1_757_222_400);
    expect(parsed.containers).toEqual({
      public: true,
      private: true,
      internal: false,
    });
  });

  it('writes a timestamp links notation can hold', () => {
    // `:` delimits a link, so an ISO 8601 timestamp cannot be a bare value.
    // Epoch seconds are used instead, and must survive the parser.
    const document = formatSettings({
      org: 'link-foundation',
      fetchedAt: 1_757_222_400.9,
      containers: { public: true },
    });

    expect(document).toContain('(fetchedAt: 1757222400)');
    expect(parseSettings(document).fetchedAt).toBe(1_757_222_400);
  });
});

describe('createOrgSettingsCache', () => {
  it('reports a miss when nothing was ever cached', () => {
    const { cache } = cacheIn();
    expect(cache.read('link-foundation')).toBe(null);
  });

  it('reads back what it wrote', () => {
    const { cache } = cacheIn();

    cache.write('link-foundation', { public: true, private: true });

    expect(cache.read('link-foundation').containers).toEqual({
      public: true,
      private: true,
      internal: false,
    });
  });

  it('treats an expired entry as a miss', () => {
    const { cache, appDir } = cacheIn({ ttlSeconds: 60, at: 1_757_222_400 });

    cache.write('link-foundation', { public: true });

    const later = createOrgSettingsCache({
      appDir,
      log,
      ttlSeconds: 60,
      now: () => 1_757_222_400 + 61,
    });

    expect(later.read('link-foundation')).toBe(null);
  });

  it('treats an unreadable file as a miss rather than an error', () => {
    // A hand-edited or truncated cache must never take a run down: the page is
    // still there to be read.
    const { cache, appDir } = cacheIn();

    mkdirSync(path.dirname(cacheFile(appDir, 'link-foundation')), {
      recursive: true,
    });
    writeFileSync(cacheFile(appDir, 'link-foundation'), '(((not lino', 'utf8');

    expect(cache.read('link-foundation')).toBe(null);
  });

  it('forgets an entry once the setting has been changed', () => {
    const { cache } = cacheIn();

    cache.write('link-foundation', { public: false });
    cache.invalidate('link-foundation');

    expect(cache.read('link-foundation')).toBe(null);
  });

  it('keeps each organization separate', () => {
    const { cache, appDir } = cacheIn();

    cache.write('link-foundation', { public: true });
    cache.write('other-org', { public: false });

    expect(cache.read('link-foundation').containers.public).toBe(true);
    expect(cache.read('other-org').containers.public).toBe(false);
    expect(readFileSync(cacheFile(appDir, 'other-org'), 'utf8')).toContain(
      '(org: other-org)'
    );
  });
});
