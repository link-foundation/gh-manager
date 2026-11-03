/**
 * Scope-preserving comparison of a reviewed ruleset document with the rules
 * GitHub actually enforces on one branch.
 *
 * Everything here is pure: callers read GitHub state and pass it in, so the
 * same functions serve the read-only diagnosis, the repair plan and the
 * read-back verification.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';
import { sameValue, validateRule } from './policy.js';

/** GitHub Actions' app ID; checks bound to it can be traced to workflows. */
export const GITHUB_ACTIONS_APP_ID = 15368;

const DOCUMENT_KEYS = new Set([
  'name',
  'target',
  'enforcement',
  'conditions',
  'bypass_actors',
  'rules',
]);
const REVIEW_FLAGS = [
  'dismiss_stale_reviews_on_push',
  'require_code_owner_review',
  'require_last_push_approval',
  'required_review_thread_resolution',
];

const clone = (value) => JSON.parse(JSON.stringify(value));
const usage = (message) => new CliError(message, EXIT_CODES.USAGE);

/** A document with conditions or bypass actors describes a scoped ruleset. */
export function isScopedDocument(document) {
  return Boolean(
    document &&
    typeof document === 'object' &&
    !Array.isArray(document) &&
    ('conditions' in document || 'bypass_actors' in document)
  );
}

function stringList(value, label) {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
  ) {
    throw usage(`${label} must be an array of strings.`);
  }
  return [...(value ?? [])];
}

/** Validate a reviewed repository ruleset and return a normalized copy. */
export function scopedPolicy(document) {
  if (!isScopedDocument(document) || !Array.isArray(document.rules)) {
    throw usage(
      'A scoped protection policy needs conditions.ref_name and a rules array.'
    );
  }
  const unknown = Object.keys(document).filter(
    (key) => !DOCUMENT_KEYS.has(key)
  );
  if (unknown.length) {
    throw usage(
      `Scoped protection policies accept ${[...DOCUMENT_KEYS].join(', ')}; remove ${unknown.join(', ')}.`
    );
  }
  if ((document.target ?? 'branch') !== 'branch') {
    throw usage('Scoped protection policies must target branches.');
  }
  if ((document.enforcement ?? 'active') !== 'active') {
    throw usage(
      'A reviewed policy must use enforcement: active; gh-manager never lowers enforcement.'
    );
  }
  if ((document.bypass_actors ?? []).length) {
    throw usage(
      'gh-manager never adds bypass actors; add them deliberately in repository Settings > Rules.'
    );
  }
  const conditions = document.conditions ?? {};
  const extra = Object.keys(conditions).filter((key) => key !== 'ref_name');
  if (extra.length || !conditions.ref_name) {
    throw usage(
      'Repository policies support only conditions.ref_name; organization repository conditions belong to organization rulesets.'
    );
  }
  const include = stringList(conditions.ref_name.include, 'ref_name.include');
  const exclude = stringList(conditions.ref_name.exclude, 'ref_name.exclude');
  if (!include.length) {
    throw usage('conditions.ref_name.include must name at least one branch.');
  }
  for (const rule of document.rules) {
    validateRule(rule);
  }
  if (
    new Set(document.rules.map((rule) => rule.type)).size !==
    document.rules.length
  ) {
    throw usage('A scoped policy may list each rule type once.');
  }
  const checks = desiredChecks({ rules: document.rules });
  if (new Set(checks.map((check) => check.context)).size !== checks.length) {
    throw usage('A required check context may appear only once.');
  }
  return {
    name: document.name,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include, exclude } },
    bypass_actors: [],
    rules: document.rules.map((rule) => clone(rule)),
  };
}

function patternRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index++;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function refMatches(pattern, branch, defaultBranch) {
  if (pattern === '~ALL') {
    return true;
  }
  if (pattern === '~DEFAULT_BRANCH') {
    return branch === defaultBranch;
  }
  return patternRegex(pattern).test(`refs/heads/${branch}`);
}

/** Whether ref_name conditions cover a branch, following GitHub's fnmatch. */
export function coversBranch(refName, branch, defaultBranch) {
  return Boolean(
    refName?.include?.some((pattern) =>
      refMatches(pattern, branch, defaultBranch)
    ) &&
    !refName.exclude?.some((pattern) =>
      refMatches(pattern, branch, defaultBranch)
    )
  );
}

/** Choose the branch to audit: explicit, a single exact ref, or default. */
export function selectBranch(policy, { branch, defaultBranch }) {
  const refName = policy.conditions.ref_name;
  let selected = branch;
  if (!selected) {
    const exact = refName.include.filter(
      (pattern) => pattern.startsWith('refs/heads/') && !/[*?[]/.test(pattern)
    );
    selected =
      exact.length === 1 && refName.include.length === 1
        ? exact[0].slice('refs/heads/'.length)
        : defaultBranch;
  }
  if (!coversBranch(refName, selected, defaultBranch)) {
    throw usage(
      `The policy's conditions do not cover branch ${selected}; pass --branch with a covered branch.`
    );
  }
  return selected;
}

const sortedRefName = (refName) => ({
  include: [...(refName?.include ?? [])].sort(),
  exclude: [...(refName?.exclude ?? [])].sort(),
});

/** Whether two ref_name conditions describe the same coverage. */
export function sameScope(left, right) {
  return sameValue(sortedRefName(left), sortedRefName(right));
}

function checkList(rule) {
  return (rule?.parameters?.required_status_checks ?? []).map((check) => ({
    context: check.context,
    ...(Number.isInteger(check.integration_id)
      ? { integration_id: check.integration_id }
      : {}),
  }));
}

/** Required checks a policy asks for, with optional app identity. */
export function desiredChecks(policy) {
  return policy.rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap(checkList);
}

/**
 * Required checks GitHub enforces on a branch, from effective rules and
 * classic protection, each annotated with the source enforcing it.
 */
export function effectiveChecks(effectiveRules, classic) {
  const checks = effectiveRules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) =>
      checkList(rule).map((check) => ({
        ...check,
        source: {
          type: rule.ruleset_source_type ?? 'Repository',
          name: rule.ruleset_source,
          rulesetId: rule.ruleset_id,
        },
      }))
    );
  const status = classic?.required_status_checks;
  if (status) {
    const bound = new Map(
      (status.checks ?? []).map((check) => [check.context, check.app_id])
    );
    const contexts = new Set([...(status.contexts ?? []), ...bound.keys()]);
    for (const context of contexts) {
      const appId = bound.get(context);
      checks.push({
        context,
        ...(Number.isInteger(appId) && appId > 0
          ? { integration_id: appId }
          : {}),
        source: { type: 'Classic', name: 'branch protection' },
      });
    }
  }
  return checks;
}

const identity = (check) =>
  check.integration_id === undefined
    ? 'any app'
    : `integration ${check.integration_id}`;

/** Compare desired checks with effective ones by context and app identity. */
export function compareChecks(desired, effective) {
  const result = { missing: [], wrongIntegration: [], satisfied: [] };
  for (const check of desired) {
    const matches = effective.filter((item) => item.context === check.context);
    if (!matches.length) {
      result.missing.push(check);
    } else if (
      check.integration_id === undefined ||
      matches.some((item) => item.integration_id === check.integration_id)
    ) {
      result.satisfied.push(check);
    } else {
      result.wrongIntegration.push({
        ...check,
        current: matches.map((item) => ({
          integration_id: item.integration_id,
          source: item.source,
        })),
        currentLabel: matches.map(identity).join(', '),
      });
    }
  }
  const wanted = new Set(desired.map((check) => check.context));
  result.extra = [
    ...new Set(
      effective
        .map((check) => check.context)
        .filter((context) => !wanted.has(context))
    ),
  ];
  return result;
}

function mergeChecks(current, wanted, allowed, changes, conflicts) {
  const checks = (current.required_status_checks ?? []).map((check) => ({
    ...check,
  }));
  for (const check of checkList({ parameters: wanted })) {
    if (!allowed(check.context)) {
      continue;
    }
    const existing = checks.find((item) => item.context === check.context);
    if (!existing) {
      checks.push(check);
      changes.push(`require check ${check.context} (${identity(check)})`);
    } else if (
      check.integration_id !== undefined &&
      existing.integration_id === undefined
    ) {
      existing.integration_id = check.integration_id;
      changes.push(`bind check ${check.context} to ${identity(check)}`);
    } else if (
      check.integration_id !== undefined &&
      existing.integration_id !== check.integration_id
    ) {
      conflicts.push(
        `check ${check.context} is bound to ${identity(existing)}, the policy expects ${identity(check)}`
      );
    }
  }
  return checks;
}

function mergeParameters(type, current = {}, wanted = {}, options) {
  const { changes, conflicts } = options;
  const merged = { ...current };
  for (const [key, value] of Object.entries(wanted)) {
    const before = current[key];
    if (type === 'required_status_checks' && key === 'required_status_checks') {
      merged[key] = mergeChecks(
        current,
        wanted,
        options.allowed,
        changes,
        conflicts
      );
      continue;
    }
    if (sameValue(before, value)) {
      continue;
    }
    if (before === undefined) {
      merged[key] = clone(value);
      changes.push(`set ${type}.${key} to ${JSON.stringify(value)}`);
    } else if (
      (type === 'required_status_checks' &&
        key === 'strict_required_status_checks_policy') ||
      (type === 'pull_request' && REVIEW_FLAGS.includes(key))
    ) {
      // Booleans that only strengthen when true keep the stronger value.
      if (value === true) {
        merged[key] = true;
        changes.push(`set ${type}.${key} to true`);
      }
    } else if (
      type === 'required_status_checks' &&
      key === 'do_not_enforce_on_create'
    ) {
      if (value === false) {
        merged[key] = false;
        changes.push(`set ${type}.${key} to false`);
      }
    } else if (
      type === 'pull_request' &&
      key === 'required_approving_review_count'
    ) {
      if (value > before) {
        merged[key] = value;
        changes.push(`raise ${type}.${key} to ${value}`);
      }
    } else {
      conflicts.push(
        `${type}.${key} is ${JSON.stringify(before)}, the policy expects ${JSON.stringify(value)}`
      );
    }
  }
  return merged;
}

/**
 * Strengthen one existing rule towards a wanted rule. Existing stronger
 * values, extra parameters and app bindings are always kept.
 */
export function strengthenRule(current, wanted, allowed = () => true) {
  const changes = [];
  const conflicts = [];
  if (!wanted.parameters) {
    return { rule: current, changes, conflicts };
  }
  const parameters = mergeParameters(
    wanted.type,
    current.parameters,
    wanted.parameters,
    { changes, conflicts, allowed }
  );
  return { rule: { ...current, parameters }, changes, conflicts };
}

/** Whether any effective rule already satisfies a wanted rule. */
export function ruleSatisfied(effectiveRules, wanted) {
  return effectiveRules.some((rule) => {
    if (rule.type !== wanted.type) {
      return false;
    }
    const { changes, conflicts } = strengthenRule(rule, wanted);
    return changes.length === 0 && conflicts.length === 0;
  });
}

/** The writable fields of a ruleset, as PUT expects them. */
export function writableRuleset(ruleset) {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: clone(ruleset.conditions ?? {}),
    rules: clone(ruleset.rules ?? []),
    bypass_actors: clone(ruleset.bypass_actors ?? []),
  };
}

/**
 * Build the repaired ruleset: existing coverage, bypass actors, rules and
 * stronger parameters are kept; only unsatisfied wanted rules are added or
 * strengthened. Returns the new body plus the change and conflict lists.
 */
export function repairRuleset(existing, policy, { wanted, allowed }) {
  const body = writableRuleset(existing);
  const changes = [];
  const conflicts = [];
  for (const rule of wanted) {
    const index = body.rules.findIndex((item) => item.type === rule.type);
    if (index === -1) {
      const added = clone(rule);
      if (rule.type === 'required_status_checks') {
        added.parameters.required_status_checks = checkList(rule).filter(
          (check) => allowed(check.context)
        );
        if (!added.parameters.required_status_checks.length) {
          continue;
        }
        changes.push(
          ...added.parameters.required_status_checks.map(
            (check) => `require check ${check.context} (${identity(check)})`
          )
        );
      } else {
        changes.push(`add rule ${rule.type}`);
      }
      body.rules.push(added);
      continue;
    }
    const merged = strengthenRule(body.rules[index], rule, allowed);
    body.rules[index] = merged.rule;
    changes.push(...merged.changes);
    conflicts.push(...merged.conflicts);
  }
  if (body.enforcement !== 'active') {
    body.enforcement = 'active';
    changes.push(`activate ruleset (was ${existing.enforcement})`);
  }
  if (changes.length && policy.name && policy.name !== body.name) {
    body.name = policy.name;
    changes.push(`rename ruleset to ${JSON.stringify(policy.name)}`);
  }
  return { body, changes, conflicts };
}

/** A new ruleset body from the reviewed policy, minus blocked checks. */
export function newRuleset(policy, { name, allowed }) {
  const existing = {
    name: policy.name ?? name,
    target: 'branch',
    enforcement: 'active',
    conditions: policy.conditions,
    rules: [],
    bypass_actors: [],
  };
  return repairRuleset(existing, policy, { wanted: policy.rules, allowed });
}

/** Whether a saved ruleset contains every rule of the written body. */
export function rulesetContains(saved, body) {
  return Boolean(
    saved &&
    saved.enforcement === body.enforcement &&
    sameScope(saved.conditions?.ref_name, body.conditions?.ref_name) &&
    sameValue(saved.bypass_actors ?? [], body.bypass_actors) &&
    body.rules.every((rule) =>
      saved.rules?.some(
        (item) =>
          item.type === rule.type &&
          strengthenRule(item, rule).changes.length === 0 &&
          strengthenRule(item, rule).conflicts.length === 0
      )
    )
  );
}
