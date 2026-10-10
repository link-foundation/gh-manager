import { describe, it, expect } from 'test-anywhere';
import { auditWorkflows } from '../src/secrets/audit.js';
import { restClientFor } from './fixtures/fake-github-api.js';

const repo = { owner: 'acme', name: 'one' };
const workflow = `# secrets.COMMENT_ONLY\non: push\njobs:\n  publish:\n    steps:\n      - run: echo \${{ secrets.NPM_TOKEN }}\n      - env:\n          TOKEN: \${{ secrets['DOCKERHUB_TOKEN'] }}\n          RELEASE: \${{ secrets.RELEASE_PR_TOKEN }}\n          DYNAMIC: \${{ secrets[matrix.secret] }}\n`;
const rest = () =>
  restClientFor({
    '/repos/acme/one/contents/.github/workflows': {
      body: [
        {
          type: 'file',
          name: 'release.yml',
          path: '.github/workflows/release.yml',
        },
      ],
    },
    '/repos/acme/one/contents/.github/workflows/release.yml': {
      body: {
        encoding: 'base64',
        content: Buffer.from(workflow).toString('base64'),
      },
    },
  });

describe('workflow secret audit', () => {
  it('locates static references and App alternatives without treating comments as use', async () => {
    const report = await auditWorkflows({
      rest: rest(),
      repos: [repo],
      secrets: [
        { name: 'NPM_TOKEN' },
        { name: 'DOCKERHUB_TOKEN' },
        { name: 'UNUSED' },
      ],
    });
    expect(report.references.map((entry) => entry.name)).toEqual([
      'NPM_TOKEN',
      'DOCKERHUB_TOKEN',
      'RELEASE_PR_TOKEN',
    ]);
    expect(report.references[0].line).toBe(6);
    expect(report.references[0].recommendation).toContain('caller policy');
    expect(report.references[2].recommendation).toContain('GitHub App');
    expect(report.unused).toEqual([]);
    expect(report.possiblyUnused).toEqual(['UNUSED']);
    expect(report.dynamicReferences.length).toBe(1);
    expect(report.complete).toBe(false);
  });
  it('reports unused secrets only when every workflow is readable and has static references', async () => {
    const client = restClientFor({
      '/repos/acme/one/contents/.github/workflows': {
        body: [
          { type: 'file', name: 'ci.yaml', path: '.github/workflows/ci.yaml' },
        ],
      },
      '/repos/acme/one/contents/.github/workflows/ci.yaml': {
        body: {
          encoding: 'base64',
          content: Buffer.from('token: ${{ secrets.TOKEN }}').toString(
            'base64'
          ),
        },
      },
    });
    const report = await auditWorkflows({
      rest: client,
      repos: [repo],
      secrets: [{ name: 'UNUSED' }],
    });
    expect(report.unused).toEqual(['UNUSED']);
    expect(report.complete).toBe(true);
  });
  it('marks unreadable repositories incomplete and retains possibly unused secrets', async () => {
    const report = await auditWorkflows({
      rest: restClientFor({}),
      repos: [repo],
      secrets: [{ name: 'NPM_TOKEN' }],
    });
    expect(report.complete).toBe(false);
    expect(report.unused).toEqual([]);
    expect(report.unreadable.length).toBe(1);
  });
});
