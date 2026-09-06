/**
 * Interactive confirmation.
 *
 * Destructive verbs stop and ask, and the question always lists what is about
 * to be touched. `--yes` is the only way to skip the question, so a run that
 * cannot ask (a pipeline, a cron job) fails loudly.
 */

import { createInterface } from 'node:readline';

import { CliError, EXIT_CODES } from '../exit-codes.js';

/**
 * Read one line from standard input.
 * @param {string} question - Prompt to display
 * @returns {Promise<string>} The line the operator typed
 */
function readLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Create a confirmation function.
 * @param {Object} [options] - Confirmation options
 * @param {boolean} [options.assumeYes] - Whether `--yes` was passed
 * @param {boolean} [options.interactive] - Whether stdin can be asked
 * @param {(question: string) => Promise<string>} [options.ask] - Reader override
 * @returns {(question: string) => Promise<boolean>} Confirmation function
 */
export function createConfirm({
  assumeYes = false,
  interactive = Boolean(process.stdin?.isTTY),
  ask = readLine,
} = {}) {
  return async function confirm(question) {
    if (assumeYes) {
      return true;
    }

    if (!interactive) {
      throw new CliError(
        `${question}\nNothing was done: this run cannot ask for confirmation. Pass --yes to confirm non-interactively.`,
        EXIT_CODES.ABORTED
      );
    }

    const answer = await ask(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}
