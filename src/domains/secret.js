import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, EXIT_CODES } from '../exit-codes.js';
import { parseRepoSpec } from '../github/repo.js';
import { createSecretManager } from '../secrets/manager.js';
import { auditWorkflows } from '../secrets/audit.js';
import { githubAppPlan } from '../secrets/policy.js';

function target(context, { filter = false } = {}) {
  const { org, repo, environment } = context.flags;
  if (environment && !repo) {
    throw new CliError('--env requires --repo.', EXIT_CODES.USAGE);
  }
  const parsed = repo
    ? parseRepoSpec(repo, {
        defaultOwner: () => ({
          name: org ?? context.settings.org ?? context.settings.account,
        }),
      })
    : null;
  if (org && repo && !filter) {
    throw new CliError(
      'Use --org for organization secrets or --repo for repository secrets. Both are allowed together only to filter list/get-metadata/audit.',
      EXIT_CODES.USAGE
    );
  }
  if (environment && org) {
    throw new CliError(
      'Environment secrets require --repo and --env without --org.',
      EXIT_CODES.USAGE
    );
  }
  const scope = org
    ? { org }
    : parsed
      ? { repo: parsed, ...(environment ? { environment } : {}) }
      : null;
  const manager = createSecretManager({
    rest: context.rest,
    scope,
    log: context.log,
  });
  return { scope, manager, parsed };
}

function requireCount(context, count) {
  if (context.targets.length !== count) {
    throw new CliError(
      count
        ? 'Supply exactly one secret name; values are read only from stdin.'
        : 'This operation takes no positional values.',
      EXIT_CODES.USAGE
    );
  }
}

function settings(context) {
  const { visibility, repos, registry, expiresAt, rotateBefore } =
    context.flags;
  return {
    ...(visibility ? { visibility } : {}),
    ...(repos
      ? {
          repos: repos
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        }
      : {}),
    registry,
    expiresAt,
    dryRun: Boolean(context.flags.dryRun),
    ...(rotateBefore !== undefined
      ? { rotateBeforeMs: rotateBefore * 1000 }
      : {}),
  };
}

function output(context, result) {
  context.log.info(JSON.stringify(result, null, context.flags.json ? 2 : 0));
}

async function stdinValue(context) {
  try {
    const value = await context.readSecret();
    return value.replace(/\r?\n$/, '');
  } catch {
    throw new CliError(
      'Could not read the secret from stdin; no value was logged.'
    );
  }
}

async function validator(context) {
  if (!context.flags.validator) {
    return {};
  }
  try {
    return await import(
      pathToFileURL(path.resolve(context.flags.validator)).href
    );
  } catch {
    throw new CliError(
      'Could not load the registry validator module.',
      EXIT_CODES.USAGE
    );
  }
}

async function list(context) {
  requireCount(context, 0);
  const { manager } = target(context, { filter: true });
  output(
    context,
    await manager.list({
      repo: context.flags.org ? context.flags.repo : undefined,
    })
  );
}

async function getMetadata(context) {
  requireCount(context, 1);
  const { manager } = target(context, { filter: true });
  if (context.flags.org && context.flags.repo) {
    const items = await manager.list({ repo: context.flags.repo });
    output(
      context,
      items.find((item) => item.name === context.targets[0].toUpperCase()) ??
        null
    );
  } else {
    output(context, await manager.getMetadata(context.targets[0]));
  }
}

async function set(context) {
  requireCount(context, 1);
  const { manager } = target(context);
  const options = settings(context);
  if (options.dryRun) {
    output(context, await manager.set(context.targets[0], undefined, options));
    return;
  }
  // Check token policy/name/access before reading a value.
  await manager.set(context.targets[0], undefined, {
    ...options,
    dryRun: true,
  });
  output(
    context,
    await manager.set(context.targets[0], await stdinValue(context), options)
  );
}

async function ensure(context) {
  requireCount(context, 1);
  const { manager } = target(context);
  const callbacks = context.flags.dryRun ? {} : await validator(context);
  output(
    context,
    await manager.ensure(context.targets[0], {
      ...settings(context),
      validate: callbacks.validate,
      acquire: callbacks.acquire ?? (() => stdinValue(context)),
      revokePrevious: callbacks.revokePrevious,
    })
  );
}

async function remove(context) {
  requireCount(context, 1);
  const { manager } = target(context);
  const options = settings(context);
  if (
    !options.dryRun &&
    !(await context.confirm(`Delete Actions secret ${context.targets[0]}?`))
  ) {
    return EXIT_CODES.ABORTED;
  }
  output(context, await manager.delete(context.targets[0], options));
}

async function cleanup(context) {
  requireCount(context, 0);
  const { manager } = target(context);
  const callbacks = context.flags.dryRun ? {} : await validator(context);
  if (
    !context.flags.dryRun &&
    !(await context.confirm(
      'Delete leftover publishing secrets after trusted publishing verification?'
    ))
  ) {
    return EXIT_CODES.ABORTED;
  }
  output(
    context,
    await manager.cleanup(context.flags.registry, {
      ...settings(context),
      verifyTrustedPublishing: callbacks.verifyTrustedPublishing,
    })
  );
}

async function audit(context) {
  requireCount(context, 0);
  const { scope, manager, parsed } = target(context, { filter: true });
  const secrets = await manager.list({
    repo: scope.org ? context.flags.repo : undefined,
  });
  const repos = parsed ? [parsed] : [];
  if (!repos.length && scope.org) {
    for (let page = 1; ; page++) {
      const batch = await context.rest.request(
        `/orgs/${encodeURIComponent(scope.org)}/repos?per_page=100&page=${page}`
      );
      if (!Array.isArray(batch)) {
        throw new CliError(
          'GitHub returned an incomplete repository inventory.'
        );
      }
      repos.push(
        ...batch.map((repo) => ({ owner: scope.org, name: repo.name }))
      );
      if (batch.length < 100) {
        break;
      }
    }
  }
  const inventoryComplete = !scope.org || !parsed;
  const report = await auditWorkflows({
    rest: context.rest,
    repos,
    secrets,
    inventoryComplete,
  });
  report.scope = scope;
  if (report.references.some((entry) => entry.name === 'RELEASE_PR_TOKEN')) {
    report.githubApp = githubAppPlan(scope.org ?? parsed.owner);
  }
  output(context, report);
}

async function setupApp(context) {
  requireCount(context, 0);
  const { scope, manager } = target(context);
  const plan = githubAppPlan(scope.org ?? scope.repo.owner);
  if (!context.flags.appId || context.flags.dryRun) {
    output(context, plan);
    return;
  }
  if (!/^\d+$/.test(context.flags.appId)) {
    throw new CliError(
      '--app-id must be a numeric GitHub App ID.',
      EXIT_CODES.USAGE
    );
  }
  const options = settings(context);
  const key = await stdinValue(context);
  if (!key.includes('-----BEGIN ') || !key.includes('PRIVATE KEY-----')) {
    throw new CliError(
      'Read a GitHub App PEM private key from stdin.',
      EXIT_CODES.USAGE
    );
  }
  await manager.set('APP_ID', context.flags.appId, options);
  await manager.set('APP_PRIVATE_KEY', key, options);
  output(context, { ...plan, stored: true });
}

export const secretDomain = {
  name: 'secret',
  summary:
    'Manage Actions secret metadata, encrypted values, expiry and publishing policy',
  usage: [
    'gh-manager secret list|get-metadata [NAME] --org <org> [--repo <repo>]',
    'gh-manager secret set|ensure NAME --org <org> --visibility selected --repos a,b < token.txt',
    'gh-manager secret set|ensure NAME --repo owner/repo [--env production] < token.txt',
    'gh-manager secret ensure NAME --org <org> --validator ./registry.mjs [--rotate-before seconds]',
    'gh-manager secret delete NAME --repo owner/repo [--dry-run] [--yes]',
    'gh-manager secret audit --org <org> [--repo <repo>]',
    'gh-manager secret cleanup --repo owner/repo --registry npm --validator ./registry.mjs [--dry-run] [--yes]',
    'gh-manager secret setup-app --org <org> [--app-id ID --repos a,b < app-key.pem]',
    '',
    'Values are accepted only from stdin or library callbacks, never as arguments.',
    'All writes support --dry-run. Expiry is a companion NAME_EXPIRES_AT Actions variable.',
  ],
  verbs: Object.fromEntries(
    Object.entries({
      list,
      'get-metadata': getMetadata,
      set,
      ensure,
      delete: remove,
      cleanup,
      audit,
      'setup-app': setupApp,
    }).map(([name, run]) => [name, { summary: `${name} Actions secrets`, run }])
  ),
};
