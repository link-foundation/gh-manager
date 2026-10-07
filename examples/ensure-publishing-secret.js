import {
  createRestClient,
  createSecretManager,
  resolveToken,
} from '../src/index.js';

// package-registry-manager supplies registry-specific callbacks. Its validator
// checks existing credentials through registry/workflow state because GitHub
// cannot return a stored secret value. New candidates receive an in-memory value.
export function ensureDockerHubToken({
  organization,
  repositories,
  validate,
  acquire,
  revokePrevious,
}) {
  const { token } = resolveToken();
  const manager = createSecretManager({
    rest: createRestClient({ token }),
    scope: { org: organization },
  });
  return manager.ensure('DOCKERHUB_TOKEN', {
    registry: 'dockerhub',
    repos: repositories,
    validate,
    acquire,
    revokePrevious,
  });
}
