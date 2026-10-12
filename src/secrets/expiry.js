import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';
import { repositoryTarget, pages } from '../github/discovery.js';
import { secretName } from './api.js';

export function normalizedExpiry(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const instant = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(instant)) {
    throw new CliError(
      'Token expiry must be an ISO date string.',
      EXIT_CODES.USAGE
    );
  }
  return new Date(instant).toISOString();
}

export function rotationWindow(settings) {
  const window = settings.rotateBeforeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(window) || window < 0) {
    throw new CliError(
      'Rotation window must be a nonnegative duration.',
      EXIT_CODES.USAGE
    );
  }
  return window;
}

export function expiryReason(expiresAt, now, window) {
  if (!expiresAt) {
    return null;
  }
  const deadline = Date.parse(expiresAt);
  return deadline <= now
    ? 'expired'
    : deadline <= now + window
      ? 'expiring'
      : null;
}

async function recordedExpiry(rest, scope, name) {
  const variable = secretName(`${name}_EXPIRES_AT`);
  const base = scope.org
    ? `/orgs/${encodeURIComponent(scope.org)}/actions`
    : `${repoPath(repositoryTarget(scope.repo))}/actions`;
  const own = await rest.request(`${base}/variables/${variable}`, {
    allowNotFound: true,
  });
  if (own || scope.org) {
    return { value: own?.value ?? null, scope };
  }
  const override = await rest.request(`${base}/secrets/${name}`, {
    allowNotFound: true,
  });
  if (override) {
    return { value: null, scope };
  }
  // Repository-visible organization variables do not need admin:org.
  try {
    const inherited = await pages(
      rest,
      `${base}/organization-variables`,
      'variables'
    );
    const recorded = inherited.find((item) => item.name === variable);
    if (recorded) {
      return {
        value: recorded.value,
        scope: { org: repositoryTarget(scope.repo).owner },
      };
    }
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
  try {
    const secrets = await pages(
      rest,
      `${base}/organization-secrets`,
      'secrets'
    );
    if (secrets.some((secret) => secret.name === name)) {
      return {
        value: null,
        scope: { org: repositoryTarget(scope.repo).owner },
      };
    }
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
  return { value: null, scope };
}

export async function healthExpiry(rest, name, options, now) {
  const window = rotationWindow(options);
  let recorded;
  try {
    recorded = await recordedExpiry(rest, options.scope, name);
  } catch {
    return {
      status: 'unknown',
      reason: 'expiry-unreadable',
      scope: options.scope,
    };
  }
  const { value, scope } = recorded;
  if (value === null) {
    return { status: 'unknown', reason: 'expiry-absent', scope };
  }
  try {
    const expiresAt = normalizedExpiry(value);
    return {
      status: expiryReason(expiresAt, now(), window) ?? 'valid',
      expiresAt,
      scope,
    };
  } catch {
    return { status: 'unknown', reason: 'expiry-invalid', scope };
  }
}
