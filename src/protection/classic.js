import { CliError } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';

function actors(value) {
  return Object.fromEntries(
    ['users', 'teams', 'apps'].map((type) => [
      type,
      (value?.[type] ?? []).map((actor) =>
        type === 'users' ? actor.login : actor.slug
      ),
    ])
  );
}

function checkParameters(checks) {
  return checks
    ? {
        strict: checks.strict,
        contexts: checks.contexts ?? [],
        ...(checks.checks
          ? {
              checks: checks.checks.map(({ context, app_id }) => ({
                context,
                app_id,
              })),
            }
          : {}),
      }
    : null;
}

function reviewParameters(reviews) {
  return reviews
    ? {
        ...Object.fromEntries(
          [
            'dismiss_stale_reviews',
            'require_code_owner_reviews',
            'required_approving_review_count',
            'require_last_push_approval',
          ]
            .filter((key) => reviews[key] !== undefined)
            .map((key) => [key, reviews[key]])
        ),
        ...(reviews.dismissal_restrictions
          ? { dismissal_restrictions: actors(reviews.dismissal_restrictions) }
          : {}),
        ...(reviews.bypass_pull_request_allowances
          ? {
              bypass_pull_request_allowances: actors(
                reviews.bypass_pull_request_allowances
              ),
            }
          : {}),
      }
    : null;
}

/** Translate read-only API metadata to write parameters without weakening it. */
export function classicProtectionBody(current) {
  const body = {
    required_status_checks: checkParameters(current?.required_status_checks),
    enforce_admins: current?.enforce_admins?.enabled ?? false,
    required_pull_request_reviews: reviewParameters(
      current?.required_pull_request_reviews
    ),
    restrictions: current?.restrictions ? actors(current.restrictions) : null,
    allow_deletions: false,
    allow_force_pushes: false,
  };
  for (const key of [
    'required_linear_history',
    'required_conversation_resolution',
    'block_creations',
    'lock_branch',
    'allow_fork_syncing',
  ]) {
    if (current?.[key] !== undefined) {
      body[key] = current[key].enabled;
    }
  }
  return body;
}

export function classicProtected(value) {
  return (
    value?.allow_deletions?.enabled === false &&
    value?.allow_force_pushes?.enabled === false
  );
}

export async function planClassic(api, repo, policy) {
  if (
    policy.rules.some(
      (rule) => !['deletion', 'non_fast_forward'].includes(rule.type)
    )
  ) {
    throw new CliError(
      'Classic protection fallback cannot represent the requested extra rules safely. Repository rulesets are required for this policy.'
    );
  }
  const branches = await api.branches(repo);
  const plans = [];
  for (const branch of branches) {
    const path = `${repoPath(repo)}/branches/${encodeURIComponent(branch.name)}/protection`;
    const current = await api.send(path, {}, true);
    plans.push({
      branch: branch.name,
      path,
      action: classicProtected(current)
        ? 'already protected'
        : current
          ? 'update'
          : 'create',
      before: current,
      after: classicProtectionBody(current),
    });
  }
  return plans;
}
