import { EXIT_CODES } from '../exit-codes.js';
import { repoSlug, resolveRepoTargets } from '../github/repo.js';
import { createPagesManager, pagesSource } from '../pages/manager.js';
import { applyAll, confirmPlan, reportDryRun } from './targets.js';

function status(context) {
  const manager = createPagesManager({ rest: context.rest });
  return applyAll(context, {
    items: resolveRepoTargets(context),
    label: repoSlug,
    run: (repo) => manager.status(repo),
    describe: (repo, result) =>
      `${repoSlug(repo)}: Pages ${result.build_type}${result.source ? ` (${result.source.branch}:${result.source.path})` : ''}`,
  });
}
async function source(context) {
  const wanted = pagesSource(context.flags);
  const repos = resolveRepoTargets(context);
  await confirmPlan(context, {
    title: `Set Pages source to ${JSON.stringify(wanted)}:`,
    items: repos.map(repoSlug),
    always: true,
  });
  if (
    reportDryRun(
      context,
      repos.map((repo) => ({
        target: repoSlug(repo),
        dryRun: true,
        source: wanted,
      }))
    )
  ) {
    return EXIT_CODES.SUCCESS;
  }
  const manager = createPagesManager({ rest: context.rest });
  return applyAll(context, {
    items: repos,
    label: repoSlug,
    run: (repo) => manager.setSource(repo, wanted),
    describe: (repo, result) =>
      `${repoSlug(repo)}: Pages source ${result.build_type}, verified through the API${result.changed ? '' : ' (already configured)'}.`,
  });
}
export const pagesDomain = {
  name: 'pages',
  summary: 'Read and configure GitHub Pages publishing sources',
  usage: [
    'gh-manager pages status <owner>/<repo> [--json]',
    'gh-manager pages source <owner>/<repo> --actions [--yes] [--dry-run]',
    'gh-manager pages source <owner>/<repo> --branch <branch>[:/path]',
  ],
  verbs: {
    status: { summary: 'Read Pages source and site state', run: status },
    source: { summary: 'Create or change the Pages source', run: source },
  },
};
