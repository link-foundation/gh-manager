import { URL } from 'node:url';
import sodium from 'libsodium-wrappers';
import { createRestClient } from '../../src/github/rest.js';

const answer = (status, body) => ({
  status,
  ok: status < 400,
  json: async () => body,
});

function metadata(item) {
  const result = { ...item };
  delete result.value;
  return result;
}

function read(store, kind, name, sub, url) {
  if (!name) {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const entries = [...store.values()]
      .slice((page - 1) * 100, page * 100)
      .map(metadata);
    return answer(200, { total_count: store.size, [kind]: entries });
  }
  const item = store.get(name);
  if (sub === 'repositories') {
    const ids = item?.selected_repository_ids || [];
    return answer(200, {
      total_count: ids.length,
      repositories: ids.map((id) => ({
        id,
        name: id === 11 ? 'one' : 'two',
        full_name: id === 11 ? 'acme/one' : 'acme/two',
      })),
    });
  }
  return item
    ? answer(200, kind === 'variables' ? item : metadata(item))
    : answer(404, {});
}

function write(store, kind, name, body, keys) {
  const target = name || body.name;
  const value =
    kind === 'secrets'
      ? sodium.to_string(
          sodium.crypto_box_seal_open(
            sodium.from_base64(
              body.encrypted_value,
              sodium.base64_variants.ORIGINAL
            ),
            keys.publicKey,
            keys.privateKey
          )
        )
      : body.value;
  store.set(target, {
    name: target,
    updated_at: new Date().toISOString(),
    ...body,
    value,
  });
}

// Stateful API: writes are decrypted with the private key retained only here.
export async function secretsApi({
  base = '/orgs/acme/actions',
  denied = false,
  ignoreWrites = false,
} = {}) {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  const secrets = new Map();
  const variables = new Map();
  const calls = [];
  const ids = { one: 11, two: 22 };
  const rest = createRestClient({
    token: 'fake',
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const method = options.method;
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path, method, body });
      if (denied) {
        return answer(403, { message: 'Not permitted' });
      }
      if (
        path.startsWith('/repos/acme/') &&
        !path.includes('/actions') &&
        !path.includes('/environments')
      ) {
        return answer(200, { id: ids[path.split('/').pop()] });
      }
      if (path === `${base}/secrets/public-key`) {
        return answer(200, {
          key_id: 'key-1',
          key: sodium.to_base64(
            keys.publicKey,
            sodium.base64_variants.ORIGINAL
          ),
        });
      }
      const relative = path.slice(base.length + 1).split('/');
      const [kind, name, sub] = relative;
      const store = kind === 'secrets' ? secrets : variables;
      if (method === 'GET') {
        return read(store, kind, name, sub, url);
      }
      if (method === 'DELETE') {
        if (!ignoreWrites) {
          store.delete(name);
        }
        return answer(204);
      }
      if (!ignoreWrites) {
        write(store, kind, name, body, keys);
      }
      return answer(method === 'POST' ? 201 : 204);
    },
  });
  return { rest, calls, secrets, variables, base };
}
