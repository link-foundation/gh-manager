/**
 * The application directory and the settings that come out of it.
 */

import { describe, it, expect } from 'test-anywhere';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_CONFIG,
  appPaths,
  ensureAppDir,
  loadStoredConfig,
  resolveAppDir,
  resolveOwner,
  resolveSettings,
  saveStoredConfig,
  writeStoredConfig,
} from '../src/config.js';
import { EXIT_CODES } from '../src/exit-codes.js';

/**
 * Create an empty directory that acts as a home or application directory.
 * @returns {string} Path of the directory
 */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'gh-manager-config-'));
}

/**
 * Run a callback with a throwaway directory and always clean it up.
 * @param {(dir: string) => void} callback - Work to run
 * @returns {void}
 */
function withTempDir(callback) {
  const dir = makeTempDir();

  try {
    callback(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe('application directory', () => {
  it('defaults to ~/.gh-manager', () => {
    expect(resolveAppDir({ env: {}, home: '/home/example' })).toBe(
      resolve(join('/home/example', '.gh-manager'))
    );
  });

  it('honours GH_MANAGER_HOME and --app-dir, in that order of precedence', () => {
    expect(
      resolveAppDir({ env: { GH_MANAGER_HOME: '/srv/gh' }, home: '/home/x' })
    ).toBe(resolve('/srv/gh'));
    expect(
      resolveAppDir({
        appDir: '/srv/flag',
        env: { GH_MANAGER_HOME: '/srv/gh' },
        home: '/home/x',
      })
    ).toBe(resolve('/srv/flag'));
  });

  it('names config.json, chrome-profile, and logs inside it', () => {
    const paths = appPaths('/srv/gh');

    expect(paths.configFile).toBe(join('/srv/gh', 'config.json'));
    expect(paths.profileDir).toBe(join('/srv/gh', 'chrome-profile'));
    expect(paths.logsDir).toBe(join('/srv/gh', 'logs'));
  });

  it('creates the profile and logs directories', () => {
    withTempDir((dir) => {
      const appDir = join(dir, 'app');
      const paths = ensureAppDir(appDir);

      expect(existsSync(paths.profileDir)).toBe(true);
      expect(existsSync(paths.logsDir)).toBe(true);
    });
  });
});

describe('stored configuration', () => {
  it('treats a missing config.json as empty', () => {
    withTempDir((dir) => {
      expect(loadStoredConfig(dir)).toEqual({});
    });
  });

  it('reports a malformed config.json and never ignores it', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'config.json'), '{not json');

      try {
        loadStoredConfig(dir);
      } catch (error) {
        expect(error.message).toContain('is not valid JSON');
        expect(error.exitCode).toBe(EXIT_CODES.FAILURE);
        return;
      }

      throw new Error('expected a malformed config file to be reported');
    });
  });

  it('merges on save and replaces on write', () => {
    withTempDir((dir) => {
      saveStoredConfig(dir, { org: 'link-foundation' });
      saveStoredConfig(dir, { packageType: 'npm' });

      expect(loadStoredConfig(dir)).toEqual({
        org: 'link-foundation',
        packageType: 'npm',
      });

      writeStoredConfig(dir, { org: 'link-foundation' });

      expect(loadStoredConfig(dir)).toEqual({ org: 'link-foundation' });
      expect(
        readFileSync(join(dir, 'config.json'), 'utf8').endsWith('\n')
      ).toBe(true);
    });
  });
});

describe('resolveSettings', () => {
  it('lets flags win over stored values, and stored values over defaults', () => {
    withTempDir((dir) => {
      saveStoredConfig(dir, { org: 'stored-org', packageType: 'npm' });

      const settings = resolveSettings({
        flags: { appDir: dir, org: 'flag-org' },
        env: {},
        home: '/home/example',
      });

      expect(settings.org).toBe('flag-org');
      expect(settings.packageType).toBe('npm');
      expect(settings.channel).toBe(DEFAULT_CONFIG.channel);
      expect(settings.appDir).toBe(dir);
    });
  });
});

describe('resolveOwner', () => {
  it('maps --org to the organization API scope', () => {
    expect(resolveOwner({ org: 'link-foundation' })).toEqual({
      scope: 'orgs',
      name: 'link-foundation',
    });
  });

  it('maps --account to the user API scope', () => {
    expect(resolveOwner({ account: 'konard' })).toEqual({
      scope: 'users',
      name: 'konard',
    });
  });

  it('refuses both at once', () => {
    try {
      resolveOwner({ org: 'a', account: 'b' });
    } catch (error) {
      expect(error.exitCode).toBe(EXIT_CODES.USAGE);
      return;
    }

    throw new Error('expected --org with --account to be rejected');
  });

  it('explains how to set an owner when none is configured', () => {
    try {
      resolveOwner({});
    } catch (error) {
      expect(error.message).toContain('gh-manager config set org');
      expect(error.exitCode).toBe(EXIT_CODES.USAGE);
      return;
    }

    throw new Error('expected a missing owner to be reported');
  });
});
