import {
  createRestClient,
  secrets,
  health,
  repos,
  runs,
} from '../src/index.js';

// Compile-only consumer example: no requests run unless explicitly called.
export async function inspect() {
  const options = { rest: createRestClient({ token: null }) };
  const scope = { org: 'acme' };
  const state = await health(options).health('CUSTOM_TOKEN', { scope });
  const result = await secrets({ ...options, scope }).ensure('CUSTOM_TOKEN', {
    repos: ['one'],
    health: state,
    acquire: () => 'in-memory-value',
  });
  const repositories = await repos(options).list({ org: 'acme' });
  const logs = await runs(options).logs(1, { repo: 'acme/one', grep: ['401'] });
  return { result, repositories, logs };
}
