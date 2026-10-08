import { URL } from 'node:url';
import { createRestClient } from '../../src/github/rest.js';

export function protectionApi(options = {}) {
  const repositories = options.repositories ?? [repository('one')];
  const rulesets = new Map(Object.entries(options.rulesets ?? {}));
  const protections = new Map(Object.entries(options.protections ?? {}));
  const calls = [];
  let nextId = 100;
  const reply = (body, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(JSON.stringify(body)),
  });

  function branchResponse(path, method, body) {
    if (path.endsWith('/branches')) {
      return reply(
        options.empty ? [] : [{ name: 'main' }, { name: 'feature/work' }]
      );
    }
    if (path.includes('/rules/branches/')) {
      const repoBase = `${path.split('/rules/branches/')[0]}/rulesets`;
      return reply(
        options.unverified
          ? []
          : [
              ...(rulesets.get(repoBase) ?? []),
              ...(rulesets.get('/orgs/acme/rulesets') ?? []),
            ]
              .filter((ruleset) => ruleset.enforcement === 'active')
              .flatMap((ruleset) => ruleset.rules)
      );
    }
    if (path.includes('/branches/') && path.endsWith('/protection')) {
      if (method === 'PUT') {
        protections.set(path, body);
        return reply(body);
      }
      const protection = protections.get(path);
      if (!protection) {
        return reply({ message: 'Branch not protected' }, 404);
      }
      return reply({
        ...protection,
        allow_deletions: {
          enabled: options.unverified || protection.allow_deletions === true,
        },
        allow_force_pushes: {
          enabled: options.unverified || protection.allow_force_pushes === true,
        },
      });
    }
  }

  function rulesetResponse(path, method, body, page) {
    const match = path.match(/^(.*\/rulesets)(?:\/(\d+))?$/);
    if (match) {
      const [, base, id] = match;
      const items = rulesets.get(base) ?? [];
      if (method === 'GET') {
        if (id) {
          return reply(
            items.find((item) => item.id === Number(id)) ?? {},
            items.some((item) => item.id === Number(id)) ? 200 : 404
          );
        }
        return reply(
          items
            .slice((page - 1) * 100, page * 100)
            .map(({ id, name, source_type, source }) => ({
              id,
              name,
              source_type,
              source,
            }))
        );
      }
      const ruleset = {
        ...body,
        id: id ? Number(id) : nextId++,
        source_type: base.startsWith('/orgs') ? 'Organization' : 'Repository',
        source: base.split('/').slice(2, -1).join('/'),
      };
      rulesets.set(base, [
        ...items.filter((item) => item.id !== ruleset.id),
        ruleset,
      ]);
      return reply(ruleset, method === 'POST' ? 201 : 200);
    }
  }

  const rest = createRestClient({
    token: options.noToken ? null : 'fake',
    fetch: async (url, request) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const method = request.method;
      const body = request.body ? JSON.parse(request.body) : null;
      calls.push({ path: `${path}${parsed.search}`, method, body });
      const denied = options.reject?.({ path, method, body, calls });
      if (denied) {
        return reply({ message: denied.message }, denied.status);
      }
      if (path === '/user') {
        return reply({ login: 'acme' });
      }
      if (path.endsWith('/repos')) {
        const page = Number(parsed.searchParams.get('page'));
        return reply(repositories.slice((page - 1) * 100, page * 100));
      }
      const found = repositories.find(
        (repo) => path === `/repos/${repo.full_name}`
      );
      if (found) {
        return reply(found);
      }
      return (
        branchResponse(path, method, body) ??
        rulesetResponse(
          path,
          method,
          body,
          Number(parsed.searchParams.get('page'))
        ) ??
        reply({ message: 'Not Found' }, 404)
      );
    },
  });
  return { rest, calls, rulesets, protections, repositories };
}

export function repository(name, extra = {}) {
  return {
    name,
    full_name: `acme/${name}`,
    owner: { login: 'acme' },
    default_branch: 'main',
    archived: false,
    fork: false,
    ...extra,
  };
}

export function protectionRuleset(extra = {}) {
  return {
    id: 7,
    name: 'protection',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    source_type: 'Repository',
    source: 'acme/one',
    ...extra,
  };
}
