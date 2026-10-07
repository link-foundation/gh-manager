import { CliError, EXIT_CODES } from '../exit-codes.js';

/** Publishing credentials eligible for cleanup with verified OIDC. */
export const TRUSTED_PUBLISHING_SECRETS = {
  npm: ['NPM_TOKEN'],
  pypi: ['PYPI_TOKEN', 'PYPI_API_TOKEN'],
  'crates.io': ['CARGO_TOKEN', 'CARGO_REGISTRY_TOKEN'],
  rubygems: ['RUBYGEMS_API_KEY'],
  nuget: ['NUGET_API_KEY', 'NUGET_TOKEN'],
  jsr: ['JSR_TOKEN'],
};

export function publishingPolicy(name, registry) {
  const normalized = registry?.toLowerCase();
  if (normalized === 'ghcr') {
    return 'Use the workflow GITHUB_TOKEN with packages: write; no stored publishing token.';
  }
  if (
    Object.hasOwn(TRUSTED_PUBLISHING_SECRETS, normalized ?? '') ||
    Object.values(TRUSTED_PUBLISHING_SECRETS).some((names) =>
      names.includes(name)
    )
  ) {
    return 'Use trusted publishing; bootstrap credentials are short-lived, in memory and never stored.';
  }
  if (name === 'RELEASE_PR_TOKEN') {
    return 'Prefer a GitHub App installation token; retain a PAT only as an explicit fallback.';
  }
  return 'Store and validate the registry token, rotating it before expiry.';
}

export function requireStoredToken(name, registry) {
  const policy = publishingPolicy(name, registry);
  if (policy.startsWith('Use ')) {
    throw new CliError(policy, EXIT_CODES.USAGE);
  }
}

/** A reviewable recipe; registering/installing an App remains a GitHub operation. */
export function githubAppPlan(org) {
  return {
    registration: `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`,
    permissions: { contents: 'write', pull_requests: 'write' },
    installation:
      'Install the App on only the repositories that create release PRs.',
    credentials: ['APP_ID', 'APP_PRIVATE_KEY'],
    workflow: [
      '- uses: actions/create-github-app-token@v3',
      '  id: app-token',
      '  with:',
      '    app-id: ${{ secrets.APP_ID }}',
      '    private-key: ${{ secrets.APP_PRIVATE_KEY }}',
      '- uses: actions/checkout@v6',
      '  with:',
      '    token: ${{ steps.app-token.outputs.token }}',
    ].join('\n'),
    fallback:
      'Use RELEASE_PR_TOKEN only when a GitHub App cannot be installed.',
  };
}
