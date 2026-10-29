import { URL } from 'node:url';
import { createRestClient } from '../../src/github/rest.js';

const answer = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

function readVariable(entries, name, sub, parsed) {
  const item = entries.get(name);
  if (sub) {
    return answer(200, {
      repositories: (item?.selected_repository_ids ?? []).map((id) => ({
        id,
        full_name: id === 11 ? 'acme/one' : 'acme/two',
      })),
    });
  }
  if (name) {
    return answer(item ? 200 : 404, item && { ...item });
  }
  const page = Number(parsed.searchParams.get('page') ?? 1);
  return answer(200, {
    variables: [...entries.values()].slice((page - 1) * 100, page * 100),
  });
}

export function variablesApi({
  base = '/orgs/acme/actions',
  denied = false,
  ignoreWrites = false,
  writeStatus,
} = {}) {
  const calls = [];
  const stores = new Map();
  const store = (path) => {
    if (!stores.has(path)) {
      stores.set(path, new Map());
    }
    return stores.get(path);
  };
  const rest = createRestClient({
    token: 'fake',
    fetch: async (url, options) => {
      const parsed = new URL(url);
      const call = {
        path: parsed.pathname,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      const { path, method, body } = call;
      if (denied) {
        return answer(403, {});
      }
      if (path.endsWith('/organization-variables')) {
        const variables = [...store('/orgs/acme/actions').values()].filter(
          (item) =>
            item.visibility === 'all' ||
            item.selected_repository_ids?.includes(11)
        );
        return answer(200, { variables });
      }
      if (path === '/repos/acme/one' || path === '/repos/acme/two') {
        return answer(200, {
          id: path.endsWith('/one') ? 11 : 22,
          full_name: path.slice(7),
        });
      }
      const match = path.match(
        /^(.*)\/variables(?:\/([^/]+))?(?:\/(repositories))?$/
      );
      if (!match) {
        return answer(404, {});
      }
      const [, prefix, name, sub] = match;
      const entries = store(prefix);
      if (method === 'GET') {
        return readVariable(entries, name, sub, parsed);
      }
      if (writeStatus) {
        return answer(writeStatus, {});
      }
      if (!ignoreWrites) {
        if (method === 'DELETE') {
          entries.delete(name);
        } else {
          entries.set(name ?? body.name, {
            ...(entries.get(name) ?? {}),
            ...body,
          });
        }
      }
      return answer(method === 'POST' ? 201 : 204);
    },
  });
  return { rest, calls, variables: store(base), store };
}
