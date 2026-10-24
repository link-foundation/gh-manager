import { createRestClient } from '../../src/github/rest.js';
import { URL } from 'node:url';
import { securityPages } from './github-security-pages.js';

export function doctorApi({
  files = {},
  log = '',
  conclusion = 'failure',
  inaccessible = false,
  ineffective = false,
  logsMissing = false,
  defaultSetup = 'not-configured',
  site = { build_type: 'legacy' },
  workflows = [{ id: 7, path: '.github/workflows/ci.yml' }],
} = {}) {
  const page = securityPages({
    repo: { owner: 'acme', name: 'one' },
    states: { 'dependency-graph': 'disabled' },
  });
  let pages = site;
  let setup = defaultSetup;
  const calls = [];
  const run = {
    id: 1,
    status: 'completed',
    conclusion,
    head_branch: 'main',
    html_url: 'https://github.com/acme/one/actions/runs/1',
    updated_at: new Date().toISOString(),
  };
  const routes = {
    '/user/repos': { status: 200, body: [] },
    '/orgs/acme/repos': {
      status: 200,
      body: [
        { full_name: 'acme/broken', default_branch: 'main' },
        { full_name: 'acme/one', default_branch: 'main' },
      ],
    },
    '/users/acme/repos': { status: 200, body: [{ full_name: 'acme/one' }] },
    '/repos/acme/one': () => ({
      status: inaccessible ? 403 : 200,
      body: {
        full_name: 'acme/one',
        default_branch: 'main',
        visibility: 'public',
      },
    }),
    '/repos/acme/one/git/trees/main': {
      status: 200,
      body: {
        tree: Object.keys(files).map((path, index) => ({
          path,
          sha: String(index),
          type: 'blob',
        })),
      },
    },
    '/repos/acme/one/actions/workflows': { status: 200, body: { workflows } },
    '/repos/acme/one/actions/runs/1': () => ({ status: 200, body: run }),
    '/repos/acme/one/actions/runs/1/jobs': {
      status: 200,
      body: {
        jobs: [
          { id: 2, name: 'Check', conclusion: 'failure' },
          { id: 3, name: 'Good', conclusion: 'success' },
        ],
      },
    },
    '/repos/acme/one/actions/jobs/2/logs': {
      status: logsMissing ? 410 : 200,
      body: log,
    },
    '/repos/acme/one/actions/jobs/3/logs': {
      status: 200,
      body: 'Get Pages site failed',
    },
    '/repos/acme/one/pages': () =>
      pages ? { status: 200, body: pages } : { status: 404, body: {} },
    '/repos/acme/one/code-scanning/default-setup': () => ({
      status: 200,
      body: { state: setup },
    }),
    '/repos/acme/one/vulnerability-alerts': () => ({
      status:
        page.state.features['vulnerability-alerts'] === 'enabled' ? 204 : 404,
    }),
    '/repos/acme/one/dependency-graph/sbom': () => ({
      status: page.state.features['dependency-graph'] === 'enabled' ? 200 : 404,
      body: {},
    }),
    '/repos/acme/one/contents/.github/workflows': {
      status: 200,
      body: Object.keys(files)
        .filter((path) => path.startsWith('.github/workflows/'))
        .map((path) => ({ name: path.split('/').at(-1), type: 'file' })),
    },
    'PUT /repos/acme/one/pages': ({ body }) => {
      if (!ineffective) {
        pages = body;
      }
      return { status: 204 };
    },
    'POST /repos/acme/one/pages': ({ body }) => {
      if (!ineffective) {
        pages = body;
      }
      return { status: 201, body: pages };
    },
    'PUT /repos/acme/one/vulnerability-alerts': () => {
      if (!ineffective) {
        page.state.features['vulnerability-alerts'] = 'enabled';
      }
      return { status: 204 };
    },
    'PATCH /repos/acme/one/code-scanning/default-setup': ({ body }) => {
      if (!ineffective) {
        setup = body.state;
      }
      return { status: 202, body: {} };
    },
    'POST /repos/acme/one/actions/runs/1/rerun-failed-jobs': {
      status: 201,
      body: {},
    },
  };
  for (const workflow of workflows) {
    routes[
      `/repos/acme/one/actions/workflows/${workflow.path.split('/').at(-1)}/runs`
    ] = { status: 200, body: { workflow_runs: [run] } };
  }
  for (const [index, [path, content]] of Object.entries(files).entries()) {
    const blob = {
      status: 200,
      body: {
        encoding: 'base64',
        content: Buffer.from(content).toString('base64'),
      },
    };
    routes[`/repos/acme/one/git/blobs/${index}`] = blob;
    routes[`/repos/acme/one/contents/${path}`] = blob;
  }
  const rest = createRestClient({
    token: 'fake',
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const call = {
        path: parsed.pathname,
        method: options.method ?? 'GET',
        query: Object.fromEntries(parsed.searchParams),
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`] ?? routes[call.path];
      const answer = (typeof route === 'function' ? route(call) : route) ?? {
        status: 404,
        body: {},
      };
      return {
        ok: answer.status < 400,
        status: answer.status,
        headers: { get: () => null },
        json: async () => answer.body,
        text: async () =>
          typeof answer.body === 'string'
            ? answer.body
            : JSON.stringify(answer.body),
      };
    },
  });
  return {
    rest,
    calls,
    routes: page.routes,
    run,
    state: page.state,
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}
