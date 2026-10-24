import { LineCounter, parseDocument } from 'yaml';
import { CliError } from '../exit-codes.js';

/** Rules operate on parsed YAML steps, so comments cannot trigger changes. */
export function workflowRequirements({ path, content }) {
  if (/^\.github\/dependabot\.ya?ml$/i.test(path)) {
    return [
      {
        setting: 'vulnerability-alerts',
        required: 'enabled',
        evidence: {
          kind: 'file',
          file: path,
          line: 1,
          text: 'Dependabot configuration',
        },
      },
    ];
  }
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter });
  if (document.errors.length) {
    throw new CliError(`Unreadable workflow YAML: ${path}`);
  }
  const workflow = document.toJS();
  const requirements = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      const uses = String(step.uses ?? '')
        .split('@')[0]
        .toLowerCase();
      const add = (setting, required, key = 'uses', pattern = null) => {
        const node = document.getIn(['jobs', jobId, 'steps', index, key], true);
        const start = node?.range?.[0];
        const match =
          pattern && start !== undefined
            ? content.slice(start, node.range[1]).search(pattern)
            : -1;
        const offset = start === undefined ? null : start + Math.max(match, 0);
        requirements.push({
          setting,
          required,
          evidence: {
            kind: 'file',
            file: path,
            line: offset === null ? 1 : lineCounter.linePos(offset).line,
            text: String(step[key] ?? '').slice(0, 500),
          },
        });
      };
      if (
        [
          'actions/deploy-pages',
          'actions/upload-pages-artifact',
          'actions/configure-pages',
        ].includes(uses)
      ) {
        add('pages', 'workflow');
      }
      if (uses === 'actions/dependency-review-action') {
        add('dependency-graph', 'enabled');
        if (String(step.with?.['vulnerability-check'] ?? true) !== 'false') {
          add('vulnerability-alerts', 'enabled');
        }
      }
      if (
        [
          'github/codeql-action/analyze',
          'github/codeql-action/upload-sarif',
        ].includes(uses)
      ) {
        add('code-scanning-default-setup', 'disabled');
      }
      if (
        typeof step.run === 'string' &&
        /dependency-graph\/compare\b/i.test(step.run)
      ) {
        add(
          'dependency-graph',
          'enabled',
          'run',
          /dependency-graph\/compare\b/i
        );
      }
    }
  }
  return requirements;
}
