import { CliError } from '../exit-codes.js';
import { repositoryTarget } from '../github/discovery.js';
import { repoPath } from '../github/rest.js';
import { repoSlug } from '../github/repo.js';
import { findSecurityFeature } from '../security/features.js';
import { workflowRequirements } from './workflows.js';
import { logRequirements } from './logs.js';

function combine(requirements) {
  const findings = new Map();
  for (const { setting, required, evidence } of requirements) {
    const key = `${setting}:${required}`;
    if (!findings.has(key)) {
      findings.set(key, { setting, required, evidence: [] });
    }
    findings.get(key).evidence.push(evidence);
  }
  return [...findings.values()];
}

async function readFinding({ finding, advanced, repo, pages, settings }) {
  if (finding.setting === 'pages') {
    const state = await pages.status(repo);
    finding.current = state.build_type;
    finding.fixable = true;
  } else if (finding.setting === 'code-scanning') {
    finding.current = 'not-enabled';
    finding.fixable = !advanced;
    if (!advanced) {
      finding.setting = 'code-scanning-default-setup';
      const status = await settings.readFeature(
        findSecurityFeature(finding.setting)
      );
      finding.current = status.state;
      finding.fixable = status.state !== 'unknown' && !status.locked;
      finding.reason = status.reason;
    } else {
      finding.reason =
        'Advanced scanning is present. Check Code Security entitlement, Actions permissions, and the workflow; enabling default setup would block advanced uploads.';
    }
  } else {
    const status = await settings.readFeature(
      findSecurityFeature(finding.setting)
    );
    finding.current = status.state;
    finding.fixable = status.state !== 'unknown' && !status.locked;
    if (!finding.fixable) {
      finding.reason =
        status.reason ??
        (status.locked ? 'organization-policy' : 'unknown-state');
    }
  }
}

export async function inspectRepository(
  target,
  { rest, log, repos, runs, pages, gateway }
) {
  const repo = repositoryTarget(target);
  const entry = {
    repository: repoSlug(repo),
    findings: [],
    errors: [],
    reruns: [],
  };
  log?.debug(`doctor: inspecting ${entry.repository}`);
  const metadata = await rest.request(repoPath(repo));
  if (!metadata.default_branch) {
    throw new CliError('GitHub did not return a default branch.');
  }
  const requirements = [];
  try {
    const files = await repos.files(repo, {
      match: [
        '.github/workflows/*.yml',
        '.github/workflows/*.yaml',
        '.github/dependabot.yml',
        '.github/dependabot.yaml',
      ],
      content: true,
      ref: metadata.default_branch,
    });
    for (const file of files) {
      try {
        requirements.push(...workflowRequirements(file));
      } catch (error) {
        entry.errors.push({ file: file.path, error: error.message });
      }
    }
  } catch (error) {
    entry.errors.push({ source: 'workflows', error: error.message });
  }
  try {
    const failures = await runs.failuresForRepository(repo, {
      branch: metadata.default_branch,
    });
    for (const failure of failures) {
      if (failure.status === 'unknown') {
        entry.errors.push({ source: 'logs', ...failure });
      }
      requirements.push(...logRequirements(failure));
    }
  } catch (error) {
    entry.errors.push({ source: 'logs', error: error.message });
  }
  const advanced = requirements.some(
    (item) =>
      item.setting === 'code-scanning-default-setup' &&
      item.required === 'disabled'
  );
  const settings = gateway(repo);
  for (const finding of combine(requirements)) {
    try {
      await readFinding({ finding, advanced, repo, pages, settings });
      if (finding.current !== finding.required) {
        entry.findings.push({ ...finding, resolved: false });
      }
    } catch (error) {
      entry.findings.push({
        ...finding,
        current: 'unknown',
        fixable: false,
        resolved: false,
        reason: error.message,
      });
    }
  }
  return entry;
}
