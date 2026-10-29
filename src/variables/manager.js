import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createVariableApi, variableName, variableScope } from './api.js';
import { repoPath } from '../github/rest.js';
import { repositoryTarget, selectedTargets } from '../github/discovery.js';

const ids = (items) => items.map((item) => item.id).sort((a, b) => a - b);
const sameIds = (a, b) => JSON.stringify(ids(a)) === JSON.stringify(ids(b));

function validateGrantPolicy(scope, current, settings) {
  if (!scope.org) {
    if (settings.visibility !== undefined || settings.repos !== undefined) {
      throw new CliError(
        'Visibility and selected repositories apply only to organization variables.',
        EXIT_CODES.USAGE
      );
    }
    return null;
  }
  const visibility = settings.visibility ?? current?.visibility ?? 'selected';
  if (!['selected', 'all', 'private'].includes(visibility)) {
    throw new CliError(
      'Variable visibility must be selected, all or private.',
      EXIT_CODES.USAGE
    );
  }
  if (
    current &&
    settings.visibility &&
    settings.visibility !== current.visibility
  ) {
    throw new CliError(
      'Ensure preserves existing organization visibility; choose a new variable for a different access policy.',
      EXIT_CODES.USAGE
    );
  }
  if (visibility !== 'selected' && settings.repos !== undefined) {
    throw new CliError(
      'Selected repositories require selected visibility.',
      EXIT_CODES.USAGE
    );
  }
  return visibility;
}

function matchesState(item, value, scope, grants) {
  if (item?.value !== value) {
    return false;
  }
  if (!scope.org) {
    return true;
  }
  return (
    item.visibility === grants.visibility &&
    (grants.visibility !== 'selected' ||
      sameIds(
        item.selected_repositories,
        grants.selected_repository_ids.map((id) => ({ id }))
      ))
  );
}

function consumerContexts(scope, settings) {
  if (settings.contexts) {
    return settings.contexts;
  }
  if (scope.repo) {
    return [{ repo: scope.repo, environment: scope.environment }];
  }
  return (settings.repos ?? []).map((repo) => ({
    repo: repo.includes('/') ? repo : `${scope.org}/${repo}`,
  }));
}

class VariableManager {
  constructor(options) {
    this.scope = variableScope(options.scope);
    this.options = { ...options, scope: this.scope };
    this.api = createVariableApi(this.options);
  }
  get(name) {
    return this.api.get(variableName(name));
  }
  async list() {
    const result = [];
    for (const item of await this.api.list()) {
      // Read selected access too; list alone does not carry repository grants.
      result.push(await this.get(item.name));
    }
    return result;
  }
  async effective(name, context = {}) {
    name = variableName(name);
    const repo = repositoryTarget(context.repo ?? this.scope.repo);
    if (
      this.scope.org &&
      repo.owner.toLowerCase() !== this.scope.org.toLowerCase()
    ) {
      throw new CliError(
        'Effective repository must belong to the variable organization.',
        EXIT_CODES.USAGE
      );
    }
    const environment = context.environment ?? this.scope.environment;
    const scoped = (scope) => new VariableManager({ ...this.options, scope });
    const inherited = await this.api.list(
      `${repoPath(repo)}/actions/organization-variables`
    );
    const organization = inherited.find(
      (item) => item.name?.toUpperCase() === name
    );
    if (organization && typeof organization.value !== 'string') {
      throw new CliError(
        'GitHub returned incomplete inherited variable state.'
      );
    }
    const repository = await scoped({ repo }).get(name);
    const local =
      environment === undefined
        ? null
        : await scoped({ repo, environment }).get(name);
    const candidates = [
      organization && { ...organization, scope: { org: repo.owner } },
      repository,
      local,
    ].filter(Boolean);
    return {
      repo,
      environment,
      name,
      value: candidates.at(-1)?.value ?? null,
      scope: candidates.at(-1)?.scope ?? null,
      candidates,
      verified: true,
    };
  }
  async grants(current, settings) {
    const visibility = validateGrantPolicy(this.scope, current, settings);
    if (!visibility) {
      return {};
    }
    if (visibility !== 'selected') {
      return { visibility };
    }
    const repositories = [...(current?.selected_repositories ?? [])];
    for (const repo of selectedTargets(this.scope.org, settings.repos ?? [])) {
      const item = await this.api.send(repoPath(repo));
      if (!Number.isSafeInteger(item?.id) || item.id <= 0) {
        throw new CliError('GitHub did not return a selected repository ID.');
      }
      if (!repositories.some((existing) => existing.id === item.id)) {
        repositories.push(item);
      }
    }
    if (!current && !repositories.length) {
      throw new CliError(
        'New selected organization variables require caller-supplied repositories.',
        EXIT_CODES.USAGE
      );
    }
    return { visibility, selected_repository_ids: ids(repositories) };
  }
  async ensure(name, value, settings = {}) {
    name = variableName(name);
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > 48 * 1024
    ) {
      throw new CliError(
        'A variable value must be a string of at most 48 KiB.',
        EXIT_CODES.USAGE
      );
    }
    const current = await this.get(name);
    const grants = await this.grants(current, settings);
    const matches = (item) => matchesState(item, value, this.scope, grants);
    const changed = !matches(current);
    let state = current;
    if (changed && !settings.dryRun) {
      await this.api.send(
        current
          ? `${this.api.base}/variables/${name}`
          : `${this.api.base}/variables`,
        {
          method: current ? 'PATCH' : 'POST',
          body: { name, value, ...grants },
        }
      );
      state = await this.api.verify(() => this.get(name), matches);
    }
    const contexts = consumerContexts(this.scope, settings);
    const effective = [];
    for (const context of contexts) {
      effective.push(await this.effective(name, context));
    }
    const verified =
      matches(state) && effective.every((item) => item.value === value);
    return {
      kind: 'setting',
      name,
      scope: this.scope,
      changed: settings.dryRun ? false : changed,
      wouldChange: changed,
      dryRun: Boolean(settings.dryRun),
      verified,
      state,
      effective,
      ...(verified
        ? {}
        : {
            reason:
              settings.dryRun && changed
                ? 'planned'
                : 'effective-state-mismatch',
          }),
    };
  }
  async delete(name, { dryRun = false } = {}) {
    name = variableName(name);
    const current = await this.get(name);
    if (current && !dryRun) {
      await this.api.send(`${this.api.base}/variables/${name}`, {
        method: 'DELETE',
      });
      await this.api.verify(
        () => this.get(name),
        (state) => state === null
      );
    }
    return {
      name,
      scope: this.scope,
      changed: Boolean(current) && !dryRun,
      wouldChange: Boolean(current),
      dryRun,
      verified: !current || !dryRun,
    };
  }
}

/** Caller-supplied non-secret Actions variables; no registry policy knowledge. */
export function createVariableManager(options) {
  return new VariableManager(options);
}
