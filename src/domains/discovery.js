import { CliError, EXIT_CODES } from '../exit-codes.js';
import { createRepoManager } from '../github/repos.js';
import { createRunManager } from '../github/runs.js';

function output(context, result) {
  context.log.info(JSON.stringify(result, null, context.flags.json ? 2 : 0));
}

function count(context, expected) {
  if (context.targets.length !== expected) {
    throw new CliError(
      `Supply ${expected} positional target${expected === 1 ? '' : 's'}.`,
      EXIT_CODES.USAGE
    );
  }
}

const repoVerbs = {
  async list(context) {
    count(context, 0);
    const users = context.flags.users ?? [];
    if (users.length > 1) {
      throw new CliError('Supply exactly one --user.', EXIT_CODES.USAGE);
    }
    output(
      context,
      await createRepoManager({ rest: context.rest, log: context.log }).list({
        org: context.flags.org,
        user: users[0],
        includeArchived: context.flags.includeArchived,
        includeForks: context.flags.includeForks,
      })
    );
  },
  async files(context) {
    count(context, 1);
    output(
      context,
      await createRepoManager({ rest: context.rest, log: context.log }).files(
        context.targets[0],
        {
          match: context.flags.match,
          content: context.flags.content,
          ref: context.flags.branch,
        }
      )
    );
  },
};

const runVerbs = {
  async list(context) {
    count(context, 1);
    output(
      context,
      await createRunManager({ rest: context.rest, log: context.log }).list(
        context.targets[0],
        {
          workflow: context.flags.workflow,
          branch: context.flags.branch,
          status: context.flags.status,
        }
      )
    );
  },
  async logs(context) {
    count(context, 1);
    output(
      context,
      await createRunManager({ rest: context.rest, log: context.log }).logs(
        context.targets[0],
        {
          repo: context.flags.repo,
          grep: context.flags.grep,
        }
      )
    );
  },
  async failures(context) {
    count(context, 0);
    output(
      context,
      await createRunManager({ rest: context.rest, log: context.log }).failures(
        {
          org: context.flags.org,
          grep: context.flags.grep,
          includeArchived: context.flags.includeArchived,
          includeForks: context.flags.includeForks,
        }
      )
    );
  },
};

function verbs(operations) {
  return Object.fromEntries(
    Object.entries(operations).map(([name, run]) => [
      name,
      { summary: `${name} GitHub data`, run },
    ])
  );
}

export const repoDomain = {
  name: 'repo',
  summary: 'Discover repositories and files through GitHub APIs',
  usage: [
    'gh-manager repo list --org <org> | --user <login> [--include-archived] [--include-forks] --json',
    'gh-manager repo files owner/repo --match <glob>... [--content] [--branch <ref>]',
  ],
  verbs: verbs(repoVerbs),
};
export const runsDomain = {
  name: 'runs',
  summary: 'Discover Actions runs and matching log evidence',
  usage: [
    'gh-manager runs list owner/repo [--workflow <file>] [--branch main] [--status failure]',
    'gh-manager runs logs <run-url> | <run-id> --repo owner/repo [--grep <regex>]...',
    'gh-manager runs failures --org <org> --grep <regex>...',
  ],
  verbs: verbs(runVerbs),
};
