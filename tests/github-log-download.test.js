import { describe, it, expect } from 'test-anywhere';
import { createRestClient } from '../src/github/rest.js';

describe('job log downloads', () => {
  for (const status of [404, 410]) {
    for (const redirected of [false, true]) {
      it(`returns unavailable logs for ${status}${redirected ? ' after a redirect' : ''}`, async () => {
        let calls = 0;
        const path = '/repos/acme/one/actions/jobs/2/logs';
        const rest = createRestClient({
          token: 'private-value',
          fetch: async () =>
            redirected && ++calls === 1
              ? {
                  status: 302,
                  headers: {
                    get: () =>
                      'https://logs.example.test/?signature=private-value',
                  },
                }
              : { status, ok: false },
        });
        const result = await rest.text(path);
        expect(result.status).toBe(
          status === 410 ? 'logs-expired' : 'logs-unavailable'
        );
        expect(result.httpStatus).toBe(status);
        expect(result.path).toBe(path);
        expect(JSON.stringify(result)).not.toContain('private-value');
      });
    }
  }

  for (const status of [401, 403, 429, 500]) {
    it(`still raises an API error for log download ${status}`, async () => {
      const rest = createRestClient({
        fetch: async () => ({ status, ok: false }),
      });
      let error;
      try {
        await rest.text('/logs');
      } catch (failure) {
        error = failure;
      }
      expect(error?.status).toBe(status);
      expect(error?.name).toBe('GitHubApiError');
    });
  }

  it('keeps signed download URLs out of network errors collected by scans', async () => {
    let calls = 0;
    const rest = createRestClient({
      fetch: async (url) => {
        if (++calls === 1) {
          return {
            status: 302,
            headers: {
              get: () => 'https://logs.example.test/?signature=private-value',
            },
          };
        }
        throw new Error(`Download failed: ${url}`);
      },
    });
    let error;
    try {
      await rest.text('/repos/acme/one/actions/jobs/2/logs');
    } catch (failure) {
      error = failure;
    }
    expect(error?.name).toBe('GitHubApiError');
    expect(error?.message).not.toContain('private-value');
  });

  it('does not include malformed signed redirect credentials in errors', async () => {
    const rest = createRestClient({
      fetch: async () => ({
        status: 302,
        headers: { get: () => 'https://[invalid]?signature=private-value' },
      }),
    });
    let error;
    try {
      await rest.text('/logs');
    } catch (failure) {
      error = failure;
    }
    expect(error?.name).toBe('GitHubApiError');
    expect(String(error?.input)).not.toContain('private-value');
    expect(error?.message).not.toContain('private-value');
  });

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
