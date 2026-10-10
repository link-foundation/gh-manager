import { createRestClient } from '../../src/github/rest.js';
import { URL } from 'node:url';

export const repository = { owner: 'acme', name: 'one' };
export const workflowSource = `on: [push, workflow_dispatch]
jobs:
  publish:
    name: Publish
    steps:
      - name: Upload
        env:
          TOKEN: \${{ secrets.CUSTOM_TOKEN }}
        run: echo upload
      - name: Unrelated
        run: echo other
`;

export function actionsApi({
  conclusion = 'success',
  stepConclusion = conclusion,
  log = '2026-01-01T00:00:02Z unauthorized',
  noRuns = false,
  source = workflowSource,
  routes = {},
} = {}) {
  const calls = [];
  const run = {
    id: 1,
    workflow_id: 7,
    status: 'completed',
    conclusion,
    run_attempt: 1,
    head_branch: 'main',
    path: '.github/workflows/release.yml',
    html_url: 'https://github.com/acme/one/actions/runs/1',
  };
  const job = {
    id: 2,
    name: 'Publish',
    status: 'completed',
    conclusion,
    steps: [
      {
        name: 'Upload',
        number: 2,
        status: 'completed',
        conclusion: stepConclusion,
        started_at: '2026-01-01T00:00:01Z',
        completed_at: '2026-01-01T00:00:03Z',
      },
      {
        name: 'Unrelated',
        number: 3,
        status: 'completed',
        conclusion,
        started_at: '2026-01-01T00:00:04Z',
        completed_at: '2026-01-01T00:00:06Z',
      },
    ],
  };
  const rest = createRestClient({
    token: 'fake',
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const call = {
        path,
        query: parsed.searchParams,
        method: options.method ?? 'GET',
        body: options.body ? JSON.parse(options.body) : null,
        headers: options.headers,
      };
      calls.push(call);
      let body;
      let status = 200;
      const custom = routes[`${call.method} ${path}`] ?? routes[path];
      if (custom) {
        const result =
          typeof custom === 'function' ? await custom(call) : custom;
        body = result.body;
        status = result.status ?? 200;
      } else {
        ({ body, status } = defaultRoute(path, {
          source,
          noRuns,
          run,
          job,
          log,
        }));
      }
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        json: async () => body,
        text: async () =>
          typeof body === 'string' ? body : JSON.stringify(body),
      };
    },
  });
  return { rest, calls, run, job };
}

function defaultRoute(path, { source, noRuns, run, job, log }) {
  let body;
  if (path === '/repos/acme/one') {
    body = { id: 11, full_name: 'acme/one', default_branch: 'main' };
  } else if (path.endsWith('/contents/.github/workflows')) {
    body = [{ name: 'release.yml', type: 'file' }];
  } else if (path.endsWith('/contents/.github/workflows/release.yml')) {
    body = {
      encoding: 'base64',
      content: Buffer.from(source).toString('base64'),
    };
  } else if (path.endsWith('/workflows/release.yml')) {
    body = { id: 7, state: 'active' };
  } else if (path.endsWith('/runs')) {
    body = { workflow_runs: noRuns ? [] : [run] };
  } else if (path.endsWith('/runs/1')) {
    body = run;
  } else if (path.endsWith('/jobs')) {
    body = { jobs: [job] };
  } else if (path.endsWith('/jobs/2/logs')) {
    body = log;
  } else {
    return { status: 404, body: {} };
  }
  return { body, status: 200 };
}

export function dispatchedApi() {
  let dispatched = false;
  const api = actionsApi({
    noRuns: true,
    routes: {
      'POST /repos/acme/one/actions/workflows/release.yml/dispatches': () => {
        dispatched = true;
        return { status: 204 };
      },
      '/repos/acme/one/actions/workflows/release.yml/runs': () => ({
        body: { workflow_runs: dispatched ? [api.run] : [] },
      }),
    },
  });
  return api;
}
