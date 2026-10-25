import { describe, it, expect } from 'test-anywhere';
import { authDomain } from '../src/domains/auth.js';
import { homeUrl, loginUrl } from '../src/browser/selectors.js';
import { createLogger } from '../src/logging.js';
import { createFakeSession } from './fixtures/fake-browser.js';

function loginContext(message, { repeat = false, timeout = 1 } = {}) {
  const session = createFakeSession({
    routes: {
      [homeUrl()]: '<html><head></head><body>Signed out</body></html>',
      [loginUrl()]:
        '<html><head><meta name="user-login" content="acme"></head><body>Signed in</body></html>',
    },
  });
  const evaluate = session.commander.evaluate;
  let attempts = 0;
  session.commander.evaluate = (options) => {
    if (session.commander.getUrl() === loginUrl()) {
      attempts += 1;
      if (repeat || attempts === 1) {
        return Promise.reject(new Error(message));
      }
    }
    return evaluate(options);
  };
  return {
    context: {
      settings: { headless: false, profileDir: '/test/profile' },
      flags: { timeout },
      getSession: () => Promise.resolve(session),
      log: createLogger({ stdout: () => {}, stderr: () => {} }),
    },
    attempts: () => attempts,
  };
}

async function loginError(context) {
  try {
    await authDomain.verbs.login.run(context);
  } catch (error) {
    return error;
  }
  throw new Error('Expected sign-in to fail');
}

describe('passkey sign-in navigation', () => {
  for (const message of [
    'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    'Protocol error (Runtime.evaluate): Cannot find context with specified id',
  ]) {
    it(`resumes session detection after ${message}`, async () => {
      const login = loginContext(message);
      expect(await authDomain.verbs.login.run(login.context)).toBe(0);
      expect(login.attempts()).toBe(2);
    });
  }

  it('preserves terminal browser errors', async () => {
    const message = 'Target page, context or browser has been closed';
    const login = loginContext(message);
    expect((await loginError(login.context)).message).toBe(message);
    expect(login.attempts()).toBe(1);
  });

  it('keeps navigation retries within the configured sign-in timeout', async () => {
    const login = loginContext('Execution context was destroyed', {
      repeat: true,
      timeout: 0,
    });
    expect((await loginError(login.context)).message).toContain(
      'No GitHub session appeared within 0s'
    );
    expect(login.attempts()).toBe(1);
  });
});
