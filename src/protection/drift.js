/**
 * Audit and repair required-check drift for one repository branch against a
 * reviewed, scoped ruleset document (for example `.github/main-ruleset.json`).
 *
 * Diagnosis only reads. A repair edits one repository ruleset, keeps its
 * coverage, bypass actors, stronger parameters and app bindings, refuses
 * stale plans, and reads back both the saved ruleset and the effective rules
 * of the selected branch.
 */

import { createHash } from 'node:crypto';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';
import { createRepoManager } from '../github/repos.js';
import { confirmUntil, VERIFICATION_TIMEOUT_MS } from '../verification.js';
import { ProtectionApi } from './api.js';
import { sameValue } from './policy.js';
import {
  compareChecks,
  coversBranch,
  desiredChecks,
  effectiveChecks,
  GITHUB_ACTIONS_APP_ID,
  newRuleset,
  repairRuleset,
  ruleSatisfied,
  rulesetContains,
  sameScope,
  scopedPolicy,
  selectBranch,
  writableRuleset,
} from './scoped.js';
import { classifyCheck, workflowProducers } from './workflow-checks.js';

const WORKFLOW_GLOBS = ['.github/workflows/*.yml', '.github/workflows/*.yaml'];

function finding(setting, current, required, extra = {}) {
  return {
    source: 'branch-rules',
    setting,
    current,
    required,
    fixable: false,
    resolved: false,
    evidence: [],
    ...extra,
  };
}

const label = (check) =>
  check.integration_id === undefined
    ? 'required (any app)'
    : `required (integration ${check.integration_id})`;

function fingerprint(plan) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        plan.repository,
        plan.branch,
        plan.ruleset?.id ?? null,
        plan.ruleset?.updated_at ?? null,
        plan.before ?? null,
        plan.after ?? null,
      ])
    )
    .digest('hex');
}

/** Parameters of a required_status_checks rule other than the check list. */
function checkSettings(rule) {
  const { required_status_checks: ignored, ...parameters } =
    rule.parameters ?? {};
  void ignored;
  return { ...rule, parameters };
}

function unsatisfiedRules(policy, rules) {
  return policy.rules.filter((rule) =>
    rule.type === 'required_status_checks'
      ? !ruleSatisfied(rules.map(checkSettings), checkSettings(rule))
      : !ruleSatisfied(rules, rule)
  );
}

function chooseTarget(rulesets, { policy, plan, effectiveRules, rulesetId }) {
  const local = rulesets.filter(
    (ruleset) =>
      ruleset.target === 'branch' &&
      ruleset.source_type === 'Repository' &&
      String(ruleset.source).toLowerCase() === plan.repository.toLowerCase()
  );
  if (rulesetId !== undefined) {
    const pinned = local.filter((ruleset) => ruleset.id === rulesetId);
    if (!pinned.length) {
      throw new CliError(
        `Repository ruleset ${rulesetId} was not found on ${plan.repository}.`,
        EXIT_CODES.USAGE
      );
    }
    return pinned;
  }
  const contributing = new Set(
    effectiveRules
      .filter(
        (rule) =>
          rule.type === 'required_status_checks' &&
          rule.ruleset_source_type !== 'Organization'
      )
      .map((rule) => rule.ruleset_id)
  );
  const tiers = [
    local.filter((ruleset) => policy.name && ruleset.name === policy.name),
    local.filter((ruleset) => contributing.has(ruleset.id)),
    local.filter(
      (ruleset) =>
        coversBranch(
          ruleset.conditions?.ref_name,
          plan.branch,
          plan.defaultBranch
        ) &&
        ruleset.rules?.some((rule) => rule.type === 'required_status_checks')
    ),
  ];
  return tiers.find((tier) => tier.length) ?? [];
}

class RulesetDrift {
  constructor({ rest, log, verificationTimeout, repos }) {
    this.api = new ProtectionApi({ rest, log });
    this.repos = repos ?? createRepoManager({ rest, log });
    this.log = log;
    this.verificationTimeout = verificationTimeout ?? VERIFICATION_TIMEOUT_MS;
  }

  async read(plan, source, read) {
    try {
      return await read();
    } catch (error) {
      if (error.exitCode === EXIT_CODES.USAGE) {
        throw error;
      }
      plan.findings.push(
        finding('protection-evidence', 'unreadable', 'readable', {
          evidenceSource: source,
          reason: error.message,
        })
      );
      return null;
    }
  }

  classic(plan) {
    const path = `${repoPath(plan.repo)}/branches/${encodeURIComponent(plan.branch)}/protection`;
    return this.read(plan, 'classic branch protection', () =>
      this.api.send(path, {}, true)
    );
  }

  async checkRuns(plan) {
    const runs = [];
    try {
      for (let page = 1; page <= 10; page++) {
        const body = await this.api.send(
          `${repoPath(plan.repo)}/commits/${plan.headSha}/check-runs?per_page=100&page=${page}`
        );
        runs.push(...(body?.check_runs ?? []));
        if ((body?.check_runs ?? []).length < 100) {
          return runs;
        }
      }
      return runs;
    } catch (error) {
      plan.warnings.push(`Check runs are unreadable: ${error.message}`);
      return null;
    }
  }

  async evidence(plan) {
    const base = repoPath(plan.repo);
    const branchPath = encodeURIComponent(plan.branch);
    const effectiveRules = await this.read(plan, 'effective branch rules', () =>
      this.api.pages(`${base}/rules/branches/${branchPath}`)
    );
    const rulesets = await this.read(plan, 'repository rulesets', () =>
      this.api.rulesets({ repo: plan.repo })
    );
    const classic = await this.classic(plan);
    const files = await this.read(plan, 'workflows', () =>
      this.repos.files(plan.repo, {
        match: WORKFLOW_GLOBS,
        content: true,
        ref: plan.headSha,
      })
    );
    const runs = await this.checkRuns(plan);
    return { effectiveRules, rulesets, classic, files, runs };
  }

  /** Find check names that must not be added and record why. */
  validateChecks(plan, desired, { files, runs }) {
    const blocked = new Set();
    plan.checkEvidence = {};
    const produced = files ? workflowProducers(files) : null;
    for (const error of produced?.errors ?? []) {
      plan.warnings.push(error);
    }
    for (const check of desired) {
      const actions =
        check.integration_id === undefined ||
        check.integration_id === GITHUB_ACTIONS_APP_ID;
      const observed = (runs ?? []).filter((run) => run.name === check.context);
      const evidence = observed.map((run) => ({
        kind: 'check-run',
        sha: plan.headSha,
        text: `${run.name} from app ${run.app?.id}: ${run.conclusion ?? run.status}`,
      }));
      if (
        check.integration_id !== undefined &&
        observed.length &&
        !observed.some((run) => run.app?.id === check.integration_id)
      ) {
        blocked.add(check.context);
        plan.findings.push(
          finding(
            'required-check-app',
            `app ${observed[0].app?.id}`,
            label(check),
            {
              context: check.context,
              reason: `Check runs named ${check.context} on ${plan.headSha} come from another app; requiring this identity would block merges.`,
              evidence,
            }
          )
        );
      } else if (runs && !observed.length) {
        plan.warnings.push(
          `${check.context} has not reported on ${plan.branch} head ${plan.headSha}; the workflow revision may be newer than the latest run.`
        );
      }
      if (!actions) {
        plan.warnings.push(
          `${check.context} is bound to app ${check.integration_id}, which workflows cannot confirm.`
        );
        continue;
      }
      if (!produced) {
        blocked.add(check.context);
        continue;
      }
      const result = classifyCheck(check.context, produced.producers);
      plan.checkEvidence[check.context] = [...result.evidence, ...evidence];
      if (result.status === 'matrix') {
        plan.warnings.push(
          `${check.context} matches only a matrix or expression-named job; prefer one aggregate gate job.`
        );
      } else if (result.status !== 'ok') {
        blocked.add(check.context);
        plan.findings.push(
          finding(
            'required-check-workflow',
            result.status,
            'reported on pull requests',
            {
              context: check.context,
              reason:
                result.status === 'missing'
                  ? `No workflow job at ${plan.headSha} reports ${check.context}; requiring it would block every pull request.`
                  : `${check.context} only runs outside pull requests (push, schedule or release jobs); requiring it would block every pull request.`,
              evidence: result.evidence,
            }
          )
        );
      }
    }
    return blocked;
  }

  targetFindings(plan, target, policy) {
    if (target.enforcement !== 'active') {
      plan.findings.push(
        finding('ruleset-enforcement', target.enforcement, 'active', {
          fixable: true,
          reason: `Ruleset ${target.id} is not enforced, so its rules do not apply.`,
        })
      );
    }
    if (
      !coversBranch(
        target.conditions?.ref_name,
        plan.branch,
        plan.defaultBranch
      )
    ) {
      plan.findings.push(
        finding(
          'ruleset-scope',
          JSON.stringify(target.conditions?.ref_name),
          JSON.stringify(policy.conditions.ref_name),
          {
            reason: `Ruleset ${target.id} does not cover ${plan.branch}; coverage is never changed implicitly.`,
          }
        )
      );
      return false;
    }
    if (!sameScope(target.conditions?.ref_name, policy.conditions.ref_name)) {
      plan.findings.push(
        finding(
          'ruleset-scope',
          JSON.stringify(target.conditions?.ref_name),
          JSON.stringify(policy.conditions.ref_name),
          {
            reason: `Ruleset ${target.id} coverage differs from the policy; it is preserved. Change coverage deliberately in Settings > Rules.`,
          }
        )
      );
    }
    if (!Array.isArray(target.bypass_actors)) {
      plan.findings.push(
        finding('protection-evidence', 'unreadable', 'readable', {
          evidenceSource: `ruleset ${target.id} bypass actors`,
          reason:
            'Bypass actors are visible only with repository Administration permission; the ruleset cannot be preserved safely without them.',
        })
      );
      return false;
    }
    if (target.bypass_actors.length) {
      plan.findings.push(
        finding(
          'ruleset-bypass-actors',
          `${target.bypass_actors.length} actor(s)`,
          'none',
          {
            reason:
              'Existing bypass actors are preserved; review them in Settings > Rules.',
          }
        )
      );
    }
    return true;
  }

  checkFindings(plan, comparison, blocked) {
    for (const check of comparison.missing) {
      plan.findings.push(
        finding('required-status-check', 'missing', label(check), {
          context: check.context,
          evidence: plan.checkEvidence?.[check.context] ?? [],
          ...(blocked.has(check.context)
            ? { reason: 'Blocked by workflow or check-run evidence above.' }
            : {}),
        })
      );
    }
    for (const check of comparison.wrongIntegration) {
      const outside = check.current.find(
        (item) => item.source.type !== 'Repository'
      );
      if (outside) {
        blocked.add(check.context);
      }
      plan.findings.push(
        finding('required-status-check', check.currentLabel, label(check), {
          context: check.context,
          evidence: plan.checkEvidence?.[check.context] ?? [],
          ...(outside
            ? {
                reason:
                  outside.source.type === 'Organization'
                    ? `Enforced by organization ruleset ${outside.source.rulesetId}; an organization admin must change it.`
                    : 'Enforced by classic branch protection, which this repair never edits.',
              }
            : {}),
        })
      );
    }
  }

  /** Findings for required checks and rules; returns what a repair adds. */
  diagnose(plan, policy, evidence) {
    const desired = desiredChecks(policy);
    const effective = effectiveChecks(
      evidence.effectiveRules,
      evidence.classic
    );
    const comparison = compareChecks(desired, effective);
    plan.checks = {
      desired: desired.map((check) => check.context),
      effective: [...new Set(effective.map((check) => check.context))],
      missing: comparison.missing.map((check) => check.context),
      wrongIntegration: comparison.wrongIntegration.map(
        (check) => check.context
      ),
      extra: comparison.extra,
    };
    const blocked = this.validateChecks(plan, desired, evidence);
    this.checkFindings(plan, comparison, blocked);
    delete plan.checkEvidence;
    plan.checks.blocked = [...blocked];
    const unsatisfied = unsatisfiedRules(policy, evidence.effectiveRules);
    for (const rule of unsatisfied) {
      plan.findings.push(
        finding('ruleset-rule', 'missing or weaker', rule.type, {
          rule: rule.type,
          reason:
            rule.type === 'required_status_checks'
              ? 'Required-check settings (strict same-commit validation, enforcement on create) are weaker than the policy.'
              : `No effective rule satisfies ${rule.type} as reviewed.`,
        })
      );
    }
    const checksNeeded =
      comparison.missing.length + comparison.wrongIntegration.length > 0;
    const wanted = policy.rules.filter(
      (rule) =>
        unsatisfied.includes(rule) ||
        (rule.type === 'required_status_checks' && checksNeeded)
    );
    const satisfied = new Set(
      comparison.satisfied.map((check) => check.context)
    );
    const allowed = (context) =>
      !blocked.has(context) && !satisfied.has(context);
    return { wanted, allowed };
  }

  async plan(repo, document, { branch, rulesetId } = {}) {
    const policy = scopedPolicy(document);
    const metadata = await this.api.send(repoPath(repo));
    const plan = {
      repository: metadata.full_name ?? `${repo.owner}/${repo.name}`,
      repo,
      defaultBranch: metadata.default_branch,
      policy: { name: policy.name, conditions: policy.conditions },
      findings: [],
      warnings: [],
      changes: [],
      conflicts: [],
    };
    plan.branch = selectBranch(policy, {
      branch,
      defaultBranch: plan.defaultBranch,
    });
    const head = await this.api.send(
      `${repoPath(repo)}/branches/${encodeURIComponent(plan.branch)}`,
      {},
      true
    );
    if (!head?.commit?.sha) {
      throw new CliError(
        `Branch ${plan.branch} does not exist in ${plan.repository}.`,
        EXIT_CODES.USAGE
      );
    }
    plan.headSha = head.commit.sha;
    if (metadata.archived) {
      return this.finish(plan, {
        action: 'skipped',
        reason: 'archived repository (read-only)',
      });
    }
    const evidence = await this.evidence(plan);
    if (!evidence.effectiveRules || !evidence.rulesets) {
      return this.finish(plan, { action: 'blocked' });
    }
    const { wanted, allowed } = this.diagnose(plan, policy, evidence);
    const candidates = chooseTarget(evidence.rulesets, {
      policy,
      plan,
      effectiveRules: evidence.effectiveRules,
      rulesetId,
    });
    if (candidates.length > 1) {
      plan.findings.push(
        finding(
          'ruleset-target',
          `${candidates.length} candidate rulesets`,
          'one',
          {
            reason: `Rulesets ${candidates.map((item) => item.id).join(', ')} all match; pass --ruleset <id>.`,
          }
        )
      );
      return this.finish(plan, {
        action: 'blocked',
        metadata,
        evidence,
        policy,
      });
    }
    const target = candidates[0];
    if (target) {
      plan.ruleset = {
        id: target.id,
        name: target.name,
        enforcement: target.enforcement,
        conditions: target.conditions,
        updated_at: target.updated_at,
      };
      if (!this.targetFindings(plan, target, policy)) {
        return this.finish(plan, {
          action: 'blocked',
          metadata,
          evidence,
          policy,
        });
      }
    }
    if (!wanted.length && (!target || target.enforcement === 'active')) {
      return this.finish(plan, {
        action: 'no change',
        metadata,
        evidence,
        policy,
      });
    }
    const repaired = target
      ? repairRuleset(target, policy, { wanted, allowed })
      : newRuleset(policy, { name: 'protection', allowed });
    plan.changes = repaired.changes;
    plan.conflicts = repaired.conflicts;
    if (repaired.changes.length) {
      plan.before = target ? writableRuleset(target) : undefined;
      plan.after = repaired.body;
    }
    const writeAction = target ? 'update' : 'create';
    return this.finish(plan, {
      action: repaired.changes.length ? writeAction : 'no change',
      metadata,
      evidence,
      policy,
    });
  }

  /** Mark findings the planned write resolves and summarize the plan. */
  finish(plan, { action, reason, metadata, evidence, policy }) {
    plan.action = action;
    Object.defineProperty(plan, 'classic', {
      value: evidence?.classic ?? null,
      enumerable: false,
    });
    if (reason) {
      plan.reason = reason;
    }
    if (plan.after && evidence) {
      const others = evidence.effectiveRules.filter(
        (rule) => rule.ruleset_id !== plan.ruleset?.id
      );
      const projected = [...others, ...plan.after.rules];
      const projectedChecks = compareChecks(
        desiredChecks(policy),
        effectiveChecks(projected, evidence.classic)
      );
      const fixed = new Set(
        projectedChecks.satisfied.map((check) => check.context)
      );
      const stillWeak = new Set(
        unsatisfiedRules(policy, projected).map((rule) => rule.type)
      );
      for (const item of plan.findings) {
        if (item.setting === 'required-status-check') {
          item.fixable =
            fixed.has(item.context) &&
            !plan.checks.blocked.includes(item.context);
        }
        if (item.setting === 'ruleset-rule') {
          item.fixable = !stillWeak.has(item.rule);
        }
      }
      plan.projected = {
        unsatisfied: [
          ...projectedChecks.missing,
          ...projectedChecks.wrongIntegration,
        ].map((check) => check.context),
      };
    }
    if (metadata?.permissions && !metadata.permissions.admin) {
      plan.findings.push(
        finding('administration-permission', 'not admin', 'admin', {
          reason:
            'Editing rulesets needs repository Administration write permission; ask a repository admin to apply the plan.',
        })
      );
      plan.writable = false;
    }
    if (plan.after) {
      plan.fallback = {
        body: 'the "after" object of this plan (jq .after plan.json > ruleset.json)',
        browser: `https://github.com/${plan.repository}/settings/rules${plan.ruleset ? `/${plan.ruleset.id}` : '/new?target=branch'}`,
        api: plan.ruleset
          ? `gh api --method PUT /repos/${plan.repository}/rulesets/${plan.ruleset.id} --input ruleset.json`
          : `gh api --method POST /repos/${plan.repository}/rulesets --input ruleset.json`,
      };
    }
    plan.compliant = plan.findings.length === 0;
    plan.fingerprint = fingerprint(plan);
    return plan;
  }

  verify(read, accept, description) {
    return confirmUntil({
      read,
      accept,
      timeout: this.verificationTimeout,
      description,
    });
  }

  async write(plan) {
    const base = this.api.base({ repo: plan.repo });
    if (plan.action === 'update') {
      const current = await this.api.send(`${base}/${plan.ruleset.id}`);
      if (
        !sameValue(writableRuleset(current), plan.before) ||
        (plan.ruleset.updated_at &&
          current.updated_at !== plan.ruleset.updated_at)
      ) {
        throw new CliError(
          `Ruleset ${plan.ruleset.id} changed after the plan was reviewed; rerun to review the new diff.`
        );
      }
    } else {
      const now = await this.api.pages(base);
      if (now.some((item) => item.name === plan.after.name)) {
        throw new CliError(
          `A ruleset named ${JSON.stringify(plan.after.name)} appeared after the plan was reviewed; rerun to review it.`
        );
      }
    }
    const saved = await this.api.send(
      plan.action === 'update' ? `${base}/${plan.ruleset.id}` : base,
      { method: plan.action === 'update' ? 'PUT' : 'POST', body: plan.after }
    );
    if (!Number.isInteger(saved?.id)) {
      throw new CliError(
        'GitHub did not return a ruleset ID.',
        EXIT_CODES.VERIFICATION_FAILED
      );
    }
    return saved.id;
  }

  async readBack(plan, id, document) {
    const base = this.api.base({ repo: plan.repo });
    const saved = await this.verify(
      () => this.api.send(`${base}/${id}`),
      (value) => rulesetContains(value, plan.after),
      `the saved ruleset ${id}`
    );
    const branchPath = `${repoPath(plan.repo)}/rules/branches/${encodeURIComponent(plan.branch)}`;
    const expected = desiredChecks(scopedPolicy(document));
    const pending = new Set(plan.projected?.unsatisfied ?? []);
    const effective = await this.verify(
      () => this.api.pages(branchPath),
      (rules) => {
        const now = compareChecks(
          expected,
          effectiveChecks(rules, plan.classic)
        );
        return [...now.missing, ...now.wrongIntegration].every((check) =>
          pending.has(check.context)
        );
      },
      `effective required checks on ${plan.repository}/${plan.branch}`
    );
    return {
      ruleset: {
        id: saved.id,
        name: saved.name,
        enforcement: saved.enforcement,
        conditions: saved.conditions,
      },
      effectiveChecks: [
        ...new Set(
          effectiveChecks(effective, plan.classic).map((check) => check.context)
        ),
      ],
    };
  }

  /**
   * Apply a reviewed plan. `savedPlan` (a previous dry run) must match the
   * fresh plan exactly; confirmation is always required for writes.
   */
  async apply(plan, document, { confirm, savedPlan } = {}) {
    if (savedPlan && savedPlan.fingerprint !== plan.fingerprint) {
      throw new CliError(
        'The saved plan is stale: the repository ruleset or policy changed since it was reviewed. Run --dry-run again and review the new diff.'
      );
    }
    if (!['update', 'create'].includes(plan.action)) {
      return { ...plan, changed: false };
    }
    if (plan.writable === false) {
      return {
        ...plan,
        action: 'failed',
        changed: false,
        exitCode: EXIT_CODES.AUTH,
        reason: `Repository Administration permission is required. Apply the reviewed body in ${plan.fallback.browser} or with: ${plan.fallback.api}`,
      };
    }
    if (!confirm || !(await confirm(plan))) {
      throw new CliError(
        'Aborted: ruleset changes require confirmation or --yes.',
        EXIT_CODES.ABORTED
      );
    }
    let id;
    try {
      id = await this.write(plan);
    } catch (error) {
      if (error.status === undefined) {
        throw error;
      }
      return {
        ...plan,
        action: 'failed',
        changed: false,
        exitCode: error.exitCode ?? EXIT_CODES.FAILURE,
        reason: `${error.message} Fallback: edit ${plan.fallback.browser} or run ${plan.fallback.api}`,
      };
    }
    const readBack = await this.readBack(plan, id, document);
    for (const item of plan.findings) {
      item.resolved = item.fixable === true;
    }
    return { ...plan, id, changed: true, verified: true, readBack };
  }
}

/** Plan and apply scope-preserving required-check repairs. */
export function createRulesetDrift(options) {
  return new RulesetDrift(options);
}
