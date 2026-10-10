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
