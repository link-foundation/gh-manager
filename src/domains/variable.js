import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repositoryTarget } from '../github/discovery.js';
import { createVariableManager } from '../variables/manager.js';

function target(context) {
  const { org, repo, environment } = context.flags;
  const scope = org
    ? {
        org,
        ...(repo ? { repo } : {}),
        ...(environment === undefined ? {} : { environment }),
      }
    : {
        ...(repo ? { repo: repositoryTarget(repo) } : {}),
        ...(environment === undefined ? {} : { environment }),
      };
  return createVariableManager({ rest: context.rest, scope, log: context.log });
}
function count(context, expected) {
  if (context.targets.length !== expected) {
    throw new CliError(
      expected
        ? 'Supply exactly one variable name.'
        : 'List takes no variable names.',
      EXIT_CODES.USAGE
    );
  }
}
function output(context, result) {
  context.log.info(JSON.stringify(result, null, context.flags.json ? 2 : 0));
}
async function list(context) {
  count(context, 0);
  output(context, await target(context).list());
}
async function get(context) {
  count(context, 1);
  const manager = target(context);
  output(
    context,
    context.flags.effective
      ? await manager.effective(context.targets[0])
      : await manager.get(context.targets[0])
  );
}
async function ensure(context) {
  count(context, 1);
  if (context.flags.value === undefined) {
    throw new CliError(
      'Supply the non-secret value using --value (empty string is allowed).',
      EXIT_CODES.USAGE
    );
  }
  const result = await target(context).ensure(
    context.targets[0],
    context.flags.value,
    {
      dryRun: Boolean(context.flags.dryRun),
      visibility: context.flags.visibility,
      repos: context.flags.repos
        ?.split(',')
        .map((repo) => repo.trim())
        .filter(Boolean),
    }
  );
  output(context, result);
  return result.verified || result.dryRun
    ? EXIT_CODES.SUCCESS
    : EXIT_CODES.VERIFICATION_FAILED;
}
async function remove(context) {
  count(context, 1);
  const manager = target(context);
  if (
    !context.flags.dryRun &&
    !(await context.confirm(`Delete Actions variable ${context.targets[0]}?`))
  ) {
    return EXIT_CODES.ABORTED;
  }
  output(
    context,
    await manager.delete(context.targets[0], {
      dryRun: Boolean(context.flags.dryRun),
    })
  );
}
export const variableDomain = {
  name: 'variable',
  summary: 'List, read, ensure and delete non-secret Actions variables',
  usage: [
    'gh-manager variable list --repo owner/repo [--env production] | --org name',
    'gh-manager variable get NAME --repo owner/repo [--env production] [--effective]',
    'gh-manager variable get NAME --org name',
    'gh-manager variable ensure NAME --value <non-secret> --repo owner/repo [--env production] [--dry-run]',
    'gh-manager variable ensure NAME --value <non-secret> --org name [--visibility selected --repos a,b] [--dry-run]',
    'gh-manager variable delete NAME --repo owner/repo [--env production] | --org name [--dry-run] [--yes]',
    'Repository/environment ensure also verifies effective precedence; organization ensure verifies caller-selected repositories.',
  ],
  verbs: Object.fromEntries(
    Object.entries({ list, get, ensure, delete: remove }).map(([name, run]) => [
      name,
      { summary: `${name} Actions variables`, run },
    ])
  ),
};
