import { repoSlug } from '../github/repo.js';
import { repoPath } from '../github/rest.js';
import { pages } from '../github/discovery.js';
import {
  hasReference,
  workflowDocument,
  workflowSource,
  workflowUsage,
} from './workflows.js';

function calledTarget(uses, repo, ref, recorded, pinned) {
  const local = uses.match(/^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/);
  if (local) {
    if (pinned && !ref) {
      throw new Error('Run did not record the caller commit.');
    }
    return { repo, file: local[1], ref };
  }
  const remote = uses.match(
    /^([\w-]+)\/([\w.-]+)\/\.github\/workflows\/([^/]+\.ya?ml)@(.+)$/
  );
  if (!remote) {
    throw new Error('Unsupported workflow reference.');
  }
  const [, owner, name, file, requested] = remote;
  const path = `${owner}/${name}/.github/workflows/${file}`;
  const candidates = recorded.filter(
    (entry) => entry.path?.split('@')[0] === path
  );
  const exact = candidates.find(
    (entry) => entry.path === uses || entry.ref === requested
  );
  const sha = (exact ?? (candidates.length === 1 ? candidates[0] : null))?.sha;
  if (pinned && !sha && !/^[a-f0-9]{40}$/i.test(requested)) {
    throw new Error('Run did not record the called workflow commit.');
  }
  return { repo: { owner, name }, file, ref: sha ?? requested };
}

function passedNames(job, names) {
  if (job.secrets === 'inherit') {
    return names;
  }
  return Object.entries(job.secrets ?? {})
    .filter(([, value]) => hasReference(value, names))
    .map(([name]) => name.toUpperCase());
}

/** Resolve bounded workflow calls and retain unresolved evidence. */
export function resolvedWorkflowUsage(options) {
  const state = {
    cache: new Map(),
    visits: 0,
    recorded: options.recorded ?? [],
    pinned: options.pinned ?? false,
    rootRepo: options.repo,
    environments: new Map(),
    log: options.log,
  };
  return resolve({ ...options, names: [options.name], ancestors: [] }, state);
}

async function resolve(options, state) {
  const { rest, repo, file, ref, source, names, ancestors } = options;
  const key = `${repoSlug(repo)}/${file}@${ref}`;
  if (
    ancestors.includes(key) ||
    ancestors.length >= 10 ||
    ++state.visits > 100
  ) {
    throw new Error('Workflow call cycle or resolution limit.');
  }
  const workflow = workflowDocument(source);
  const usage = workflowUsage(source, names);
  const jobs = [];
  const jobNames = [];
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    const selected = usage.jobs.find((entry) => entry.id === id);
    const prefix = job.name ?? id;
    const aliases = passedNames(job, names);
    if (!job.uses || !aliases.length) {
      jobNames.push(prefix);
      if (selected) {
        jobs.push(selected);
      }
      continue;
    }
    try {
      const target = calledTarget(
        job.uses,
        repo,
        ref,
        state.recorded,
        state.pinned
      );
      const childKey = `${repoSlug(target.repo)}/${target.file}@${target.ref}`;
      if (!state.cache.has(childKey)) {
        state.cache.set(
          childKey,
          workflowSource(rest, target.repo, target.file, target.ref)
        );
      }
      const child = await resolve(
        {
          rest,
          ...target,
          source: await state.cache.get(childKey),
          names: aliases,
          ancestors: [...ancestors, key],
        },
        state
      );
      jobNames.push(...child.jobNames.map((name) => `${prefix} / ${name}`));
      jobs.push(
        ...child.jobs.map((entry) => ({
          ...entry,
          id: `${id}/${entry.id}`,
          name: `${prefix} / ${entry.name}`,
          called: true,
          callers: [
            prefix,
            ...(entry.callers ?? []).map((name) => `${prefix} / ${name}`),
          ],
        }))
      );
      if (selected && !child.jobs.length) {
        jobs.push({
          ...selected,
          unresolvedReason: 'secret-not-used-in-called-workflow',
        });
      }
    } catch {
      state.log?.debug(`workflow call unresolved: ${key} -> ${job.uses}`);
      jobNames.push(prefix);
      jobs.push({
        id,
        name: prefix,
        steps: [],
        reusable: true,
        unresolvedReason: 'workflow-call-unresolved',
      });
    }
  }
  await checkEnvironments(workflow, jobs, names, ancestors, rest, state);
  return { dispatch: usage.dispatch, jobs, jobNames };
}

async function checkEnvironments(
  workflow,
  jobs,
  names,
  ancestors,
  rest,
  state
) {
  if (!ancestors.length) {
    return;
  }
  for (const selected of jobs) {
    const environment = workflow.jobs[selected.id]?.environment;
    if (!environment) {
      continue;
    }
    try {
      const name =
        typeof environment === 'string' ? environment : environment.name;
      if (!name || name.includes('${{')) {
        throw new Error('Dynamic environment.');
      }
      if (!state.environments.has(name)) {
        state.environments.set(
          name,
          pages(
            rest,
            `${repoPath(state.rootRepo)}/environments/${encodeURIComponent(name)}/secrets`,
            'secrets'
          )
        );
      }
      const secrets = await state.environments.get(name);
      if (
        !secrets.some((secret) => names.includes(secret.name.toUpperCase()))
      ) {
        continue;
      }
    } catch {
      state.log?.debug(
        `workflow environment secrets unreadable: ${repoSlug(state.rootRepo)}/${selected.name}`
      );
    }
    selected.reusable = true;
    selected.unresolvedReason = 'environment-secret-unresolved';
  }
}
