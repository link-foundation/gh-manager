import {
  createRestClient,
  createSecretHealth,
  resolveToken,
} from '../src/index.js';

// Read-only reproduction against the repository named in the issue.
const { token } = resolveToken();
const result = await createSecretHealth({
  rest: createRestClient({ token }),
  log: {
    debug: (message) => console.error(message),
    progress: (message) => console.error(message),
  },
}).health('CARGO_TOKEN', { scope: { repo: 'link-foundation/start' } });
console.log(JSON.stringify(result, null, 2));
