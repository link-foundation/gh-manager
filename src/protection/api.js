import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';

export class ProtectionApiError extends CliError {
  constructor(response, path) {
    const detail = String(response.body?.message ?? 'Request failed').slice(
      0,
      500
    );
    const org = path.startsWith('/orgs/');
    const permission = org
      ? 'Organization rulesets need org admin access and admin:org scope. A 404 can hide missing permissions; run gh auth refresh -s admin:org or inspect organization Settings > Rules with your browser session.'
      : 'Repository rulesets and branch protection need repository Administration write permission (repository admin; repo scope for private repositories).';
    const scopeFailure = [401, 403, 404].includes(response.status);
    super(
      `GitHub HTTP ${response.status} for ${path}: ${detail}. ${scopeFailure ? permission : ''}`,
      scopeFailure ? EXIT_CODES.AUTH : EXIT_CODES.FAILURE
    );
    this.status = response.status;
    this.unavailable =
      [403, 404].includes(response.status) ||
      (response.status === 422 &&
        /upgrade|plan|not available|not supported|not enabled/i.test(detail));
    if (/rate limit|abuse|secondary rate/i.test(detail)) {
      this.unavailable = false;
    }
  }
}

export class ProtectionApi {
  constructor({ rest, log }) {
    this.rest = rest;
    this.log = log;
  }

  async send(path, options = {}, allowNotFound = false) {
    if (!this.rest?.hasToken) {
      throw new CliError(
        'Branch protection requires an API token. Sign in with gh auth login or pass --token.',
        EXIT_CODES.AUTH
      );
    }
    this.log?.debug(`${options.method ?? 'GET'} ${path}`);
    const response = await this.rest.send(path, options);
    if (allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new ProtectionApiError(response, path);
    }
    return response.body;
  }

  async pages(path) {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = await this.send(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
      );
      if (!Array.isArray(batch)) {
        throw new CliError(`Unexpected GitHub list response for ${path}.`);
      }
      result.push(...batch);
      if (batch.length < 100) {
        return result;
      }
    }
  }

  base(scope) {
    return scope.org
      ? `/orgs/${encodeURIComponent(scope.org)}/rulesets`
      : `${repoPath(scope.repo)}/rulesets`;
  }

  async rulesets(scope) {
    const base = this.base(scope);
    const summaries = await this.pages(
      `${base}${scope.org ? '' : '?includes_parents=true'}`
    );
    return Promise.all(
      summaries.map((summary) =>
        this.send(
          `${base}/${summary.id}${scope.org ? '' : '?includes_parents=true'}`
        )
      )
    );
  }

  async repositories(target) {
    if (target.repo) {
      return [await this.send(repoPath(target.repo))];
    }
    if (target.org) {
      return this.pages(
        `/orgs/${encodeURIComponent(target.org)}/repos?type=all`
      );
    }
    const publicRepos = await this.pages(
      `/users/${encodeURIComponent(target.user)}/repos?type=owner`
    );
    // GitHub's users/{user}/repos endpoint lists only public repositories.
    const identity = await this.send('/user');
    if (identity.login.toLowerCase() !== target.user.toLowerCase()) {
      return publicRepos;
    }
    const owned = await this.pages(
      '/user/repos?affiliation=owner&visibility=all'
    );
    return [
      ...new Map(
        [...publicRepos, ...owned].map((repo) => [repo.full_name, repo])
      ).values(),
    ];
  }

  branches(repo) {
    return this.pages(`${repoPath(repo)}/branches`);
  }
}
