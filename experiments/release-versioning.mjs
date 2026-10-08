#!/usr/bin/env node

// Run the real release command in a disposable package. --without-deno
// checks the missing-runtime failure; the default verifies lockfile synchronization.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { runCommand } from '../scripts/run-command.mjs';

const withoutDeno = process.argv.includes('--without-deno');
const root = mkdtempSync(join(tmpdir(), 'gh-manager-release-'));
const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

try {
  for (const entry of [
    'package.json',
    'package-lock.json',
    'deno.json',
    'deno.lock',
    'CHANGELOG.md',
    '.changeset',
    'scripts',
  ]) {
    cpSync(entry, join(root, entry), { recursive: true });
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const oldVersion = readJson('package.json').version;
  const env = { ...process.env, CI_SCRIPTS_DEBUG: '1', DEBUG: '1' };
  if (withoutDeno) {
    env.PATH = env.PATH.split(delimiter)
      .filter((entry) => !existsSync(join(entry, 'deno')))
      .join(delimiter);
  }
  const command = withoutDeno ? process.execPath : 'npm';
  const args = withoutDeno
    ? [resolve('node_modules/@changesets/cli/bin.js'), 'version']
    : ['run', 'changeset:version'];
  const result = await runCommand(command, args, {
    cwd: root,
    env,
  });
  if (withoutDeno) {
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /spawn deno ENOENT/);
    assert.doesNotMatch(result.stdout, /Version bump complete/);
    console.log('Confirmed missing Deno fails the release command.');
  } else {
    assert.equal(result.code, 0);
    const version = readJson('package.json').version;
    assert.notEqual(version, oldVersion);
    const lock = readJson('package-lock.json');
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    console.log(
      `Verified version bump ${oldVersion} -> ${version} and synchronized npm lockfile.`
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
