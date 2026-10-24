import { describe, it, expect } from 'test-anywhere';
import { workflowRequirements } from '../src/doctor/workflows.js';
import { logRequirements } from '../src/doctor/logs.js';

const workflow = (uses, options = '') =>
  `# uses: github/codeql-action/analyze@v4\non: [push]\njobs:\n  check:\n    steps:\n      - uses: ${uses}@v4\n${options}`;
describe('doctor workflow evidence', () => {
  for (const action of [
    'actions/deploy-pages',
    'actions/upload-pages-artifact',
    'actions/configure-pages',
  ]) {
    it(`detects ${action} with its actual line`, () => {
      const rules = workflowRequirements({
        path: '.github/workflows/site.yml',
        content: workflow(action),
      });
      expect(rules.length).toBe(1);
      expect(rules[0].setting).toBe('pages');
      expect(rules[0].evidence.line).toBe(6);
    });
  }
  it('requires graph and alerts for vulnerability review', () => {
    const rules = workflowRequirements({
      path: 'review.yaml',
      content: workflow('actions/dependency-review-action'),
    });
    expect(rules.map((r) => r.setting)).toEqual([
      'dependency-graph',
      'vulnerability-alerts',
    ]);
  });
  it('does not require alerts when vulnerability checks are disabled', () => {
    const rules = workflowRequirements({
      path: 'review.yml',
      content: workflow(
        'actions/dependency-review-action',
        '        with:\n          vulnerability-check: false\n'
      ),
    });
    expect(rules.map((r) => r.setting)).toEqual(['dependency-graph']);
  });
  it('detects compare API use in a run block', () => {
    const rules = workflowRequirements({
      path: 'review.yml',
      content: `${workflow('actions/checkout')}      - run: gh api repos/acme/one/dependency-graph/compare/main...HEAD\n`,
    });
    expect(rules[0].setting).toBe('dependency-graph');
    expect(rules[0].evidence.line).toBe(7);
  });
  it('points to the compare command inside a multiline run', () => {
    const rules = workflowRequirements({
      path: 'review.yml',
      content:
        'jobs:\n  check:\n    steps:\n      - run: |\n          echo checking\n          gh api repos/acme/one/dependency-graph/compare/main...HEAD\n',
    });
    expect(rules[0].evidence.line).toBe(6);
  });
  for (const action of [
    'github/codeql-action/analyze',
    'github/codeql-action/upload-sarif',
  ]) {
    it(`requires default setup disabled for ${action}`, () => {
      const rules = workflowRequirements({
        path: 'security.yml',
        content: workflow(action),
      });
      expect(rules[0].setting).toBe('code-scanning-default-setup');
      expect(rules[0].required).toBe('disabled');
    });
  }
  it('recognizes Dependabot config', () => {
    expect(
      workflowRequirements({
        path: '.github/dependabot.yml',
        content: 'version: 2',
      })[0].setting
    ).toBe('vulnerability-alerts');
  });
  it('does not match commented-out steps', () => {
    expect(
      workflowRequirements({
        path: 'x.yml',
        content: workflow('actions/checkout'),
      }).length
    ).toBe(0);
  });
  it('rejects malformed YAML and returns a scan error', () => {
    let error;
    try {
      workflowRequirements({ path: 'x.yml', content: 'jobs: [' });
    } catch (caught) {
      error = caught;
    }
    expect(Boolean(error)).toBe(true);
  });
});
describe('doctor failed log evidence', () => {
  for (const [text, setting] of [
    ['The dependency graph is disabled for acme/one', 'dependency-graph'],
    [
      'Dependency review is not supported on this repository',
      'dependency-graph',
    ],
    ['Get Pages site failed', 'pages'],
    ['Ensure GitHub Pages has been enabled', 'pages'],
    [
      'CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled',
      'code-scanning-default-setup',
    ],
    ['Code scanning is not enabled for this repository', 'code-scanning'],
  ]) {
    it(`maps ${text}`, () => {
      const rules = logRequirements({
        runUrl: 'https://github.com/acme/one/actions/runs/1',
        runId: 1,
        matches: [{ line: 17, text, jobId: 2 }],
      });
      expect(rules[0].setting).toBe(setting);
      expect(rules[0].evidence.line).toBe(17);
      expect(rules[0].evidence.runId).toBe(1);
    });
  }
});
