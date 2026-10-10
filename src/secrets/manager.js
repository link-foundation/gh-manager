import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createSecretApi, secretName } from './api.js';
import { selectedTargets } from '../github/discovery.js';
import { createSecretHealth } from './health.js';

function normalizedExpiry(value) {
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

// Callback errors may include credentials. Do not retain their cause or stack.
async function callCallback(callback, input, label) {
  try {
    return await callback(input);
  } catch {
    throw new CliError(
      `Secret ${label} callback failed; values were withheld.`
    );
  }
}

function expiryReason(expiresAt, now, window) {
  if (!expiresAt) {
    return null;
  }
  const deadline = Date.parse(expiresAt);
  if (deadline <= now) {
    return 'expired';
  }
  return deadline <= now + window ? 'expiring' : null;
}

function rotationWindow(settings) {
  const window = settings.rotateBeforeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(window) || window < 0) {
    throw new CliError(
      'Rotation window must be a nonnegative duration.',
      EXIT_CODES.USAGE
    );
  }
  return window;
}

function preserveAccess(scope, metadata, settings) {
  if (!scope.org || !metadata) {
    return settings;
  }
  const visibility = settings.visibility ?? metadata.visibility;
  const repos =
    visibility === 'selected'
      ? [
          ...new Set([
            ...(settings.repos ?? []),
            ...(metadata.selected_repositories?.map((repo) => repo.full_name) ??
              []),
          ]),
        ]
      : settings.repos;
  return { ...settings, visibility, repos };
}

function orgRefusal(message) {
  const error = new CliError(message);
  error.status = 403;
  error.organizationSecretRefused = true;
  return error;
}

class SecretManager {
  constructor(options) {
    this.options = options;
    this.api = createSecretApi(options);
    this.scope = options.scope;
    this.now = options.now ?? Date.now;
  }

  plan(operation, name, settings) {
    return {
      operation,
      name,
      scope: this.scope,
      visibility:
        settings.visibility ?? (this.scope.org ? 'selected' : undefined),
      repos: settings.repos,
      dryRun: true,
    };
  }

  list(options) {
    return this.api.list(options);
  }
  getMetadata(name) {
    return this.api.getMetadata(name);
  }

  async set(name, value, settings = {}) {
    name = secretName(name);
    secretName(`${name}_EXPIRES_AT`);
    const expiresAt = normalizedExpiry(settings.expiresAt);
    const grants = await this.api.access(settings);
    if (settings.dryRun) {
      return this.plan('set', name, settings);
    }
    await this.api.set(name, value, grants);
    await this.api.writeExpiry(name, expiresAt, grants);
    return {
      name,
      changed: true,
      valueChanged: true,
      verified: true,
      verification:
        'GitHub accepted the encrypted value and metadata/access were re-read; plaintext is never readable.',
      expiresAt,
    };
  }

  async assess(name, metadata, settings, window) {
    if (!metadata) {
      return { reason: 'absent', expiresAt: null };
    }
    let expiresAt = normalizedExpiry(await this.api.expiry(name));
    let valid = false;
    if (settings.validate && !settings.dryRun) {
      const result = await callCallback(
        settings.validate,
        { name, scope: this.scope, metadata, expiresAt },
        'validation'
      );
      if (typeof result?.valid !== 'boolean') {
        throw new CliError(
          'Validity is unknown; validation must return { valid: true|false }.'
        );
      }
      if (!result.valid) {
        return { reason: 'invalid', expiresAt };
      }
      valid = true;
      expiresAt = normalizedExpiry(result.expiresAt ?? expiresAt);
    }
    const health = await this.currentHealth(name, settings, expiresAt);
    if (health?.status === 'auth-failing') {
      return { reason: settings.reason ?? 'auth-failing', expiresAt };
    }
    return {
      reason: expiryReason(expiresAt, this.now(), window),
      expiresAt,
      valid,
    };
  }

  async currentHealth(name, settings, expiresAt) {
    let health = settings.health;
    if (
      !health &&
      !settings.validate &&
      !expiresAt &&
      !settings.dryRun &&
      !this.scope.environment
    ) {
      try {
        health = await createSecretHealth(this.options).health(name, {
          scope: this.scope,
          repos: settings.repos,
          failurePatterns: settings.failurePatterns,
        });
      } catch {
        health = { status: 'unknown' };
      }
    }
    return health;
  }

  async candidate(name, metadata, reason, settings, window) {
    if (typeof settings.acquire !== 'function') {
      throw new CliError(
        'An acquisition callback or stdin value is required to create or rotate this secret.',
        EXIT_CODES.USAGE
      );
    }
    const acquired = await callCallback(
      settings.acquire,
      { name, scope: this.scope, metadata, reason },
      'acquisition'
    );
    const token = typeof acquired === 'string' ? { value: acquired } : acquired;
    if (!token || typeof token.value !== 'string') {
      throw new CliError('Acquisition must return a secret value.');
    }
    let checked = {};
    if (settings.validate) {
      checked = await callCallback(
        settings.validate,
        { name, scope: this.scope, value: token.value },
        'validation'
      );
      if (checked?.valid !== true) {
        throw new CliError(
          'The callback did not validate the replacement secret.'
        );
      }
    }
    const expiresAt = normalizedExpiry(
      token.expiresAt ?? checked.expiresAt ?? settings.expiresAt
    );
    if (expiryReason(expiresAt, this.now(), window)) {
      throw new CliError(
        'The replacement token is already expired or inside the rotation window.'
      );
    }
    return { value: token.value, expiresAt };
  }

  async ensure(name, settings = {}) {
    name = secretName(name);
    if (
      !this.scope.org ||
      !settings.repos?.length ||
      settings.fallback === false
    ) {
      return this.ensureScoped(name, settings);
    }
    if (settings.visibility && settings.visibility !== 'selected') {
      throw new CliError(
        'Organization-first ensure requires selected visibility.',
        EXIT_CODES.USAGE
      );
    }
    const repositories = selectedTargets(this.scope.org, settings.repos);
    let acquired;
    const acquire =
      settings.acquire &&
      ((input) => {
        acquired ??= callCallback(settings.acquire, input, 'acquisition');
        return acquired;
      });
    try {
      await this.checkOrganizationPlan(repositories, settings);
      const result = await this.ensureScoped(name, {
        ...settings,
        visibility: 'selected',
        acquire,
      });
      return { ...result, path: 'organization' };
    } catch (error) {
      if (
        !error.organizationSecretRefused ||
        ![403, 404, 422].includes(error.status)
      ) {
        throw error;
      }
      return this.ensureFallback(
        name,
        repositories,
        { ...settings, acquire },
        error
      );
    }
  }

  async checkOrganizationPlan(repositories, settings) {
    let organization;
    try {
      organization = await this.options.rest.request(
        `/orgs/${encodeURIComponent(this.scope.org)}`
      );
    } catch {
      /* Account metadata is optional; the secrets API remains authoritative. */
    }
    if (organization?.plan?.name !== 'free' || settings.dryRun) {
      return;
    }
    for (const repo of repositories) {
      if ((await this.api.repository(`${repo.owner}/${repo.name}`)).private) {
        throw orgRefusal(
          'Organization plan does not expose secrets to private repositories.'
        );
      }
    }
  }

  async ensureFallback(name, repositories, settings, error) {
    const results = [];
    const revocations = [];
    for (const repo of repositories) {
      const scope = { repo };
      const manager = new SecretManager({ ...this.options, scope });
      results.push({
        ...(await manager.ensureScoped(name, {
          ...settings,
          visibility: undefined,
          repos: undefined,
          revokePrevious:
            settings.revokePrevious &&
            ((context) => {
              revocations.push(context);
            }),
        })),
        scope,
      });
    }
    for (const context of revocations) {
      await callCallback(settings.revokePrevious, context, 'revocation');
    }
    return {
      name,
      changed: results.some((result) => result.changed),
      valueChanged: results.some((result) => result.valueChanged),
      path: 'repository',
      fallbackReason: `${error.message} Used selected repository secrets.`,
      results,
    };
  }

  async ensureAccess(name, metadata, settings) {
    if (!this.scope.org || !settings.repos?.length || !metadata) {
      return false;
    }
    if (metadata.visibility === 'all') {
      return false;
    }
    const repositories = await Promise.all(
      settings.repos.map((repo) => this.api.repository(repo))
    );
    if (metadata.visibility === 'private') {
      if (repositories.some((repo) => !repo.private)) {
        throw orgRefusal(
          'Existing private-only organization secret cannot be exposed to a public repository without replacing its value.'
        );
      }
      return false;
    }
    const missing = repositories.filter(
      (repo) =>
        !metadata.selected_repositories?.some((grant) => grant.id === repo.id)
    );
    if (!missing.length) {
      return false;
    }
    await this.api.addRepositories(name, missing);
    return true;
  }

  async ensureScoped(name, settings = {}) {
    name = secretName(name);
    secretName(`${name}_EXPIRES_AT`);
    normalizedExpiry(settings.expiresAt);
    const window = rotationWindow(settings);
    const metadata = await this.api.getMetadata(name);
    const state = await this.assess(name, metadata, settings, window);
    const options = preserveAccess(this.scope, metadata, settings);
    if (settings.dryRun) {
      return {
        ...this.plan('ensure', name, options),
        reason: state.reason ?? 'existing',
      };
    }
    if (!state.reason) {
      const accessChanged = await this.ensureAccess(name, metadata, settings);
      if (
        state.expiresAt &&
        state.expiresAt !== (await this.api.expiry(name))
      ) {
        await this.api.writeExpiry(
          name,
          state.expiresAt,
          await this.api.access(options)
        );
      }
      return {
        name,
        changed: accessChanged,
        valueChanged: false,
        reason: state.valid || state.expiresAt ? 'valid' : 'existing',
        expiresAt: state.expiresAt,
      };
    }
    // Resolve access before asking the caller to acquire a replacement.
    await this.api.access(options);
    const token = await this.candidate(
      name,
      metadata,
      state.reason,
      settings,
      window
    );
    const result = await this.set(name, token.value, {
      ...options,
      expiresAt: token.expiresAt,
    });
    if (metadata && settings.revokePrevious) {
      await callCallback(
        settings.revokePrevious,
        { name, scope: this.scope, metadata },
        'revocation'
      );
    }
    return { ...result, reason: state.reason };
  }

  async delete(name, settings = {}) {
    name = secretName(name);
    secretName(`${name}_EXPIRES_AT`);
    if (settings.dryRun) {
      return this.plan('delete', name, settings);
    }
    await this.api.delete(name);
    return { name, changed: true, verified: true };
  }

  async cleanup(names, settings = {}) {
    if (!Array.isArray(names) || !names.length || !settings.reason) {
      throw new CliError(
        'Cleanup requires explicit secret names and a reason.',
        EXIT_CODES.USAGE
      );
    }
    names = names.map(secretName);
    const existing = (await this.api.list()).filter((item) =>
      names.includes(item.name)
    );
    if (settings.dryRun) {
      return {
        reason: settings.reason,
        names: existing.map((item) => item.name),
        dryRun: true,
        requires: 'Caller verification before deletion',
      };
    }
    if (
      !settings.verify ||
      (await callCallback(
        settings.verify,
        {
          names,
          reason: settings.reason,
          scope: this.scope,
          secrets: existing,
        },
        'cleanup verification'
      )) !== true
    ) {
      throw new CliError('Cleanup is not verified; secrets were retained.');
    }
    for (const item of existing) {
      await this.api.delete(item.name);
    }
    return {
      reason: settings.reason,
      deleted: existing.map((item) => item.name),
      verified: true,
    };
  }
}

/** Generic Actions secrets service for library and CLI consumers. */
export function createSecretManager(options) {
  return new SecretManager(options);
}
