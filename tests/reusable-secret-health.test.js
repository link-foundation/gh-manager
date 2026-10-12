import { describe, it, expect } from 'test-anywhere';
import { createSecretHealth } from '../src/secrets/health.js';
import { actionsApi } from './fixtures/actions-api.js';

const contents = (source) => ({
  body: {
    encoding: 'base64',
    content: Buffer.from(source).toString('base64'),
  },
});
const called = `on: workflow_call
jobs:
  publish:
    name: Publish
    steps:
      - name: Upload
        run: echo \${{ secrets.REGISTRY_TOKEN }}
`;

function reusableApi({
  secrets = '      REGISTRY_TOKEN: ${{ secrets.CUSTOM_TOKEN }}',
  uses = './.github/workflows/rust.yml',
  child = called,
} = {}) {
  const api = actionsApi({
    source: `on: push\njobs:\n  rust:\n    name: Rust CI/CD\n    uses: ${uses}\n    secrets:\n${secrets}\n`,
    routes: {
      '/repos/acme/one/contents/.github/workflows/rust.yml': contents(child),
    },
  });
  api.run.head_sha = 'run-sha';
  api.job.name = 'Rust CI/CD / Publish';
  return api;
}

const inspect = (api) =>
  createSecretHealth({ rest: api.rest }).health('CUSTOM_TOKEN', {
    scope: { repo: 'acme/one' },
  });

describe('secret use in called workflows', () => {
  it('follows local workflows and renamed secrets at the run commit', async () => {
    const api = reusableApi();
    const result = await inspect(api);
    expect(result.status).toBe('ok');
    expect(result.evidence[0].job).toBe('Rust CI/CD / Publish');
    expect(
      api.calls.some(
        (call) =>
          call.path.endsWith('/rust.yml') && call.query.get('ref') === 'run-sha'
      )
    ).toBe(true);
  });

  it('finds inherited secrets even without a direct reference in the caller', async () => {
    const api = reusableApi({
      secrets: '      inherit',
      child: called.replace('REGISTRY_TOKEN', 'CUSTOM_TOKEN'),
    });
    const result = await inspect(api);
    expect(result.status).toBe('ok');
  });

  it('attributes authentication failure only to the called secret step', async () => {
    const api = reusableApi();
    api.job.steps[0].conclusion = 'failure';
    const result = await inspect(api);
    expect(result.status).toBe('auth-failing');
    expect(result.evidence[0].match.text).toContain('unauthorized');
  });

  it('does not count forwarding an unused secret as successful use', async () => {
    const api = reusableApi({
      child: called.replace('secrets.REGISTRY_TOKEN', 'secrets.OTHER_TOKEN'),
    });
    const result = await inspect(api);
    expect(result.status).toBe('unknown');
  });

  it('bounds cycles and retains unknown evidence for unreadable calls', async () => {
    const api = reusableApi({
      child:
        'on: workflow_call\njobs:\n  loop:\n    uses: ./.github/workflows/rust.yml\n    secrets: inherit\n',
    });
    const result = await inspect(api);
    expect(result.status).toBe('unknown');
    expect(result.evidence.length).toBe(1);
    expect(
      api.calls.filter((call) => call.path.endsWith('/rust.yml')).length
    ).toBe(2);
  });

  it('pins remote workflow content to the SHA recorded on the run', async () => {
    const api = reusableApi({
      uses: 'acme/shared/.github/workflows/publish.yml@main',
    });
    api.run.referenced_workflows = [
      {
        path: 'acme/shared/.github/workflows/publish.yml@main',
        sha: 'remote-sha',
      },
    ];
    const send = api.rest.request;
    api.rest.request = (path, options) => {
      if (path.includes('/repos/acme/shared/contents/')) {
        expect(path).toContain('ref=remote-sha');
        return Promise.resolve(contents(called).body);
      }
      return send(path, options);
    };
    expect((await inspect(api)).status).toBe('ok');
  });

  it('keeps remote calls with unrecorded commits unknown', async () => {
    const api = reusableApi({
      uses: 'acme/shared/.github/workflows/publish.yml@main',
    });
    expect((await inspect(api)).status).toBe('unknown');
    expect(
      api.calls.some((call) => call.path.startsWith('/repos/acme/shared'))
    ).toBe(true);
  });

  it('follows nested calls with a second secret alias', async () => {
    const api = reusableApi({
      child: `on: workflow_call
jobs:
  nested:
    name: Nested
    uses: ./.github/workflows/publish.yml
    secrets:
      FINAL_TOKEN: \${{ secrets.REGISTRY_TOKEN }}
`,
    });
    const request = api.rest.request;
    api.rest.request = (path, options) =>
      path.includes('/contents/.github/workflows/publish.yml')
        ? Promise.resolve(
            contents(called.replace('REGISTRY_TOKEN', 'FINAL_TOKEN')).body
          )
        : request(path, options);
    api.job.name = 'Rust CI/CD / Nested / Publish';
    expect((await inspect(api)).status).toBe('ok');
  });

  it('keeps called environment secrets and missing run commits unresolved', async () => {
    const api = reusableApi({
      child: called.replace(
        '    name: Publish',
        '    name: Publish\n    environment: production'
      ),
    });
    expect((await inspect(api)).evidence[0].reason).toBe(
      'environment-secret-unresolved'
    );
    const unpinned = reusableApi();
    delete unpinned.run.head_sha;
    expect((await inspect(unpinned)).status).toBe('unknown');
  });

  it('does not attribute duplicate called job names or unrelated steps to the secret', async () => {
    const api = reusableApi({
      child: `${called}  other:\n    name: Publish\n    steps:\n      - name: Upload\n        run: echo unrelated\n`,
    });
    expect((await inspect(api)).status).toBe('unknown');
    expect(api.calls.some((call) => call.path.endsWith('/logs'))).toBe(false);
  });

  it('classifies called environment jobs when no environment secret overrides the passed name', async () => {
    const api = reusableApi({
      child: called.replace(
        '    name: Publish',
        '    name: Publish\n    environment: production'
      ),
    });
    const request = api.rest.request;
    api.rest.request = (path, options) =>
      path.includes('/environments/production/secrets')
        ? Promise.resolve({ secrets: [{ name: 'UNRELATED_TOKEN' }] })
        : request(path, options);
    expect((await inspect(api)).status).toBe('ok');
  });

  it('reports a skipped reusable invocation as not executed', async () => {
    const api = reusableApi();
    api.job.name = 'Rust CI/CD';
    api.job.conclusion = 'skipped';
    api.job.steps = [];
    expect((await inspect(api)).evidence[0].reason).toBe(
      'workflow-call-not-executed'
    );
  });
});
