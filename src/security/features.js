/**
 * The "Code security and analysis" settings gh-manager can manage.
 *
 * Each entry says three things: what the toggle is called on GitHub's settings
 * page, how the API can be asked whether it is on, and whether the API can
 * turn it on at all. The dependency graph is the reason this domain exists —
 * it has no endpoint in either REST or GraphQL, only the page — and the only
 * evidence that it is on is that `GET /repos/{owner}/{repo}/dependency-graph/sbom`
 * starts answering with an SBOM.
 */

import { CliError, EXIT_CODES } from '../exit-codes.js';

/**
 * How a feature's state is read and written through the API.
 *
 * - `toggle`: a path that answers `204` when the feature is on and `404` when
 *   it is off, and that `PUT`/`DELETE` switch.
 * - `sbom`: the dependency graph probe, which has no write side at all.
 * - `analysis`: a property of `security_and_analysis` on the repository
 *   itself, read with `GET /repos/{owner}/{repo}` and written with a `PATCH`.
 */
export const SECURITY_FEATURES = [
  {
    id: 'dependency-graph',
    label: 'Dependency graph',
    summary: 'Resolve the dependencies of this repository',
    headings: ['dependency graph', 'dependency graph and dependabot alerts'],
    // GitHub builds the SBOM in the background, so the probe can still answer
    // 404 for a graph that the settings page already shows as on. A negative
    // answer inside the verification window therefore proves nothing, and
    // `lagging` tells the gateway to fall back to the page for the proof.
    read: { kind: 'sbom', path: 'dependency-graph/sbom', lagging: true },
    write: null,
  },
  {
    id: 'vulnerability-alerts',
    label: 'Dependabot alerts',
    summary: 'Alert on dependencies with known vulnerabilities',
    headings: ['dependabot alerts', 'vulnerability alerts'],
    read: { kind: 'toggle', path: 'vulnerability-alerts' },
    write: { kind: 'toggle', path: 'vulnerability-alerts' },
  },
  {
    id: 'automated-security-fixes',
    label: 'Dependabot security updates',
    summary: 'Open pull requests that fix vulnerable dependencies',
    headings: ['dependabot security updates', 'automated security fixes'],
    read: { kind: 'toggle', path: 'automated-security-fixes' },
    write: { kind: 'toggle', path: 'automated-security-fixes' },
    // GitHub refuses the update endpoint while alerts are off, and says so
    // only with a 422, so the dependency is stated here instead.
    requires: 'vulnerability-alerts',
  },
  {
    id: 'secret-scanning',
    label: 'Secret scanning',
    summary: 'Scan the repository for published secrets',
    headings: ['secret scanning', 'secret scanning alerts'],
    read: { kind: 'analysis', property: 'secret_scanning' },
    write: { kind: 'analysis', property: 'secret_scanning' },
  },
  {
    id: 'push-protection',
    label: 'Push protection',
    summary: 'Block pushes that contain a supported secret',
    headings: ['push protection', 'secret scanning push protection'],
    read: { kind: 'analysis', property: 'secret_scanning_push_protection' },
    write: { kind: 'analysis', property: 'secret_scanning_push_protection' },
    requires: 'secret-scanning',
  },
  {
    id: 'private-vulnerability-reporting',
    label: 'Private vulnerability reporting',
    summary: 'Accept vulnerability reports privately',
    headings: ['private vulnerability reporting'],
    read: { kind: 'toggle', path: 'private-vulnerability-reporting' },
    write: { kind: 'toggle', path: 'private-vulnerability-reporting' },
  },
  ...[
    [
      'non-provider-patterns',
      'Non-provider patterns',
      'secret_scanning_non_provider_patterns',
    ],
    ['validity-checks', 'Validity checks', 'secret_scanning_validity_checks'],
  ].map(([id, label, property]) => ({
    id,
    label,
    summary: label,
    headings: [label.toLowerCase(), `secret scanning ${label.toLowerCase()}`],
    read: { kind: 'analysis', property },
    write: { kind: 'analysis', property },
    requires: 'secret-scanning',
  })),
  {
    id: 'code-scanning-default-setup',
    label: 'Code scanning default setup',
    summary: 'Configure CodeQL without an advanced workflow',
    headings: [
      'code scanning',
      'codeql analysis',
      'code scanning default setup',
    ],
    read: { kind: 'default-setup', path: 'code-scanning/default-setup' },
    write: { kind: 'default-setup', path: 'code-scanning/default-setup' },
  },
  ...[
    [
      'grouped-security-updates',
      'Grouped security updates',
      ['grouped security updates', 'dependabot grouped security updates'],
    ],
    [
      'dependabot-self-hosted-runners',
      'Dependabot on self-hosted runners',
      ['dependabot on self-hosted runners', 'dependabot self-hosted runners'],
    ],
    [
      'dependabot-actions-runners',
      'Dependabot on Actions runners',
      ['dependabot on actions runners'],
    ],
    ['copilot-autofix', 'Copilot Autofix', ['copilot autofix', 'autofix']],
  ].map(([id, label, headings]) => ({
    id,
    label,
    summary: label,
    headings,
    read: null,
    write: null,
  })),
];

/** Feature identifiers, in the order the domain lists them. */
export const SECURITY_FEATURE_IDS = SECURITY_FEATURES.map(
  (feature) => feature.id
);

/**
 * Look up one feature by the name the command line uses.
 * @param {string} id - Feature identifier
 * @returns {Object} Feature definition
 */
export function findSecurityFeature(id) {
  const feature = SECURITY_FEATURES.find((entry) => entry.id === id);

  if (!feature) {
    throw new CliError(
      `Unknown security feature "${id}". Available: ${SECURITY_FEATURE_IDS.join(', ')}.`,
      EXIT_CODES.USAGE
    );
  }

  return feature;
}

/**
 * The state name for a boolean, as reported everywhere in this domain.
 * @param {boolean} enabled - Whether the feature is on
 * @returns {'enabled'|'disabled'} State name
 */
export function stateName(enabled) {
  return enabled ? 'enabled' : 'disabled';
}

/** GitHub product defaults; organization policies may override these. */
export function securityDefault(feature, visibility) {
  if (!['public', 'private', 'internal'].includes(visibility)) {
    return 'unknown';
  }
  if (['copilot-autofix', 'dependabot-actions-runners'].includes(feature.id)) {
    return 'enabled';
  }
  if (
    ['dependency-graph', 'secret-scanning', 'push-protection'].includes(
      feature.id
    )
  ) {
    return visibility === 'public' ? 'enabled' : 'disabled';
  }
  return SECURITY_FEATURE_IDS.includes(feature.id) ? 'disabled' : 'unknown';
}
