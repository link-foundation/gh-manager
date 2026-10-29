import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';
import { repositoryTarget, accountName, pages } from '../github/discovery.js';
import { pollUntil, VERIFICATION_INTERVAL_MS } from '../verification.js';

export function variableName(name) {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name) ||
    /^GITHUB_/i.test(name)
  ) {
    throw new CliError(
      'Variable names must contain letters, digits or underscores, cannot start with a digit or GITHUB_, and must fit in 256 characters.',
      EXIT_CODES.USAGE
    );
  }
  return name.toUpperCase();
}

export function variableScope(scope) {
  if (scope?.org && !scope.repo && scope.environment === undefined) {
    accountName(scope.org);
    return { org: scope.org };
  }
  if (scope?.repo && !scope.org) {
    const repo = repositoryTarget(scope.repo);
    const environment = scope.environment;
    if (
      environment !== undefined &&
      (typeof environment !== 'string' ||
        !environment ||
        ['.', '..'].includes(environment))
    ) {
      throw new CliError(
        'Supply a nonempty environment name without dot path segments.',
        EXIT_CODES.USAGE
      );
    }
    return { repo, ...(environment === undefined ? {} : { environment }) };
  }
  throw new CliError(
    'Choose one Actions variable scope: organization, repository, or repository environment.',
    EXIT_CODES.USAGE
  );
}

export function variableBase(scope) {
  return scope.org
    ? `/orgs/${encodeURIComponent(scope.org)}/actions`
    : scope.environment
      ? `${repoPath(scope.repo)}/environments/${encodeURIComponent(scope.environment)}`
      : `${repoPath(scope.repo)}/actions`;
}

function requiredPermission(path) {
  if (path.startsWith('/orgs/')) {
    return 'Variables organization permission (read for reads, write for changes), or admin:org';
  }
  if (path.includes('/environments/')) {
    return 'Environments repository permission (read for reads, write for changes), or repo scope and repository admin access';
  }
  if (path.includes('/actions/')) {
    return 'Variables repository permission (read for reads, write for changes), or repo scope';
  }
  return 'Metadata repository permission (read), or repo scope for a private repository';
}

export function createVariableApi({
  rest,
  scope,
  log,
  verificationTimeout = 15000,
}) {
  if (!Number.isFinite(verificationTimeout) || verificationTimeout < 0) {
    throw new CliError(
      'Verification timeout must be finite and nonnegative.',
      EXIT_CODES.USAGE
    );
  }
  const base = variableBase(scope);
  async function send(path, options = {}, allowNotFound = false) {
    if (!rest?.hasToken) {
      throw new CliError(
        'Actions variables require an API token. Run gh auth login.',
        EXIT_CODES.AUTH
      );
    }
    log?.debug(`variables API: ${options.method ?? 'GET'} ${path}`);
    const response = await rest.send(path, options);
    if (response.status === 404 && allowNotFound) {
      return null;
    }
    if (!response.ok) {
      const denied = [401, 403].includes(response.status);
      const permission = requiredPermission(path);
      const error = new CliError(
        `GitHub HTTP ${response.status}: Actions Variables ${denied ? `access denied; requires ${permission}` : 'setting unavailable, immutable, or request rejected; check target, plan and policy'}.`,
        denied ? EXIT_CODES.AUTH : EXIT_CODES.FAILURE
      );
      error.status = response.status;
      throw error;
    }
    return response.body;
  }
  const client = { request: send };
  const list = (path = `${base}/variables`, property = 'variables') =>
    pages(client, path, property);
  async function get(name) {
    const item = await send(
      `${base}/variables/${variableName(name)}`,
      {},
      true
    );
    if (item === null) {
      // A private/inaccessible resource can also return 404. Prove list access.
      await list();
      return null;
    }
    if (item?.name?.toUpperCase() !== name || typeof item.value !== 'string') {
      throw new CliError('GitHub returned incomplete Actions variable state.');
    }
    if (scope.org && item.visibility === 'selected') {
      item.selected_repositories = await list(
        `${base}/variables/${name}/repositories`,
        'repositories'
      );
      if (
        item.selected_repositories.some(
          (repo) => !Number.isSafeInteger(repo.id) || repo.id <= 0
        )
      ) {
        throw new CliError(
          'GitHub returned incomplete selected repository state.'
        );
      }
    }
    return { ...item, scope };
  }
  async function verify(read, accept) {
    const result = await pollUntil({
      read,
      accept,
      timeout: verificationTimeout,
      interval: VERIFICATION_INTERVAL_MS,
    });
    if (!result.accepted) {
      throw new CliError(
        'GitHub did not confirm the Actions variable operation.',
        EXIT_CODES.VERIFICATION_FAILED
      );
    }
    return result.value;
  }
  return { base, send, list, get, verify };
}
