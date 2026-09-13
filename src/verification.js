/**
 * Waiting for a change to become observable.
 *
 * Nothing this tool changes is visible immediately: GitHub opens its dialogs
 * asynchronously, and its API needs a moment to start reporting a write that
 * has already landed. Both cases have the same shape — re-read until the
 * answer is the expected one or the budget runs out — so both go through the
 * loop below, and neither sleeps for a guessed number of milliseconds.
 */

/** How long to keep re-reading the API before calling a change unverified. */
export const VERIFICATION_TIMEOUT_MS = 15000;

/** Delay between verification reads. */
export const VERIFICATION_INTERVAL_MS = 1000;

/**
 * Sleep for a while.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>} Resolves after the delay
 */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Re-read a value until it satisfies a condition or the deadline passes.
 *
 * The first reading happens before the deadline is consulted, so a zero
 * timeout still yields one read and an immediate answer, which is what keeps
 * the tests fast.
 * @param {Object} options - Polling options
 * @param {() => Promise<any>} options.read - Reads the current value
 * @param {(value: any) => boolean} options.accept - Decides whether to stop
 * @param {number} options.timeout - Total time to keep polling, in ms
 * @param {number} options.interval - Delay between readings, in ms
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits between readings
 * @param {() => number} [options.now] - Clock, injectable for tests
 * @returns {Promise<{value: any, accepted: boolean}>} Last reading
 */
export async function pollUntil({
  read,
  accept,
  timeout,
  interval,
  sleep = delay,
  now = Date.now,
}) {
  const deadline = now() + timeout;
  let value = await read();

  while (!accept(value)) {
    if (now() >= deadline) {
      return { value, accepted: false };
    }

    await sleep(interval);
    value = await read();
  }

  return { value, accepted: true };
}
