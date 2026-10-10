import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against either this checkout or an installed tarball's package directory.
const directory = resolve(process.argv[2] ?? '.');
const api = await import(pathToFileURL(join(directory, 'src/index.js')));
const metadata = JSON.parse(readFileSync(join(directory, 'package.json')));
const rest = api.createRestClient({
  token: 'fixture',
  fetch: () =>
    Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve([]) }),
});
const options = { rest };
assert.equal(api.secrets, api.createSecretManager);
assert.equal(api.health, api.createSecretHealth);
assert.equal(api.repos, api.createRepoManager);
assert.equal(api.runs, api.createRunManager);
assert.deepEqual(await api.repos(options).list({ org: 'acme' }), []);
assert.equal(typeof api.runs(options).logs, 'function');
assert.equal(
  typeof api.secrets({ ...options, scope: { org: 'acme' } }).ensure,
  'function'
);
assert.equal(
  (
    await api.health(options).health('CUSTOM_TOKEN', {
      scope: { repo: { owner: 'acme', name: 'one' } },
    })
  ).status,
  'unknown'
);
console.log(
  `Packed ${metadata.name}@${metadata.version}: stable services verified`
);
