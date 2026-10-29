import { CliError } from '../exit-codes.js';
import { pages, repositoryTarget } from '../github/discovery.js';
import { auditWorkflows } from './audit.js';

/** A shared secret needs a complete consumer inventory before deletion. */
export async function auditSharedCleanup(rest, scope, secrets) {
  if (!scope.org || !secrets.length) {
    return null;
  }
  const selectedOnly = secrets.every((item) => item.visibility === 'selected');
  let repositories;
  if (selectedOnly) {
    repositories = [
      ...new Set(
        secrets.flatMap(
          (item) =>
            item.selected_repositories?.map((repo) => repo.full_name) ?? []
        )
      ),
    ];
    if (!repositories.length) {
      throw new CliError(
        'Shared secret consumer audit is incomplete; secrets were retained.'
      );
    }
  } else {
    const base = `/orgs/${encodeURIComponent(scope.org)}`;
    const organization = await rest.request(base);
    const inventory = await pages(rest, `${base}/repos`, null, {
      query: { type: 'all' },
    });
    if (
      !Number.isSafeInteger(organization.total_private_repos) ||
      !Number.isSafeInteger(organization.public_repos) ||
      inventory.length !==
        organization.total_private_repos + organization.public_repos
    ) {
      throw new CliError(
        'Cannot prove a complete shared organization secret inventory; secrets were retained.'
      );
    }
    repositories = inventory.map((repo) => repo.full_name);
  }
  const audit = await auditWorkflows({
    rest,
    repos: repositories.map(repositoryTarget),
    secrets,
  });
  if (
    !audit.complete ||
    secrets.some((item) => !audit.unused.includes(item.name))
  ) {
    throw new CliError(
      'Shared organization secret still has consumers or an incomplete audit; secrets were retained.'
    );
  }
  return audit;
}
