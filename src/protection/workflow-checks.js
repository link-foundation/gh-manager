/**
 * Which check names the workflows at one commit can report, and on which
 * events. A required check that never reports on pull requests blocks every
 * pull request, so such names are refused, never required blindly.
 */

import { LineCounter, parseDocument } from 'yaml';

const PULL_REQUEST_EVENTS = [
  'pull_request',
  'pull_request_target',
  'merge_group',
];
// Job conditions that only hold for pushes, releases or schedules.
const NON_PULL_REQUEST_GUARD =
  /github\.event_name\s*==\s*['"](push|schedule|workflow_dispatch|release|workflow_run)['"]|github\.event_name\s*!=\s*['"]pull_request['"]|github\.ref\s*==\s*['"]refs\/(heads|tags)\//;

function events(on) {
  if (typeof on === 'string') {
    return [on];
  }
  if (Array.isArray(on)) {
    return on.map(String);
  }
  return on && typeof on === 'object' ? Object.keys(on) : [];
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A literal name, or a regex when the name holds expressions or a matrix. */
function nameMatcher(name, job) {
  const dynamic = /\$\{\{.*?\}\}/.test(name);
  if (dynamic) {
    return {
      matrix: true,
      regex: new RegExp(
        `^${name
          .split(/\$\{\{.*?\}\}/)
          .map(escape)
          .join('.+')}$`
      ),
    };
  }
  if (job?.strategy?.matrix) {
    return {
      matrix: true,
      regex: new RegExp(`^${escape(name)} \\(.+\\)$`),
    };
  }
  return { matrix: false, literal: name };
}

function parse({ path, content }) {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter });
  if (document.errors.length) {
    return { path, error: `Unreadable workflow YAML: ${path}` };
  }
  const line = (keys) => {
    const node = document.getIn(keys, true);
    return node?.range ? lineCounter.linePos(node.range[0]).line : 1;
  };
  return { path, workflow: document.toJS() ?? {}, line };
}

function jobProducers(parsed, jobId, job, context) {
  const name = String(job?.name ?? jobId);
  const guard =
    typeof job?.if === 'string' && NON_PULL_REQUEST_GUARD.test(job.if);
  const base = {
    file: parsed.path,
    job: jobId,
    line: parsed.line(['jobs', jobId]),
    pullRequest: context.pullRequest && !guard && !context.guard,
    guard: guard || context.guard,
  };
  const prefix = context.prefix ? `${context.prefix} / ` : '';
  return { name: `${prefix}${name}`, base, matcher: nameMatcher(name, job) };
}

function collect(parsed, byPath, context, producers, depth = 0) {
  for (const [jobId, job] of Object.entries(parsed.workflow.jobs ?? {})) {
    const { name, base, matcher } = jobProducers(parsed, jobId, job, context);
    const uses = typeof job?.uses === 'string' ? job.uses : '';
    const callee = uses.startsWith('./')
      ? byPath.get(uses.slice(2).split('@')[0])
      : null;
    if (callee?.workflow && depth < 3) {
      collect(
        callee,
        byPath,
        { pullRequest: base.pullRequest, guard: base.guard, prefix: name },
        producers,
        depth + 1
      );
      continue;
    }
    const prefix = context.prefix ? `${escape(context.prefix)} / ` : '';
    producers.push({
      ...base,
      name,
      matrix: matcher.matrix,
      reusable: Boolean(context.prefix),
      ...(matcher.regex
        ? {
            regex: new RegExp(
              `^${prefix}${matcher.regex.source.slice(1, -1)}$`
            ),
          }
        : {}),
    });
  }
}

/** Every check name the workflows can produce, with event reachability. */
export function workflowProducers(files) {
  const parsed = files.map(parse);
  const byPath = new Map(parsed.map((item) => [item.path, item]));
  const producers = [];
  const errors = parsed.filter((item) => item.error);
  for (const item of parsed) {
    if (item.error) {
      continue;
    }
    const on = events(item.workflow.on ?? item.workflow[true]);
    const entry = on.filter((event) => event !== 'workflow_call');
    if (!entry.length) {
      continue;
    }
    collect(
      item,
      byPath,
      {
        pullRequest: entry.some((event) => PULL_REQUEST_EVENTS.includes(event)),
        guard: false,
      },
      producers
    );
  }
  return { producers, errors: errors.map((item) => item.error) };
}

/**
 * Classify one required check against the producers: `ok`, `matrix` (only a
 * matrix or expression-named job matches), `push-only` or `missing`.
 */
export function classifyCheck(context, producers) {
  const matching = producers.filter((producer) =>
    producer.regex ? producer.regex.test(context) : producer.name === context
  );
  const literal = matching.filter((producer) => !producer.regex);
  const onPullRequests = matching.filter((producer) => producer.pullRequest);
  const evidence = matching.map(({ file, line, job, name }) => ({
    kind: 'file',
    file,
    line,
    text: `job ${job} reports "${name}"`,
  }));
  if (!matching.length) {
    return { status: 'missing', evidence };
  }
  if (!onPullRequests.length) {
    return { status: 'push-only', evidence };
  }
  if (!literal.some((producer) => producer.pullRequest)) {
    return { status: 'matrix', evidence };
  }
  return { status: 'ok', evidence };
}
