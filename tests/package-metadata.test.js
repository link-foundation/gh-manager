import { describe, it, expect } from 'test-anywhere';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runCli } from '../bin/gh-manager.js';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const lockJson = JSON.parse(readFileSync('package-lock.json', 'utf8'));

describe('publishable package metadata', () => {
  it('uses the published gh-manager package name', () => {
    expect(packageJson.name).toBe('@link-foundation/gh-manager');
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    expect(lockJson.name).toBe('@link-foundation/gh-manager');
    expect(lockJson.packages[''].name).toBe('@link-foundation/gh-manager');
  });

  it('defines a globally installable CLI command', () => {
    expect(packageJson.bin).toEqual({
      'gh-manager': './bin/gh-manager.js',
    });
    expect(existsSync('bin/gh-manager.js')).toBe(true);
  });

  it('depends on browser-commander for the real browser session', () => {
    expect(Boolean(packageJson.dependencies['browser-commander'])).toBe(true);
  });

  it('runs the CLI through the package entry point', async () => {
    const stdout = [];
    const stderr = [];

    expect(
      await runCli(['--version'], {
        stderr: (line) => stderr.push(line),
        stdout: (line) => stdout.push(line),
      })
    ).toBe(0);

    expect(stdout).toEqual([packageJson.version]);
    expect(stderr).toEqual([]);
  });

  it('runs when invoked through an npm-style bin symlink', () => {
    if (typeof Deno !== 'undefined') {
      return;
    }

    const tempRoot = mkdtempSync(join(tmpdir(), 'gh-manager-'));
    const linkPath = join(tempRoot, 'gh-manager');

    try {
      symlinkSync(resolve('bin/gh-manager.js'), linkPath);
    } catch (error) {
      rmSync(tempRoot, { force: true, recursive: true });

      if (process.platform === 'win32') {
        expect(error.code).toBe('EPERM');
        return;
      }

      throw error;
    }

    try {
      const result = spawnSync(process.execPath, [linkPath, '--version'], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(packageJson.version);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('publishes only the package runtime surface', () => {
    expect(packageJson.files).toEqual([
      'bin/',
      'src/',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
    ]);
  });
});
