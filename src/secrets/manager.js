import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createSecretApi, secretName } from './api.js';
import { TRUSTED_PUBLISHING_SECRETS, requireStoredToken } from './policy.js';

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
async function callRegistry(callback, input, label) {
  try {
    return await callback(input);
  } catch {
    throw new CliError(`Registry ${label} failed; token values were withheld.`);
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
      ? (settings.repos ??
        metadata.selected_repositories?.map((repo) => repo.full_name))
      : settings.repos;
  return { ...settings, visibility, repos };
}

class SecretManager {
  constructor(options) {
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
    requireStoredToken(name, settings.registry);
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
      const result = await callRegistry(
        settings.validate,
        { name, scope: this.scope, metadata, expiresAt },
        'validation'
      );
      if (typeof result?.valid !== 'boolean') {
        throw new CliError(
          'Registry validity is unknown; validation must return { valid: true|false }.'
        );
      }
      if (!result.valid) {
        return { reason: 'invalid', expiresAt };
      }
      valid = true;
      expiresAt = normalizedExpiry(result.expiresAt ?? expiresAt);
    }
    return {
      reason: expiryReason(expiresAt, this.now(), window),
      expiresAt,
      valid,
    };
  }

  async candidate(name, metadata, reason, settings, window) {
    if (typeof settings.acquire !== 'function') {
      throw new CliError(
        'A registry acquisition callback or stdin value is required to create or rotate this token.',
        EXIT_CODES.USAGE
      );
    }
    const acquired = await callRegistry(
      settings.acquire,
      { name, scope: this.scope, metadata, reason },
      'acquisition'
    );
    const token = typeof acquired === 'string' ? { value: acquired } : acquired;
    if (!token || typeof token.value !== 'string') {
      throw new CliError('Registry acquisition must return a token value.');
    }
    let checked = {};
    if (settings.validate) {
      checked = await callRegistry(
        settings.validate,
        { name, scope: this.scope, value: token.value },
        'validation'
      );
      if (checked?.valid !== true) {
        throw new CliError(
          'The registry did not validate the replacement token.'
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
    requireStoredToken(name, settings.registry);
    secretName(`${name}_EXPIRES_AT`);
    normalizedExpiry(settings.expiresAt);
    const window = rotationWindow(settings);
    const metadata = await this.api.getMetadata(name);
    const state = await this.assess(name, metadata, settings, window);
    const options = preserveAccess(this.scope, metadata, settings);
    if (settings.dryRun) {
      return {
        ...this.plan('ensure', name, options),
        reason: state.reason ?? 'registry-validation-required',
      };
    }
    if (!state.reason) {
      if (!state.expiresAt && !state.valid) {
        throw new CliError(
          'Existing token validity is unknown; supply a registry validator or recorded expiry.'
        );
      }
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
        changed: false,
        reason: 'valid',
        expiresAt: state.expiresAt,
      };
    }
    // Resolve access before asking a registry to create a token.
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
      await callRegistry(
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

  async cleanup(registry, settings = {}) {
    const names = TRUSTED_PUBLISHING_SECRETS[registry?.toLowerCase()];
    if (!names) {
      throw new CliError(
        'Cleanup requires a registry that supports trusted publishing.',
        EXIT_CODES.USAGE
      );
    }
    const existing = (await this.api.list()).filter((item) =>
      names.includes(item.name)
    );
    if (settings.dryRun) {
      return {
        registry,
        names: existing.map((item) => item.name),
        dryRun: true,
        requires: 'Verified trusted publishing before deletion',
      };
    }
    if (
      !settings.verifyTrustedPublishing ||
      (await callRegistry(
        settings.verifyTrustedPublishing,
        { registry, scope: this.scope, secrets: existing },
        'trusted publishing verification'
      )) !== true
    ) {
      throw new CliError(
        'Trusted publishing is not verified; legacy secrets were retained.'
      );
    }
    for (const item of existing) {
      await this.api.delete(item.name);
    }
    return {
      registry,
      deleted: existing.map((item) => item.name),
      verified: true,
    };
  }
}

/** Secrets service for package-registry-manager and CLI consumers. */
export function createSecretManager(options) {
  return new SecretManager(options);
}
