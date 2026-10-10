import { parseDocument } from 'yaml';
import { CliError } from '../exit-codes.js';
import { repoPath } from '../github/rest.js';

function hasReference(value, name) {
  if (typeof value === 'string') {
    const reference =
      /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
    return [...value.matchAll(reference)].some(
      (match) => (match[1] ?? match[2]).toUpperCase() === name
    );
  }
  return (
    value &&
    typeof value === 'object' &&
    Object.values(value).some((entry) => hasReference(entry, name))
  );
}

function supportsDispatch(trigger) {
  return (
    trigger === 'workflow_dispatch' ||
    (Array.isArray(trigger)
      ? trigger.includes('workflow_dispatch')
      : Boolean(trigger && Object.hasOwn(trigger, 'workflow_dispatch')))
  );
}

function selectedSteps(workflow, job, name) {
  return (job.steps ?? []).flatMap((step, index) => {
    const aliases = Object.entries({ ...workflow.env, ...job.env, ...step.env })
      .filter(([, value]) => hasReference(value, name))
      .map(([key]) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const text = JSON.stringify(step);
    const usesAlias = aliases.some((alias) =>
      new RegExp(`(?:\\$\\{?${alias}\\b|env\\.${alias}\\b)`).test(text)
    );
    if (!hasReference(step, name) && !usesAlias) {
      return [];
    }
    return [
      {
        index,
        name:
          step.name ??
          (step.uses
            ? `Run ${step.uses}`
            : `Run ${String(step.run ?? '').split('\n')[0]}`),
      },
    ];
  });
}

/** Static references only; dynamic/reusable invocations cannot prove use. */
export function workflowUsage(source, name) {
  const document = parseDocument(source);
  if (document.errors.length) {
    throw new CliError('Unreadable workflow YAML.');
  }
  const workflow = document.toJS();
  if (!workflow || typeof workflow !== 'object') {
    throw new CliError('Unreadable workflow YAML.');
  }
  const dispatch = supportsDispatch(workflow.on);
  const jobs = [];
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    const selected = selectedSteps(workflow, job, name);
    if (
      selected.length ||
      hasReference(job, name) ||
      hasReference(workflow.env, name)
    ) {
      jobs.push({
        id,
        name: job.name ?? id,
        steps: selected,
        reusable: Boolean(job.uses),
      });
    }
  }
  return { dispatch, jobs };
}

export async function workflowFiles(rest, repo, ref) {
  const base = `${repoPath(repo)}/contents/.github/workflows`;
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const files = await rest.request(`${base}${query}`, { allowNotFound: true });
  if (files === null) {
    return [];
  }
  if (!Array.isArray(files) || files.length >= 1000) {
    throw new CliError('Incomplete workflow listing.');
  }
  const workflows = [];
  for (const file of files) {
    if (file.type !== 'file' || !/\.ya?ml$/i.test(file.name)) {
      continue;
    }
    workflows.push({
      file: file.name,
      source: await workflowSource(rest, repo, file.name, ref),
    });
  }
  return workflows;
}

export async function workflowSource(rest, repo, file, ref) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const body = await rest.request(
    `${repoPath(repo)}/contents/.github/workflows/${encodeURIComponent(file)}${query}`
  );
  if (body?.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new CliError('Unreadable workflow content.');
  }
  return Buffer.from(body.content, 'base64').toString('utf8');
}
