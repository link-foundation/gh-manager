import { describe, it, expect } from 'test-anywhere';
import { createRestClient } from '../src/github/rest.js';

describe('job log downloads', () => {
  it('follows a signed redirect without sending the API token to the download host', async () => {
    const calls = [];
    const rest = createRestClient({
      token: 'private-value',
      fetch: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
          ? {
              status: 302,
              headers: { get: () => 'https://logs.example.test/signed' },
            }
          : { status: 200, ok: true, text: async () => 'masked *** logs' };
      },
    });
    expect(await rest.text('/repos/acme/one/actions/jobs/2/logs')).toBe(
      'masked *** logs'
    );
    expect(calls[0].options.headers.authorization).toBe('Bearer private-value');
    expect(calls[1].options.headers).toBe(undefined);
  });

  it('refuses invalid redirect schemes before sending a second request', async () => {
    let calls = 0;
    const rest = createRestClient({
      fetch: async () => {
        calls++;
        return {
          status: 302,
          headers: { get: () => 'http://logs.example.test/signed' },
        };
      },
    });
    let failed = false;
    try {
      await rest.text('/logs');
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(calls).toBe(1);
  });
});
