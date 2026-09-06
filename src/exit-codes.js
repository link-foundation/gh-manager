/**
 * Process exit codes used by the gh-manager CLI.
 *
 * They are stable and meaningful so a release pipeline can branch on them
 * without parsing output.
 */
export const EXIT_CODES = {
  /** Every requested operation completed and was verified. */
  SUCCESS: 0,
  /** An operation failed (browser error, GitHub error, unexpected UI). */
  FAILURE: 1,
  /** The command line itself was wrong: unknown verb, missing argument. */
  USAGE: 2,
  /** No usable GitHub session or token was available. */
  AUTH: 3,
  /** The targets or pattern resolved to nothing to act on. */
  NO_MATCHES: 4,
  /** The user declined a confirmation prompt. */
  ABORTED: 5,
  /** The action was performed but the follow-up read did not confirm it. */
  VERIFICATION_FAILED: 6,
};

/**
 * Error carrying an explicit exit code, so command handlers can fail with a
 * precise reason, not a generic failure.
 */
export class CliError extends Error {
  /**
   * @param {string} message - Human readable failure description
   * @param {number} [exitCode] - Exit code from EXIT_CODES
   * @param {Object} [options] - Optional cause for error chaining
   */
  constructor(message, exitCode = EXIT_CODES.FAILURE, options = {}) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * Read the exit code carried by an error, defaulting to a generic failure.
 * @param {unknown} error - Thrown value
 * @returns {number} Exit code to report
 */
export function exitCodeForError(error) {
  const code = error?.exitCode;
  return Number.isInteger(code) ? code : EXIT_CODES.FAILURE;
}
