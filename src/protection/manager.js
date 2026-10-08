import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';
import {
  pollUntil,
  VERIFICATION_TIMEOUT_MS,
  VERIFICATION_INTERVAL_MS,
} from '../verification.js';
import { ProtectionApi } from './api.js';
import { classicProtected, planClassic } from './classic.js';
import {
  protectionPolicy,
  rulesetBody,
  rulesetProtects,
  sameValue,
  updateRuleset,
} from './policy.js';

function validateTarget(target) {
  const selections = [target?.org, target?.user, target?.repo].filter(Boolean);
  const valid = (part) =>
    typeof part === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(part) &&
    !['.', '..'].includes(part);
  if (
    selections.length !== 1 ||
    (target.repo
      ? !valid(target.repo.owner) || !valid(target.repo.name)
      : !valid(target.org ?? target.user))
  ) {
    throw new CliError(
      'Protect exactly one repository, --org <organization>, or --user <login>.',
      EXIT_CODES.USAGE
    );
  }
}

function failure(error) {
  return {
    action: 'failed',
    reason: error.message,
    exitCode: error.exitCode ?? EXIT_CODES.FAILURE,
  };
}

class ProtectionManager {
  constructor(options) {
    this.api = new ProtectionApi(options);
    this.verificationTimeout =
      options.verificationTimeout ?? VERIFICATION_TIMEOUT_MS;
    if (
      !Number.isFinite(this.verificationTimeout) ||
      this.verificationTimeout < 0
    ) {
      throw new CliError(
        'Verification timeout must be a finite nonnegative duration.',
        EXIT_CODES.USAGE
      );
    }
  }

  async rulesetPlan(scope, policy) {
    const existing = await this.api.rulesets(scope);
    const protectedBy = existing.find((ruleset) =>
      rulesetProtects(ruleset, policy, Boolean(scope.org))
    );
    if (protectedBy) {
      return {
        action: 'already protected',
        route: 'ruleset',
        scope,
        id: protectedBy.id,
      };
    }
    const named = existing.find(
      (ruleset) =>
        ruleset.name === policy.name &&
        (scope.org ||
          (ruleset.source_type === 'Repository' &&
            ruleset.source.toLowerCase() ===
              `${scope.repo.owner}/${scope.repo.name}`.toLowerCase()))
    );
    return {
      action: named ? 'update' : 'create',
      route: 'ruleset',
      scope,
      ...(named ? { id: named.id, before: named } : {}),
      after: named
        ? updateRuleset(named, policy, Boolean(scope.org))
        : rulesetBody(policy, Boolean(scope.org)),
    };
  }

  async repositoryPlan(metadata, policy) {
    const entry = {
      repository: metadata.full_name,
      repo: { owner: metadata.owner.login, name: metadata.name },
      fork: Boolean(metadata.fork),
    };
    if (metadata.archived) {
      return {
        ...entry,
        action: 'skipped',
        reason: 'archived repository (read-only)',
      };
    }
    try {
      return {
        ...entry,
        ...(await this.rulesetPlan({ repo: entry.repo }, policy)),
      };
    } catch (error) {
      if (!error.unavailable) {
        return { ...entry, ...failure(error) };
      }
      return this.classicPlan(entry, policy, error.message);
    }
  }

  async classicPlan(entry, policy, reason) {
    entry = {
      repository: entry.repository,
      repo: entry.repo,
      fork: entry.fork,
    };
    try {
      const branches = await planClassic(this.api, entry.repo, policy);
      return {
        ...entry,
        route: 'classic',
        reason,
        branches,
        action:
          branches.length === 0
            ? 'skipped'
            : branches.every((branch) => branch.action === 'already protected')
              ? 'already protected'
              : 'update',
        limitation:
          'Classic protection covers current branches only; rerun to protect future branches.',
        ...(branches.length === 0
          ? {
              reason: `${reason} No branches exist; classic protection cannot cover future branches.`,
            }
          : {}),
      };
    } catch (error) {
      return {
        ...entry,
        ...failure(error),
        reason: `${reason} Classic fallback failed: ${error.message}`,
      };
    }
  }

  async fallbackPlan(plan, reason) {
    const repositories = [];
    for (const metadata of plan.inventory) {
      repositories.push(await this.repositoryPlan(metadata, plan.policy));
    }
    return {
      ...plan,
      organization: undefined,
      repositories,
      fallbackReason: reason,
    };
  }

  async plan(target, options = {}) {
    validateTarget(target);
    const policy = protectionPolicy(options);
    const inventory = (await this.api.repositories(target)).map((repo) => ({
      name: repo.name,
      full_name: repo.full_name,
      owner: { login: repo.owner.login },
      archived: Boolean(repo.archived),
      fork: Boolean(repo.fork),
    }));
    if (inventory.length === 0 && !target.org) {
      throw new CliError(
        'No owned repositories were found for this target.',
        EXIT_CODES.NO_MATCHES
      );
    }
    let plan = { target, policy, inventory, repositories: [] };
    if (!target.org) {
      return this.fallbackPlan(plan);
    }
    try {
      const organization = await this.rulesetPlan({ org: target.org }, policy);
      plan = {
        ...plan,
        organization,
        repositories: inventory.map((repo) => ({
          repository: repo.full_name,
          repo: { owner: repo.owner.login, name: repo.name },
          fork: Boolean(repo.fork),
          action: repo.archived ? 'skipped' : organization.action,
          route: 'organization ruleset',
          ...(repo.archived
            ? { reason: 'archived repository (read-only)' }
            : {}),
        })),
      };
      return plan;
    } catch (error) {
      if (!error.unavailable) {
        throw error;
      }
      return this.fallbackPlan(plan, error.message);
    }
  }

  async approve(plan, options) {
    await options.onPlan?.(plan);
    const changes =
      plan.repositories.some((entry) =>
        ['create', 'update'].includes(entry.action)
      ) || ['create', 'update'].includes(plan.organization?.action);
    const update =
      plan.organization?.action === 'update' ||
      plan.repositories.some((entry) => entry.action === 'update');
    if (changes && (plan.target.org || plan.target.user || update)) {
      if (!options.confirm || !(await options.confirm(plan))) {
        throw new CliError(
          'Aborted: protection changes require confirmation or --yes.',
          EXIT_CODES.ABORTED
        );
      }
    }
  }

  async verify(read, accept, description) {
    const result = await pollUntil({
      read,
      accept,
      timeout: this.verificationTimeout,
      interval: VERIFICATION_INTERVAL_MS,
    });
    if (!result.accepted) {
      throw new CliError(
        `GitHub did not confirm ${description}.`,
        EXIT_CODES.VERIFICATION_FAILED
      );
    }
    return result.value;
  }

  async writeRuleset(entry) {
    const base = this.api.base(entry.scope);
    if (entry.action === 'update') {
      const current = await this.api.send(`${base}/${entry.id}`);
      if (!sameValue(current, entry.before)) {
        throw new CliError(
          'The current ruleset differs from the reviewed plan; rerun to review its diff.'
        );
      }
    }
    const created = await this.api.send(
      entry.action === 'update' ? `${base}/${entry.id}` : base,
      { method: entry.action === 'update' ? 'PUT' : 'POST', body: entry.after }
    );
    if (!Number.isInteger(created?.id)) {
      throw new CliError(
        'GitHub did not return a ruleset ID.',
        EXIT_CODES.VERIFICATION_FAILED
      );
    }
    return created.id;
  }

  async verifyRuleset(entry, id) {
    await this.verify(
      () => this.api.send(`${this.api.base(entry.scope)}/${id}`),
      (value) =>
        value?.name === entry.after.name &&
        rulesetProtects(
          value,
          { rules: entry.after.rules },
          Boolean(entry.scope.org)
        ),
      'the active all-branch ruleset'
    );
  }

  async verifyBranch(entry, policy) {
    const branches = await this.api.branches(entry.repo);
    if (branches.length === 0) {
      return {
        branchVerification:
          'No branches exist; ruleset verified for future branches.',
      };
    }
    const branch = branches[0].name;
    await this.verify(
      () =>
        this.api.send(
          `${repoPath(entry.repo)}/rules/branches/${encodeURIComponent(branch)}`
        ),
      (rules) =>
        Array.isArray(rules) &&
        policy.rules.every((wanted) =>
          rules.some((rule) => rule.type === wanted.type)
        ),
      `effective rules on ${entry.repository}/${branch}`
    );
    return { verifiedBranch: branch };
  }

  async applyClassic(entry) {
    for (const branch of entry.branches) {
      if (branch.action !== 'already protected') {
        const current = await this.api.send(branch.path, {}, true);
        if (!sameValue(current, branch.before)) {
          throw new CliError(
            `Branch ${branch.branch} protection differs from the reviewed plan; rerun to review it.`
          );
        }
        await this.api.send(branch.path, { method: 'PUT', body: branch.after });
      }
      await this.verify(
        () => this.api.send(branch.path),
        classicProtected,
        `classic protection on ${branch.branch}`
      );
    }
    return {
      ...entry,
      changed: entry.action !== 'already protected',
      verified: true,
    };
  }

  async applyRepository(entry, plan, options) {
    if (['failed', 'skipped', 'already protected'].includes(entry.action)) {
      return { ...entry, changed: false };
    }
    if (entry.route === 'classic') {
      return this.applyClassic(entry);
    }
    let id;
    try {
      id = await this.writeRuleset(entry);
    } catch (error) {
      if (!error.unavailable) {
        throw error;
      }
      const fallback = await this.classicPlan(
        entry,
        plan.policy,
        error.message
      );
      await this.approve(
        { ...plan, organization: undefined, repositories: [fallback] },
        options
      );
      if (fallback.action === 'failed') {
        return fallback;
      }
      return fallback.action === 'skipped'
        ? fallback
        : this.applyClassic(fallback);
    }
    await this.verifyRuleset(entry, id);
    return {
      ...entry,
      id,
      changed: true,
      verified: true,
      ...(await this.verifyBranch(entry, plan.policy)),
    };
  }

  async protect(target, options = {}) {
    let plan = await this.plan(target, options);
    if (options.dryRun) {
      await options.onPlan?.(plan);
      return { ...plan, dryRun: true };
    }
    await this.approve(plan, options);
    if (plan.organization && plan.organization.action !== 'already protected') {
      let id;
      try {
        id = await this.writeRuleset(plan.organization);
      } catch (error) {
        if (!error.unavailable) {
          throw error;
        }
        plan = await this.fallbackPlan(plan, error.message);
        await this.approve(plan, options);
      }
      if (id !== undefined) {
        await this.verifyRuleset(plan.organization, id);
        plan.organization = {
          ...plan.organization,
          id,
          changed: true,
          verified: true,
        };
      }
    }
    const repositories = [];
    for (const entry of plan.repositories) {
      try {
        repositories.push(
          plan.organization && entry.action !== 'skipped'
            ? {
                ...entry,
                changed: plan.organization.changed ?? false,
                verified: true,
                ...(await this.verifyBranch(entry, plan.policy)),
              }
            : await this.applyRepository(entry, plan, options)
        );
      } catch (error) {
        if (error.exitCode === EXIT_CODES.ABORTED) {
          throw error;
        }
        repositories.push({ ...entry, ...failure(error) });
      }
    }
    return { ...plan, repositories };
  }
}

/** Plan and apply branch protections; bulk runs and updates need confirm. */
export function createProtectionManager(options) {
  return new ProtectionManager(options);
}
