import sodium from 'libsodium-wrappers';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';
import {
  pollUntil,
  VERIFICATION_TIMEOUT_MS,
  VERIFICATION_INTERVAL_MS,
} from '../verification.js';

export function secretName(name) {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    name.length > 256 ||
    /^GITHUB_/i.test(name)
  ) {
    throw new CliError(
      'Secret names must be letters, digits or underscores, cannot start with a digit or GITHUB_, and must fit in 256 characters.',
      EXIT_CODES.USAGE
    );
  }
  return name.toUpperCase();
}

function validEnvironment(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..'
  );
}

function validPathPart(part) {
  return (
    typeof part === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(part) &&
    part !== '.' &&
    part !== '..'
  );
}

function scopePaths(scope) {
  if (
    scope?.org &&
    !scope.repo &&
    scope.environment === undefined &&
    validPathPart(scope.org)
  ) {
    const org = encodeURIComponent(scope.org);
    return {
      base: `/orgs/${org}/actions`,
      settings: `https://github.com/organizations/${org}/settings/secrets/actions`,
    };
  }
  if (
    scope?.repo &&
    !scope.org &&
    validPathPart(scope.repo.owner) &&
    validPathPart(scope.repo.name)
  ) {
    const base = repoPath(scope.repo);
    if (
      scope.environment !== undefined &&
      !validEnvironment(scope.environment)
    ) {
      throw new CliError(
        'An environment name must be nonempty and cannot be a dot path segment.',
        EXIT_CODES.USAGE
      );
    }
    return {
      base: scope.environment
        ? `${base}/environments/${encodeURIComponent(scope.environment)}`
        : `${base}/actions`,
      settings: `https://github.com/${encodeURIComponent(scope.repo.owner)}/${encodeURIComponent(scope.repo.name)}/settings/${scope.environment ? 'environments' : 'secrets/actions'}`,
    };
  }
  throw new CliError(
    'Choose an organization, repository, or repository environment secret scope.',
    EXIT_CODES.USAGE
  );
}

// Never expose API response messages, transport errors or arbitrary metadata fields.
function metadata(item) {
  return Object.fromEntries(
    ['name', 'created_at', 'updated_at', 'visibility']
      .filter((key) => item[key] !== undefined)
      .map((key) => [key, item[key]])
  );
}

function sameRepositoryIds(repositories, ids) {
  const sorted = (values) => [...values].sort((a, b) => a - b);
  return (
    JSON.stringify(sorted(repositories.map((repo) => repo.id))) ===
    JSON.stringify(sorted(ids))
  );
}

class SecretApi {
  constructor({
    rest,
    scope,
    log,
    verificationTimeout = VERIFICATION_TIMEOUT_MS,
  }) {
    Object.assign(
      this,
      { rest, scope, log, verificationTimeout },
      scopePaths(scope)
    );
  }
  async send(path, options = {}, allowNotFound = false) {
    if (!this.rest.hasToken) {
      throw new CliError(
        'Actions secrets require an API token. Run gh auth login.',
        EXIT_CODES.AUTH
      );
    }
    this.log?.debug(`secrets API: ${options.method ?? 'GET'} ${path}`);
    let result;
    try {
      result = await this.rest.send(path, options);
    } catch {
      throw new CliError(
        'GitHub secrets request failed; no token value was logged.'
      );
    }
    if (result.status === 404 && allowNotFound) {
      return null;
    }
    if (result.status === 401 || result.status === 403) {
      const resource = path.includes('/variables') ? 'Variables' : 'Secrets';
      const permission = this.scope.org
        ? `Organization ${resource.toLowerCase()} permission (read for reads, write for changes), or org admin access with admin:org. Run gh auth refresh -s admin:org; private repositories also need repo scope.`
        : `${this.scope.environment ? 'Environments' : resource} repository permission (read for reads, write for changes), or repo scope and repository admin access.`;
      throw new CliError(
        `GitHub HTTP ${result.status}: Actions secrets access denied. Use ${permission} Browser settings: ${this.settings}`,
        EXIT_CODES.AUTH
      );
    }
    if (!result.ok) {
      throw new CliError(
        `GitHub HTTP ${result.status}: Actions secrets operation failed. Check target access at ${this.settings}.`
      );
    }
    return result.body;
  }

  async pages(path, property) {
    const items = [];
    for (let page = 1; ; page++) {
      const body = await this.send(`${path}?per_page=100&page=${page}`);
      const batch = body?.[property];
      if (!Array.isArray(batch)) {
        throw new CliError(
          'GitHub returned an unexpected secrets metadata response.'
        );
      }
      items.push(...batch);
      if (batch.length < 100) {
        return items;
      }
    }
  }

  async repository(spec) {
    const parts = String(spec).split('/');
    const owner = parts.length === 1 ? this.scope.org : parts[0];
    const name = parts.length === 1 ? parts[0] : parts[1];
    if (
      parts.length > 2 ||
      owner?.toLowerCase() !== this.scope.org?.toLowerCase() ||
      !validPathPart(name)
    ) {
      throw new CliError(
        'Selected repositories must belong to the secret organization.',
        EXIT_CODES.USAGE
      );
    }
    const item = await this.send(repoPath({ owner, name }));
    if (!Number.isSafeInteger(item?.id) || item.id <= 0) {
      throw new CliError('GitHub did not return a repository ID.');
    }
    return item;
  }

  async access(options = {}) {
    if (!this.scope.org) {
      return {};
    }
    const visibility = options.visibility ?? 'selected';
    if (!['all', 'private', 'selected'].includes(visibility)) {
      throw new CliError(
        'Secret visibility must be all, private or selected.',
        EXIT_CODES.USAGE
      );
    }
    if (visibility !== 'selected' && options.repos?.length) {
      throw new CliError(
        'Repository grants require selected visibility.',
        EXIT_CODES.USAGE
      );
    }
    if (visibility === 'selected' && !options.repos?.length) {
      throw new CliError(
        'Selected organization secrets require at least one repository in repos / --repos.',
        EXIT_CODES.USAGE
      );
    }
    if (options.dryRun) {
      return { visibility };
    }
    return {
      visibility,
      ...(visibility === 'selected'
        ? {
            selected_repository_ids: [
              ...new Set(
                await Promise.all(
                  options.repos.map(
                    async (spec) => (await this.repository(spec)).id
                  )
                )
              ),
            ],
          }
        : {}),
    };
  }

  async getMetadata(name) {
    const normalized = secretName(name);
    const body = await this.send(
      `${this.base}/secrets/${normalized}`,
      {},
      true
    );
    if (body === null) {
      await this.pages(`${this.base}/secrets`, 'secrets');
      return null;
    }
    if (body?.name !== normalized) {
      throw new CliError('GitHub returned unexpected secret metadata.');
    }
    const result = metadata(body);
    if (this.scope.org && body.visibility === 'selected') {
      result.selected_repositories = (
        await this.pages(
          `${this.base}/secrets/${normalized}/repositories`,
          'repositories'
        )
      ).map(({ id, name, full_name }) => ({ id, name, full_name }));
    }
    return result;
  }

  async verify(read, accept) {
    const outcome = await pollUntil({
      read,
      accept,
      timeout: this.verificationTimeout,
      interval: VERIFICATION_INTERVAL_MS,
    });
    if (!outcome.accepted) {
      throw new CliError(
        'GitHub did not confirm the Actions secret operation.',
        EXIT_CODES.VERIFICATION_FAILED
      );
    }
    return outcome.value;
  }

  async expiry(name) {
    return (
      (
        await this.send(
          `${this.base}/variables/${secretName(`${name}_EXPIRES_AT`)}`,
          {},
          true
        )
      )?.value ?? null
    );
  }

  async writeExpiry(name, value, grants) {
    const variable = secretName(`${name}_EXPIRES_AT`);
    const path = `${this.base}/variables/${variable}`;
    const existing = await this.send(path, {}, true);
    if (!value) {
      if (existing) {
        await this.send(path, { method: 'DELETE' });
        await this.verify(
          () => this.send(path, {}, true),
          (body) => body === null
        );
      }
      return;
    }
    await this.send(existing ? path : `${this.base}/variables`, {
      method: existing ? 'PATCH' : 'POST',
      body: { name: variable, value, ...grants },
    });
    await this.verify(
      async () => {
        const body = await this.send(path);
        if (this.scope.org && grants.visibility === 'selected') {
          const repositories = await this.pages(
            `${path}/repositories`,
            'repositories'
          );
          if (
            !sameRepositoryIds(repositories, grants.selected_repository_ids)
          ) {
            return null;
          }
        }
        return body;
      },
      (body) =>
        body?.value === value &&
        (!this.scope.org || body.visibility === grants.visibility)
    );
  }

  async list({ repo } = {}) {
    const items = await this.pages(`${this.base}/secrets`, 'secrets');
    const selected = repo ? await this.repository(repo) : null;
    const result = [];
    for (const item of items) {
      const entry = metadata(item);
      if (this.scope.org && item.visibility === 'selected') {
        entry.selected_repositories = (
          await this.pages(
            `${this.base}/secrets/${secretName(item.name)}/repositories`,
            'repositories'
          )
        ).map(({ id, name, full_name }) => ({ id, name, full_name }));
      }
      if (
        !selected ||
        item.visibility === 'all' ||
        (item.visibility === 'private' && selected.private === true) ||
        entry.selected_repositories?.some((repo) => repo.id === selected.id)
      ) {
        result.push(entry);
      }
    }
    return result;
  }
  async set(name, value, grants) {
    if (
      typeof value !== 'string' ||
      !value.length ||
      Buffer.byteLength(value, 'utf8') > 48 * 1024
    ) {
      throw new CliError(
        'A nonempty secret value of at most 48 KiB is required.',
        EXIT_CODES.USAGE
      );
    }
    await sodium.ready;
    const key = await this.send(`${this.base}/secrets/public-key`);
    let encrypted;
    try {
      encrypted = sodium.to_base64(
        sodium.crypto_box_seal(
          sodium.from_string(value),
          sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)
        ),
        sodium.base64_variants.ORIGINAL
      );
    } catch {
      throw new CliError('GitHub returned an unusable secrets encryption key.');
    }
    await this.send(`${this.base}/secrets/${name}`, {
      method: 'PUT',
      body: { encrypted_value: encrypted, key_id: key.key_id, ...grants },
    });
    await this.verify(
      () => this.getMetadata(name),
      (body) =>
        Boolean(body) &&
        (!this.scope.org ||
          (body.visibility === grants.visibility &&
            (grants.visibility !== 'selected' ||
              sameRepositoryIds(
                body.selected_repositories,
                grants.selected_repository_ids
              ))))
    );
  }
  async delete(name) {
    // Establish access before interpreting an individual 404 as absence.
    await this.pages(`${this.base}/secrets`, 'secrets');
    await this.send(`${this.base}/secrets/${name}`, { method: 'DELETE' }, true);
    await this.verify(
      () => this.getMetadata(name),
      (body) => body === null
    );
    await this.writeExpiry(name, null, {});
  }
}

export function createSecretApi(options) {
  return new SecretApi(options);
}
