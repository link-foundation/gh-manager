import { CliError, EXIT_CODES } from '../exit-codes.js';

export const DEFAULT_PROTECTION_RULES = Object.freeze([
  Object.freeze({ type: 'deletion' }),
  Object.freeze({ type: 'non_fast_forward' }),
]);

const SIMPLE_RULES = new Set([
  'creation',
  'update',
  'deletion',
  'non_fast_forward',
  'required_linear_history',
  'required_signatures',
]);
const PARAMETER_RULES = new Set([
  'pull_request',
  'required_status_checks',
  'required_deployments',
  'merge_queue',
  'workflows',
  'code_scanning',
  'update',
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
  'branch_name_pattern',
]);

export function flagRule(type) {
  if (SIMPLE_RULES.has(type)) {
    return { type };
  }
  if (type === 'pull_request') {
    return {
      type,
      parameters: {
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 1,
        required_review_thread_resolution: false,
      },
    };
  }
  throw new CliError(
    `Rule "${type}" requires a JSON policy with parameters, or is not a branch rule. Use --from <file>.`,
    EXIT_CODES.USAGE
  );
}

function validateDocument(document) {
  if (
    document !== undefined &&
    (!document ||
      typeof document !== 'object' ||
      Array.isArray(document) ||
      !Array.isArray(document.rules))
  ) {
    throw new CliError(
      'A protection JSON policy must contain a rules array.',
      EXIT_CODES.USAGE
    );
  }
  if (
    document &&
    Object.keys(document).some(
      (key) => !['name', 'rules', 'target', 'enforcement'].includes(key)
    )
  ) {
    throw new CliError(
      'Protection policies accept name, rules, target: branch and enforcement: active. Branch and repository coverage always includes all; bypass actors are empty.',
      EXIT_CODES.USAGE
    );
  }
  if (
    (document?.target && document.target !== 'branch') ||
    (document?.enforcement && document.enforcement !== 'active')
  ) {
    throw new CliError(
      'Protection requires target: branch and enforcement: active.',
      EXIT_CODES.USAGE
    );
  }
}

function validateRule(rule) {
  if (
    !rule ||
    (!SIMPLE_RULES.has(rule.type) && !PARAMETER_RULES.has(rule.type)) ||
    Object.keys(rule).some((key) => !['type', 'parameters'].includes(key))
  ) {
    throw new CliError(
      'The policy contains an unsupported branch rule.',
      EXIT_CODES.USAGE
    );
  }
  if (
    PARAMETER_RULES.has(rule.type) &&
    !SIMPLE_RULES.has(rule.type) &&
    (!rule.parameters ||
      typeof rule.parameters !== 'object' ||
      Array.isArray(rule.parameters))
  ) {
    throw new CliError(
      `Rule ${rule.type} requires parameters in the JSON policy.`,
      EXIT_CODES.USAGE
    );
  }
}

export function protectionPolicy({ name, rules = [], document } = {}) {
  validateDocument(document);
  const resolvedName = name ?? document?.name ?? 'protection';
  if (
    typeof resolvedName !== 'string' ||
    !resolvedName.trim() ||
    resolvedName.length > 100
  ) {
    throw new CliError(
      'Ruleset --name must contain 1 to 100 characters.',
      EXIT_CODES.USAGE
    );
  }
  const wanted = new Map(
    DEFAULT_PROTECTION_RULES.map((rule) => [rule.type, { ...rule }])
  );
  for (const rule of [...(document?.rules ?? []), ...rules]) {
    validateRule(rule);
    wanted.set(rule.type, rule);
  }
  return { name: resolvedName, rules: [...wanted.values()] };
}

export function rulesetBody(policy, org = false) {
  return {
    name: policy.name,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: ['~ALL'], exclude: [] },
      ...(org
        ? {
            repository_name: {
              include: ['~ALL'],
              exclude: [],
              protected: false,
            },
          }
        : {}),
    },
    rules: policy.rules,
    bypass_actors: [],
  };
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

export function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function containsValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return (
      actual &&
      Object.entries(expected).every(([key, value]) =>
        containsValue(actual[key], value)
      )
    );
  }
  return sameValue(actual, expected);
}

function allNames(condition) {
  return (
    condition?.include?.includes('~ALL') && condition?.exclude?.length === 0
  );
}

export function rulesetProtects(existing, policy, org = false) {
  return (
    existing?.target === 'branch' &&
    existing.enforcement === 'active' &&
    allNames(existing.conditions?.ref_name) &&
    (!org ||
      (allNames(existing.conditions?.repository_name) &&
        !existing.conditions.repository_id &&
        !existing.conditions.repository_property)) &&
    Array.isArray(existing.bypass_actors) &&
    existing.bypass_actors.length === 0 &&
    policy.rules.every((wanted) =>
      existing.rules?.some(
        (rule) =>
          rule.type === wanted.type &&
          (!wanted.parameters ||
            containsValue(rule.parameters, wanted.parameters))
      )
    )
  );
}

export function updateRuleset(existing, policy, org) {
  if (existing.target !== 'branch') {
    throw new CliError(
      `Ruleset "${policy.name}" targets ${existing.target}; choose another --name to preserve it.`
    );
  }
  const rules = new Map(existing.rules.map((rule) => [rule.type, rule]));
  for (const wanted of policy.rules) {
    const current = rules.get(wanted.type);
    if (
      current &&
      wanted.parameters &&
      !containsValue(current.parameters, wanted.parameters)
    ) {
      throw new CliError(
        `Rule ${wanted.type} already has different parameters. Choose another --name to add a ruleset without loosening the existing rule.`
      );
    }
    if (!current) {
      rules.set(wanted.type, wanted);
    }
  }
  const body = rulesetBody(policy, org);
  if (org && existing.conditions?.repository_name?.protected === true) {
    body.conditions.repository_name.protected = true;
  }
  return { ...body, rules: [...rules.values()] };
}
