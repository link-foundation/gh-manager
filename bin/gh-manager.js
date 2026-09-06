#!/usr/bin/env node

/**
 * The `gh-manager` executable.
 *
 * It does nothing but hand the arguments to runCli and turn the returned exit
 * code into the process exit code, so the same command can be run in a test
 * without spawning anything.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli/main.js';

/**
 * Report whether this file was started directly by node.
 * @returns {boolean} True when this module is the process entry point
 */
function isCliEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { runCli };
