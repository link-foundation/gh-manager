import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'test-anywhere';

// Emulate command-stream's resolved nonzero results without network, git
// mutations, or package installs. Deno's CI tests do not allow subprocesses.
const canSpawn = typeof Deno === 'undefined';
const mockLoader = `
export async function loadCommandStream() {
  return { $: (strings, ...values) => {
    const command = strings.reduce((text, part, index) =>
      text + part + (values[index] ?? ''), '');
    console.log('COMMAND:', command);
    const result = {
      code: command.includes(process.env.FAIL_COMMAND) ? 1 : 0,
      stdout: command.includes('status --porcelain') ? ' M package.json' : 'head',
      stderr: '',
    };
    const stream = Promise.resolve(result);
    stream.run = () => stream;
    return stream;
  }};
}
export async function loadLinoArguments() {
  return { makeConfig: () => ({ mode: process.env.VERSION_MODE, bumpType: 'patch' }) };
}
`;

function runFixture(script, failCommand, mode = 'changeset', jsRoot = '.') {
  const root = mkdtempSync(join(tmpdir(), 'version-command-'));
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    for (const name of [
      script,
      'js-paths.mjs',
      'bootstrap-dependencies.mjs',
      'debug-print.mjs',
    ]) {
      copyFileSync(`scripts/${name}`, join(scripts, name));
    }
    writeFileSync(join(scripts, 'use-module.mjs'), mockLoader);
    mkdirSync(join(root, jsRoot), { recursive: true });
    writeFileSync(
      join(root, jsRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' })
    );
    return spawnSync(
      process.execPath,
      [join(scripts, script), '--js-root', jsRoot],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, FAIL_COMMAND: failCommand, VERSION_MODE: mode },
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('version command failures', () => {
  if (canSpawn) {
    for (const jsRoot of ['.', 'js']) {
      it(`stops after changeset fails in ${jsRoot}`, () => {
        const result = runFixture(
          'changeset-version.mjs',
          'npx changeset version',
          'changeset',
          jsRoot
        );
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('Synchronizing package-lock.json');
        expect(result.stderr).toContain('exit 1');
      });

      it(`fails when lockfile synchronization fails in ${jsRoot}`, () => {
        const result = runFixture(
          'changeset-version.mjs',
          'npm install',
          'changeset',
          jsRoot
        );
        expect(result.stdout).toContain(
          `COMMAND: ${jsRoot === '.' ? '' : `cd ${jsRoot} && `}npx changeset version`
        );
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('Version bump complete');
      });
    }

    for (const mode of ['changeset', 'instant']) {
      it(`does not commit or push after ${mode} versioning fails`, () => {
        const command =
          mode === 'changeset'
            ? 'npm run changeset:version'
            : 'node scripts/instant-version-bump.mjs';
        const result = runFixture('version-and-commit.mjs', command, mode);
        expect(result.stdout).toContain(command);
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('COMMAND: git add');
        expect(result.stdout).not.toContain('push-main-with-rebase-retry.mjs');
      });
    }

    it('completes when versioning and lockfile synchronization succeed', () => {
      const result = runFixture('changeset-version.mjs', 'never-fail');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Version bump complete');
    });
  }
});
