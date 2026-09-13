#!/usr/bin/env node

/**
 * What the REST API can say about a repository's code security settings.
 *
 * The `security` domain splits its work by endpoint coverage: a toggle GitHub
 * exposes is read and written through the API, and a toggle it does not expose
 * is clicked in the settings page and then proven some other way. This script
 * is how that split was checked, one GET per toggle, printing the status code
 * and the body GitHub answers with.
 *
 * Every request here is a read, so it is safe to point at a repository you care
 * about. Endpoints covered:
 *   GET /repos/{owner}/{repo}                        security_and_analysis
 *   GET /repos/{owner}/{repo}/vulnerability-alerts   204 enabled, 404 disabled
 *   GET /repos/{owner}/{repo}/automated-security-fixes
 *   GET /repos/{owner}/{repo}/dependency-graph/sbom  the graph, observed
 *
 * There is no endpoint for the dependency graph toggle itself, which is the
 * whole reason the domain exists; the SBOM is the closest observable proof that
 * the graph is on, and GitHub builds it asynchronously, so a 404 right after a
 * flip means "not yet", not "failed".
 *
 * Observed on link-foundation/gh-manager:
 *   200 /repos/link-foundation/gh-manager
 *       {"secret_scanning":{"status":"disabled"},
 *        "secret_scanning_push_protection":{"status":"disabled"},
 *        "dependabot_security_updates":{"status":"disabled"}, ...}
 *   204 /repos/link-foundation/gh-manager/vulnerability-alerts
 *   200 /repos/link-foundation/gh-manager/automated-security-fixes
 *       {"enabled":false,"paused":false}
 *   200 /repos/link-foundation/gh-manager/dependency-graph/sbom
 *       SBOM com.github.link-foundation/gh-manager with 371 packages
 *
 * The `security_and_analysis` object carries a key for secret scanning, push
 * protection, and Dependabot security updates, and none for the dependency
 * graph. Dependabot alerts have their own endpoint, answering 204 for on and
 * 404 for off; the graph has only the SBOM, which answered here because the
 * graph is on for this repository.
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) node experiments/security-settings-endpoints.mjs owner/repo
 */

const [spec = 'link-foundation/gh-manager'] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

if (!token) {
  console.error('Set GITHUB_TOKEN, for example GITHUB_TOKEN=$(gh auth token)');
  process.exit(1);
}

const [owner, name] = spec.split('/');

/**
 * Fetch one endpoint and report what came back.
 * @param {string} path - Path under https://api.github.com
 * @param {Function} [summarize] - Turn a parsed body into one printable line
 * @returns {Promise<void>} Resolves after printing
 */
async function probe(path, summarize) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'gh-manager-experiment',
    },
  });

  const text = await response.text();
  let summary = text.slice(0, 120);

  if (summarize && response.ok && text) {
    try {
      summary = summarize(JSON.parse(text));
    } catch (error) {
      summary = `unparsable body: ${error.message}`;
    }
  }

  console.log(`${response.status} ${path}`);
  console.log(`    ${summary || '(empty body)'}`);
}

console.log(`Probing ${spec}\n`);

await probe(`/repos/${owner}/${name}`, (repo) =>
  JSON.stringify(repo.security_and_analysis ?? null)
);

await probe(`/repos/${owner}/${name}/vulnerability-alerts`);

await probe(`/repos/${owner}/${name}/automated-security-fixes`, (body) =>
  JSON.stringify(body)
);

await probe(
  `/repos/${owner}/${name}/dependency-graph/sbom`,
  (body) =>
    `SBOM ${body.sbom?.name ?? '?'} with ${body.sbom?.packages?.length ?? 0} packages`
);
