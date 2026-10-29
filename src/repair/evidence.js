import { CliError, EXIT_CODES } from '../exit-codes.js';
import { workflowDocument, workflowSource } from '../secrets/workflows.js';

function validateChanges(changes) {
  if (
    !Array.isArray(changes) ||
    !changes.length ||
    changes.some(
      (change) =>
        !change ||
        !['setting', 'workflow'].includes(change.kind) ||
        typeof change.changed !== 'boolean' ||
        change.verified !== true ||
        change.dryRun
    )
  ) {
    throw new CliError(
      'Repair requires verified, non-dry-run changes performed by the caller.',
      EXIT_CODES.USAGE
    );
  }
}

function validateLocation({ workflow, runId, jobIds }) {
  if (
    typeof workflow !== 'string' ||
    !/^(?:\.github\/workflows\/)?[\w.-]+\.ya?ml$/.test(workflow) ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Array.isArray(jobIds) ||
    !jobIds.length ||
    jobIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new CliError(
      'Supply the affected workflow filename, runId and failed jobIds.',
      EXIT_CODES.USAGE
    );
  }
}

function validatePolling(timeout, interval) {
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    !Number.isFinite(interval) ||
    interval <= 0
  ) {
    throw new CliError(
      'Repair timeout must be finite and nonnegative, and interval positive.',
      EXIT_CODES.USAGE
    );
  }
}

function validateRevision(input, codeChanged) {
  if (
    codeChanged &&
    (!input.revision?.ref ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.revision.sha ?? ''))
  ) {
    throw new CliError(
      'Workflow changes require a revision with ref and full commit SHA.',
      EXIT_CODES.USAGE
    );
  }
  if (
    input.newRunId !== undefined &&
    (!codeChanged ||
      !Number.isSafeInteger(input.newRunId) ||
      input.newRunId <= 0)
  ) {
    throw new CliError(
      'A caller-started newRunId requires a changed workflow revision and positive run ID.',
      EXIT_CODES.USAGE
    );
  }
  if (
    input.jobNames !== undefined &&
    (!codeChanged ||
      !Array.isArray(input.jobNames) ||
      !input.jobNames.length ||
      input.jobNames.some((name) => typeof name !== 'string' || !name))
  ) {
    throw new CliError(
      'New-revision job names must identify at least one affected job.',
      EXIT_CODES.USAGE
    );
  }
}

export function repairInput(input) {
  const { changes, workflow, timeout = 600000, interval = 2000 } = input;
  validateChanges(changes);
  validateLocation(input);
  validatePolling(timeout, interval);
  const codeChanged = changes.some(
    (change) => change.kind === 'workflow' && change.changed
  );
  validateRevision(input, codeChanged);
  return {
    ...input,
    workflow: workflow.replace(/^\.github\/workflows\//, ''),
    codeChanged,
    timeout,
    interval,
  };
}

export function matchesWorkflow(run, workflow) {
  return (
    run.path?.replace(/^\.github\/workflows\//, '').split('@')[0] === workflow
  );
}

export function validateRun(run, jobs, input) {
  if (!matchesWorkflow(run, input.workflow)) {
    throw new CliError(
      'Affected run does not match the supplied workflow.',
      EXIT_CODES.USAGE
    );
  }
  if (
    !run.head_sha ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  ) {
    throw new CliError('Run SHA and attempt evidence are required.');
  }
  if (
    run.status !== 'completed' ||
    !['failure', 'timed_out', 'cancelled'].includes(run.conclusion)
  ) {
    return false;
  }
  for (const id of input.jobIds) {
    const job = jobs.find((job) => job.id === id);
    if (
      !job ||
      job.status !== 'completed' ||
      !['failure', 'timed_out', 'cancelled'].includes(job.conclusion)
    ) {
      throw new CliError(
        'Affected job evidence does not identify a failed job in this run.',
        EXIT_CODES.USAGE
      );
    }
  }
  return true;
}

function supportsDispatch(on) {
  if (on === 'workflow_dispatch') {
    return true;
  }
  if (Array.isArray(on)) {
    return on.includes('workflow_dispatch');
  }
  return Boolean(on && Object.hasOwn(on, 'workflow_dispatch'));
}

export async function codePrerequisites(rest, repo, input, sha) {
  if (!input.codeChanged && !input.requiredPermissions?.length) {
    return { missing: [], dispatch: false };
  }
  const document = workflowDocument(
    await workflowSource(rest, repo, input.workflow, sha)
  );
  const missing = [];
  for (const { job, permission, level } of input.requiredPermissions ?? []) {
    if (!job || !permission || !['read', 'write', 'none'].includes(level)) {
      throw new CliError(
        'Permission prerequisites require job, permission and read/write/none level.',
        EXIT_CODES.USAGE
      );
    }
    if (document.jobs?.[job]?.permissions?.[permission] !== level) {
      missing.push({
        file: `.github/workflows/${input.workflow}`,
        job,
        permission,
        required: level,
        reason:
          'Set the required job-level permission in workflow code through a PR.',
      });
    }
  }
  return { missing, dispatch: supportsDispatch(document.on) };
}
