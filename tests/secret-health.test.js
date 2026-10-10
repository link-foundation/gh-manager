import { describe, it, expect } from 'test-anywhere';
import { createSecretHealth } from '../src/secrets/health.js';
import {
  actionsApi,
  dispatchedApi,
  repository,
} from './fixtures/actions-api.js';

const options = { scope: { repo: repository }, timeout: 0, interval: 0 };
const service = (api) => createSecretHealth({ rest: api.rest });

describe('Actions evidence for secret health', () => {
  it('pins workflow source to the run commit', async () => {
    const api = actionsApi({
      routes: {
        '/repos/acme/one/contents/.github/workflows/release.yml': ({
          query,
        }) => ({
          body: {
            encoding: 'base64',
            content: Buffer.from(
              query.get('ref') === 'old-sha'
                ? 'on: push\njobs:\n  publish:\n    name: Publish\n    steps:\n      - name: Upload\n        run: echo unrelated\n'
                : 'on: push\njobs:\n  publish:\n    name: Publish\n    steps:\n      - name: Upload\n        run: echo ${{ secrets.CUSTOM_TOKEN }}\n'
            ).toString('base64'),
          },
        }),
      },
    });
    api.run.head_sha = 'old-sha';
    const result = await service(api).health('CUSTOM_TOKEN', options);
    expect(result.status).toBe('unknown');
    expect(result.evidence[0].reason).toBe('secret-not-used-in-run');
    expect(api.calls.some((call) => call.query.get('ref') === 'old-sha')).toBe(
      true
    );
  });

  it('follows workflow/job environment aliases without extending a step-only environment to later steps', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      source:
        'on: push\nenv:\n  TOKEN: ${{ secrets.CUSTOM_TOKEN }}\njobs:\n  publish:\n    name: Publish\n    steps:\n      - name: Upload\n        run: echo $TOKEN\n      - name: Unrelated\n        run: echo unrelated\n',
      log: '2026-01-01T00:00:05Z unauthorized',
    });
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'unknown'
    );
    api.job.steps[0].conclusion = 'success';
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'ok'
    );
  });

  it('rejects environment or foreign-org scopes and reports ambiguous step names as unknown', async () => {
    const api = actionsApi();
    let rejected = false;
    try {
      await service(api).health('CUSTOM_TOKEN', {
        scope: { repo: repository, environment: 'production' },
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    rejected = false;
    try {
      await service(api).health('CUSTOM_TOKEN', {
        scope: { org: 'acme' },
        repos: ['another/one'],
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    api.job.steps.push({ ...api.job.steps[0] });
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'unknown'
    );
  });
});

describe('Secret health classification and polling', () => {
  it('reports ok when the secret step passed even if another step failed', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      stepConclusion: 'success',
    });
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'ok'
    );
  });
  it('reports auth-failing with run URL, matching line and redacted credentials', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      log: '2026-01-01T00:00:02Z invalid token Authorization: Bearer private-value',
    });
    const result = await service(api).health('CUSTOM_TOKEN', options);
    expect(result.status).toBe('auth-failing');
    expect(result.evidence[0].runUrl).toBe(api.run.html_url);
    expect(result.evidence[0].match.text).toContain('invalid token');
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
  it('does not attribute unrelated job log lines to the secret step', async () => {
    const api = actionsApi({
      conclusion: 'failure',
      log: '2026-01-01T00:00:05Z unauthorized',
    });
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'unknown'
    );
  });
  it('supports caller failure patterns and unknown for no runs or non-auth failure', async () => {
    expect(
      (
        await service(actionsApi({ noRuns: true })).health(
          'CUSTOM_TOKEN',
          options
        )
      ).status
    ).toBe('unknown');
    const api = actionsApi({
      conclusion: 'failure',
      log: '2026-01-01T00:00:02Z CUSTOM_AUTH_ERROR',
    });
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'unknown'
    );
    expect(
      (
        await service(api).health('CUSTOM_TOKEN', {
          ...options,
          failurePatterns: ['CUSTOM_AUTH_ERROR'],
        })
      ).status
    ).toBe('auth-failing');
  });
  it('dispatches and waits for fresh run evidence', async () => {
    const api = dispatchedApi();
    const result = await service(api).test('CUSTOM_TOKEN', options);
    expect(result.status).toBe('ok');
    expect(
      api.calls.find((call) => call.path.endsWith('/dispatches')).body.ref
    ).toBe('main');
  });

  it('waits for a newer rerun attempt', async () => {
    let reads = 0;
    let time = 0;
    const api = actionsApi({
      source:
        'on: push\njobs:\n  publish:\n    name: Publish\n    steps:\n      - name: Upload\n        run: echo ${{ secrets.CUSTOM_TOKEN }}\n',
      routes: {
        'POST /repos/acme/one/actions/runs/1/rerun': { status: 201 },
        '/repos/acme/one/actions/runs/1': () => ({
          body: { ...api.run, run_attempt: ++reads < 2 ? 1 : 2 },
        }),
      },
    });
    const result = await createSecretHealth({
      rest: api.rest,
      now: () => time,
      sleep: async () => {
        time++;
      },
    }).test('CUSTOM_TOKEN', { ...options, timeout: 5 });
    expect(result.status).toBe('ok');
    expect(reads).toBe(2);
  });

  it('returns unknown on a polling timeout and never classifies a skipped secret step as ok', async () => {
    const skipped = actionsApi({ stepConclusion: 'skipped' });
    expect(
      (await service(skipped).health('CUSTOM_TOKEN', options)).status
    ).toBe('unknown');
    const api = actionsApi({
      routes: {
        'POST /repos/acme/one/actions/workflows/release.yml/dispatches': {
          status: 204,
        },
      },
    });
    const result = await service(api).test('CUSTOM_TOKEN', options);
    expect(result.status).toBe('unknown');
    expect(result.evidence[0].reason).toBe('test-timeout');
  });

  it('ignores commented secret references', async () => {
    const api = actionsApi({
      source:
        '# secrets.CUSTOM_TOKEN\non: push\njobs:\n  publish:\n    steps:\n      - run: echo no secret\n',
    });
    expect((await service(api).health('CUSTOM_TOKEN', options)).status).toBe(
      'unknown'
    );
    expect(api.calls.some((call) => call.path.endsWith('/runs'))).toBe(false);
  });

  it('examines every referencing repository in organization scope', async () => {
    const api = actionsApi({
      routes: { '/orgs/acme/repos': { body: [{ full_name: 'acme/one' }] } },
    });
    expect(
      (await service(api).health('CUSTOM_TOKEN', { scope: { org: 'acme' } }))
        .status
    ).toBe('ok');
  });
});
