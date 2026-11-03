/**
 * A fake GitHub serving the live links-notation shape captured for the required-check drift case study:
 * ruleset 24860631 covers only refs/heads/main and requires seven of the ten
 * language gates, classic protection is absent, and the CI workflow at the
 * head commit reports all ten gates from GitHub Actions (app 15368).
 */

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createRestClient } from '../../src/github/rest.js';

const DATA = new URL(
  '../../docs/case-studies/required-check-drift/data/',
  import.meta.url
);
const read = (name) => readFileSync(new URL(name, DATA), 'utf8');
export const liveData = (name) => JSON.parse(read(name));

export const REPO = 'acme/links-notation';
export const HEAD = '5ce8287c880239ae4202c9071daa4429342b4a09';
export const LIVE_RULESET_ID = 24860631;

/** The reviewed ten-language policy from the issue. */
export const desiredPolicy = () => liveData('main-ruleset.json');

/** The live repository ruleset, re-homed to the fixture repository. */
export function liveRuleset(extra = {}) {
  const { _links, node_id, ...ruleset } = liveData('ruleset-24860631.json');
  void _links;
  void node_id;
  return { ...ruleset, source: REPO, ...extra };
}

export function liveWorkflows() {
  return {
    '.github/workflows/ci.yml': read('links-notation-ci-js.yml'),
    '.github/workflows/release.yml': read('links-notation-release.yml'),
  };
}

export const liveCheckRuns = () =>
  liveData('check-runs-5ce8287.json').map((run) => ({
    name: run.name,
    status: 'completed',
    conclusion: run.conclusion,
    app: { id: run.app_id },
  }));

function refMatches(pattern, branch) {
  if (pattern === '~ALL' || pattern === '~DEFAULT_BRANCH') {
    return pattern === '~ALL' || branch === 'main';
  }
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\uFFFF')
    .replace(/\*/g, '[^/]*')
    .replace(/\uFFFF/g, '.*');
  return new RegExp(`^${source}$`).test(`refs/heads/${branch}`);
}

const covers = (ruleset, branch) =>
  ruleset.conditions?.ref_name?.include?.some((p) => refMatches(p, branch)) &&
  !ruleset.conditions?.ref_name?.exclude?.some((p) => refMatches(p, branch));

/**
 * @param {Object} [options]
 * @param {Array} [options.rulesets] - Repository rulesets
 * @param {Array} [options.orgRulesets] - Organization rulesets (inherited)
 * @param {Object} [options.classic] - Classic protection on main
 * @param {Object} [options.workflows] - path -> YAML at the head commit
 * @param {Array} [options.checkRuns] - Check runs on the head commit
 * @param {Object} [options.repository] - Extra repository metadata
 * @param {Function} [options.reject] - ({path, method}) => {status, message}
 * @param {Function} [options.onRead] - Hook run before each GET, for races
 * @param {boolean} [options.hideBypass] - Omit bypass_actors like non-admins see
 * @param {string} [options.failedLog] - Log of a failed CI run on main
 */
export function driftApi(options = {}) {
  const state = {
    rulesets: options.rulesets ?? [liveRuleset()],
    orgRulesets: options.orgRulesets ?? [],
    classic: options.classic ?? null,
    workflows: options.workflows ?? liveWorkflows(),
    checkRuns: options.checkRuns ?? liveCheckRuns(),
  };
  const calls = [];
  let nextId = 900;
  let clock = 0;
  const reply = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const failedRun = {
    id: 77,
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'main',
    html_url: `https://github.com/${REPO}/actions/runs/77`,
    updated_at: new Date().toISOString(),
  };
  const base = `/repos/${REPO}`;
  const show = (ruleset) => {
    if (!options.hideBypass) {
      return ruleset;
    }
    const { bypass_actors, ...rest } = ruleset;
    void bypass_actors;
    return rest;
  };
  const all = () => [...state.rulesets, ...state.orgRulesets];

  function effective(branch) {
    return all()
      .filter((ruleset) => ruleset.enforcement === 'active')
      .filter((ruleset) => covers(ruleset, branch))
      .flatMap((ruleset) =>
        ruleset.rules.map((rule) => ({
          ...rule,
          ruleset_source_type: ruleset.source_type,
          ruleset_source: ruleset.source,
          ruleset_id: ruleset.id,
        }))
      );
  }

  function blobs() {
    return Object.entries(state.workflows).map(([path, content], index) => ({
      path,
      type: 'blob',
      sha: `blob${index}`,
      content,
    }));
  }

  function route(path, method, body, page) {
    if (path === base) {
      return reply({
        name: 'links-notation',
        full_name: REPO,
        default_branch: 'main',
        archived: false,
        ...options.repository,
      });
    }
    if (path === `${base}/branches/main`) {
      return reply({ name: 'main', commit: { sha: HEAD } });
    }
    if (path.startsWith(`${base}/branches/`) && path.endsWith('/protection')) {
      return state.classic && path === `${base}/branches/main/protection`
        ? reply(state.classic)
        : reply({ message: 'Branch not protected' }, 404);
    }
    if (path.startsWith(`${base}/branches/`)) {
      return reply({ message: 'Branch not found' }, 404);
    }
    if (path.startsWith(`${base}/rules/branches/`)) {
      const branch = decodeURIComponent(path.split('/rules/branches/')[1]);
      return reply(page > 1 ? [] : effective(branch));
    }
    if (path === `${base}/actions/workflows`) {
      return reply({
        workflows: Object.keys(state.workflows).map((file, index) => ({
          id: index + 1,
          path: file,
        })),
      });
    }
    const runs = path.match(/\/actions\/workflows\/([^/]+)\/runs$/);
    if (runs) {
      const failed = options.failedLog !== undefined && runs[1] === 'ci.yml';
      return reply({ workflow_runs: failed ? [failedRun] : [] });
    }
    if (path === `${base}/actions/runs/77`) {
      return reply(failedRun);
    }
    if (path === `${base}/actions/runs/77/jobs`) {
      return reply({
        jobs: [{ id: 78, name: 'Kotlin', conclusion: 'failure' }],
      });
    }
    if (path === `${base}/actions/jobs/78/logs`) {
      return reply(options.failedLog ?? '');
    }
    if (
      path === `${base}/git/trees/${HEAD}` ||
      path === `${base}/git/trees/main`
    ) {
      return reply({
        sha: HEAD,
        truncated: false,
        tree: blobs().map(({ path: file, type, sha }) => ({
          path: file,
          type,
          sha,
        })),
      });
    }
    const blob = path.match(/\/git\/blobs\/(.+)$/);
    if (blob) {
      const found = blobs().find((item) => item.sha === blob[1]);
      return reply({
        encoding: 'base64',
        content: Buffer.from(found.content).toString('base64'),
      });
    }
    if (path === `${base}/commits/${HEAD}/check-runs`) {
      const runs = state.checkRuns.slice((page - 1) * 100, page * 100);
      return reply({ total_count: state.checkRuns.length, check_runs: runs });
    }
    if (path === `${base}/rulesets`) {
      if (method === 'POST') {
        const saved = {
          ...body,
          id: nextId++,
          source_type: 'Repository',
          source: REPO,
          updated_at: `2026-11-03T00:00:0${clock++}.000Z`,
        };
        state.rulesets.push(saved);
        return reply(saved, 201);
      }
      return reply(
        page > 1
          ? []
          : all().map(({ id, name, source_type, source }) => ({
              id,
              name,
              source_type,
              source,
            }))
      );
    }
    const one = path.match(/\/rulesets\/(\d+)$/);
    if (one) {
      const ruleset = all().find((item) => item.id === Number(one[1]));
      if (!ruleset) {
        return reply({ message: 'Not Found' }, 404);
      }
      if (method === 'PUT') {
        Object.assign(ruleset, body, {
          updated_at: `2026-11-03T00:00:0${clock++}.000Z`,
        });
      }
      return reply(show(ruleset));
    }
    return reply({ message: 'Not Found' }, 404);
  }

  const rest = createRestClient({
    token: 'fake',
    fetch: async (url, request) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const method = request.method ?? 'GET';
      const body = request.body ? JSON.parse(request.body) : null;
      calls.push({ path: `${path}${parsed.search}`, method, body });
      if (method === 'GET') {
        options.onRead?.({ path, state, calls });
      }
      const denied = options.reject?.({ path, method, body, calls });
      if (denied) {
        return reply({ message: denied.message }, denied.status);
      }
      return route(
        path,
        method,
        body,
        Number(parsed.searchParams.get('page') ?? 1)
      );
    },
  });
  return {
    rest,
    calls,
    state,
    writes: () => calls.filter((call) => call.method !== 'GET'),
  };
}
