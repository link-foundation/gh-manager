import { parseDocument, visit, isScalar } from 'yaml';
import { repoPath } from '../github/rest.js';
import { repoSlug } from '../github/repo.js';

/** Inspect YAML scalars so comments cannot keep an obsolete secret alive. */
function inspectWorkflow(source, location, report) {
  const doc = parseDocument(source);
  if (doc.errors.length) {
    throw new Error('Invalid workflow YAML');
  }
  visit(doc, (_key, node) => {
    if (!isScalar(node) || typeof node.value !== 'string') {
      return;
    }
    const scalar = node.value;
    const staticReference =
      /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
    for (const match of scalar.matchAll(staticReference)) {
      const name = (match[1] ?? match[2]).toUpperCase();
      const start = node.range?.[0] ?? 0;
      const raw = source.slice(start, node.range?.[1]);
      const rawOffset = raw.indexOf(match[0]);
      const line = source
        .slice(0, start + Math.max(0, rawOffset))
        .split('\n').length;
      report.references.push({
        ...location,
        name,
        line,
        recommendation:
          name === 'RELEASE_PR_TOKEN'
            ? 'Prefer a GitHub App installation token.'
            : 'Review caller policy and Actions health before changing this secret.',
      });
    }
    if (
      /\bsecrets\s*\[(?!\s*['"])/.test(scalar) ||
      /\$\{\{\s*(?:toJSON\s*\(\s*)?secrets\s*(?:\)|\}\})/i.test(scalar) ||
      scalar === 'inherit'
    ) {
      report.dynamicReferences.push(location);
    }
  });
}

async function inspectRepository(rest, repo, report) {
  const base = repoPath(repo);
  const repository = repoSlug(repo);
  try {
    const files = await rest.request(`${base}/contents/.github/workflows`);
    if (!Array.isArray(files) || files.length >= 1000) {
      throw new Error('Incomplete workflow listing');
    }
    for (const file of files) {
      if (file.type !== 'file' || !/\.ya?ml$/i.test(file.name)) {
        continue;
      }
      const path = `.github/workflows/${file.name}`;
      const location = { repository, workflow: path };
      try {
        const body = await rest.request(
          `${base}/contents/.github/workflows/${encodeURIComponent(file.name)}`
        );
        if (body?.encoding !== 'base64' || typeof body.content !== 'string') {
          throw new Error('Unreadable workflow');
        }
        inspectWorkflow(
          Buffer.from(body.content, 'base64').toString('utf8'),
          location,
          report
        );
      } catch {
        report.unreadable.push(location);
      }
    }
  } catch {
    report.unreadable.push({ repository, workflow: '.github/workflows' });
  }
}

/** Read workflow files from GitHub without following returned download URLs. */
export async function auditWorkflows({
  rest,
  repos,
  secrets = [],
  inventoryComplete = true,
}) {
  const report = {
    references: [],
    dynamicReferences: [],
    unreadable: [],
    unused: [],
    possiblyUnused: [],
    complete: inventoryComplete,
  };
  for (const repo of repos) {
    await inspectRepository(rest, repo, report);
  }
  report.complete =
    report.complete &&
    repos.length > 0 &&
    report.unreadable.length === 0 &&
    report.dynamicReferences.length === 0;
  const used = new Set(report.references.map((entry) => entry.name));
  const unused = secrets
    .map((entry) => entry.name)
    .filter((name) => !used.has(name));
  if (report.complete) {
    report.unused = unused;
  } else {
    report.possiblyUnused = unused;
  }
  return report;
}
