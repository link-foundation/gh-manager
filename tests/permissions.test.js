/**
 * Package permissions: the policy arithmetic, and the commands built on it.
 *
 * `diffAccess` is the function that decides what will be taken away, so it is
 * tested as a pure function; the verbs are then run end to end so the plan an
 * operator is asked to approve is the plan that actually gets applied.
 */

import { describe, it, expect } from 'test-anywhere';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES } from '../src/exit-codes.js';
import {
  describeOperation,
  diffAccess,
  parsePolicy,
  validateRole,
} from '../src/permissions/policy.js';
import { fakeGitHub, runCommand } from './fixtures/cli-runner.js';

const DIRECTORY = [
  { type: 'team', name: 'maintainers' },
  { type: 'user', name: 'konard' },
];

/**
 * Run an operation and return the error it produced.
 * @param {() => any} operation - Work expected to fail
 * @returns {Error} The thrown error
 */
function failureOf(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }

  throw new Error('expected the operation to fail');
}

/**
 * Write a policy document to a temporary file.
 * @param {Object} document - Policy to serialize
 * @returns {{path: string, remove: () => void}} File handle
 */
function policyFile(document) {
  const directory = mkdtempSync(join(tmpdir(), 'gh-manager-policy-'));
  const path = join(directory, 'policy.json');
  writeFileSync(path, JSON.stringify(document));

  return {
    path,
    remove: () => rmSync(directory, { force: true, recursive: true }),
  };
}

describe('validateRole', () => {
  it('accepts a role in any casing', () => {
    expect(validateRole('Write', '--role')).toBe('write');
  });

  it('names the offending value and the roles that exist', () => {
    const error = failureOf(() => validateRole('owner', '--role'));

    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
    expect(error.message).toBe(
      '--role must be one of read, write, admin; got "owner"'
    );
  });
});

describe('parsePolicy', () => {
  it('normalizes teams, users, and a single package name', () => {
    const policy = parsePolicy({
      packages: [{ name: 'box', teams: { maintainers: 'Write' } }],
    });

    expect(policy.entries).toEqual([
      {
        names: ['box'],
        pattern: null,
        regex: false,
        exclusive: true,
        grantees: [{ type: 'team', name: 'maintainers', role: 'write' }],
      },
    ]);
  });

  it('keeps grantees a policy omits when the entry is not exclusive', () => {
    const [entry] = parsePolicy({
      packages: [
        { pattern: 'box*', exclusive: false, users: { konard: 'admin' } },
      ],
    }).entries;

    expect(entry.exclusive).toBe(false);
    expect(entry.grantees).toEqual([
      { type: 'user', name: 'konard', role: 'admin' },
    ]);
  });

  it('rejects a document that is not an object', () => {
    expect(failureOf(() => parsePolicy([])).message).toContain(
      '"packages" must be an array'
    );
    expect(failureOf(() => parsePolicy(null)).message).toContain(
      'the file must contain a JSON object'
    );
  });

  it('says which entry is missing its packages', () => {
    const error = failureOf(() =>
      parsePolicy({ packages: [{ teams: { maintainers: 'read' } }] })
    );

    expect(error.message).toContain(
      'packages[0] needs "name", "names", or "pattern"'
    );
  });

  it('says which grantee carries an unusable role', () => {
    const error = failureOf(() =>
      parsePolicy({ packages: [{ name: 'box', users: { konard: 'owner' } }] })
    );

    expect(error.message).toContain('Policy: role of user "konard"');
  });

  it('rejects a grantee map that is a list', () => {
    const error = failureOf(() =>
      parsePolicy({ packages: [{ name: 'box', teams: ['maintainers'] }] })
    );

    expect(error.message).toContain(
      '"teams" must be an object mapping names to roles'
    );
  });
});

describe('diffAccess', () => {
  const current = [
    { type: 'team', name: 'Maintainers', role: 'read' },
    { type: 'user', name: 'konard', role: 'admin' },
  ];

  it('grants what is missing and upgrades what differs', () => {
    const operations = diffAccess({
      packageName: 'box',
      current,
      desired: [
        { type: 'team', name: 'maintainers', role: 'write' },
        { type: 'user', name: 'konard', role: 'admin' },
      ],
    });

    expect(operations).toEqual([
      {
        kind: 'grant',
        packageName: 'box',
        grantee: { type: 'team', name: 'maintainers' },
        role: 'write',
      },
    ]);
  });

  it('revokes everyone the policy leaves out', () => {
    const operations = diffAccess({
      packageName: 'box',
      current,
      desired: [{ type: 'team', name: 'maintainers', role: 'read' }],
    });

    expect(operations).toEqual([
      {
        kind: 'revoke',
        packageName: 'box',
        grantee: { type: 'user', name: 'konard' },
        role: null,
      },
    ]);
  });

  it('never revokes when the entry is not exclusive', () => {
    const operations = diffAccess({
      packageName: 'box',
      current,
      desired: [],
      exclusive: false,
    });

    expect(operations).toEqual([]);
  });

  it('tells a team and a user of the same name apart', () => {
    const operations = diffAccess({
      packageName: 'box',
      current: [{ type: 'team', name: 'ops', role: 'read' }],
      desired: [{ type: 'user', name: 'ops', role: 'read' }],
    });

    expect(operations.map((operation) => operation.kind)).toEqual([
      'grant',
      'revoke',
    ]);
  });
});

describe('describeOperation', () => {
  it('reads as a sentence in the confirmation prompt', () => {
    expect(
      describeOperation({
        kind: 'grant',
        packageName: 'box',
        grantee: { type: 'team', name: 'maintainers' },
        role: 'write',
      })
    ).toBe('box: grant write to team maintainers');

    expect(
      describeOperation({
        kind: 'revoke',
        packageName: 'box',
        grantee: { type: 'user', name: 'konard' },
      })
    ).toBe('box: revoke access from user konard');
  });
});

describe('gh-manager permissions', () => {
  it('lists who holds a role on each selected package', async () => {
    const github = fakeGitHub([
      {
        packageName: 'box',
        directory: DIRECTORY,
        access: [{ type: 'team', name: 'maintainers', role: 'admin' }],
      },
      { packageName: 'box-dind', directory: DIRECTORY },
    ]);

    const result = await runCommand(
      ['permissions', 'list', '--pattern', 'box*', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.output).toContain('box:\n  team maintainers: admin');
    expect(result.output).toContain(
      'box-dind:\n  (no team or user has package-level access)'
    );
  });

  it('grants a role without asking for explicitly named packages', async () => {
    const github = fakeGitHub([{ packageName: 'box', directory: DIRECTORY }]);

    const result = await runCommand(
      [
        'permissions',
        'grant',
        'box',
        '--team',
        'maintainers',
        '--role',
        'write',
        '--org',
        'link-foundation',
      ],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.asked).toEqual([]);
    expect(github.states.get('box').access).toEqual([
      { type: 'team', name: 'maintainers', role: 'write' },
    ]);
    expect(result.output).toContain(
      'box: grant write to team maintainers: done.'
    );
  });

  it('always asks before taking access away', async () => {
    const github = fakeGitHub([
      {
        packageName: 'box',
        directory: DIRECTORY,
        access: [{ type: 'user', name: 'konard', role: 'read' }],
      },
    ]);

    const result = await runCommand(
      [
        'permissions',
        'revoke',
        'box',
        '--user',
        'konard',
        '--org',
        'link-foundation',
      ],
      { github, confirm: () => false }
    );

    expect(result.code).toBe(EXIT_CODES.ABORTED);
    expect(result.asked).toEqual(['Proceed with 1 operation(s)?']);
    expect(github.states.get('box').access.length).toBe(1);
  });

  it('needs a role to grant', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      [
        'permissions',
        'grant',
        'box',
        '--team',
        'x',
        '--org',
        'link-foundation',
      ],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('pass --role <read|write|admin>');
  });

  it('needs a grantee to act on', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      [
        'permissions',
        'grant',
        'box',
        '--role',
        'read',
        '--org',
        'link-foundation',
      ],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('pass --team <name> or --user <login>');
  });

  it('needs a policy file to sync', async () => {
    const github = fakeGitHub([{ packageName: 'box' }]);

    const result = await runCommand(
      ['permissions', 'sync', '--org', 'link-foundation'],
      { github }
    );

    expect(result.code).toBe(EXIT_CODES.USAGE);
    expect(result.errors).toContain('pass --from <policy.json>');
  });
});

describe('gh-manager permissions sync', () => {
  const document = {
    packages: [{ pattern: 'box*', teams: { maintainers: 'write' } }],
  };

  /**
   * Serve two packages whose access lists differ from the policy.
   * @returns {Object} Result of fakeGitHub
   */
  const serve = () =>
    fakeGitHub([
      {
        packageName: 'box',
        directory: DIRECTORY,
        access: [
          { type: 'team', name: 'maintainers', role: 'read' },
          { type: 'user', name: 'konard', role: 'admin' },
        ],
      },
      {
        packageName: 'box-dind',
        directory: DIRECTORY,
        access: [{ type: 'team', name: 'maintainers', role: 'write' }],
      },
    ]);

  it('converges every package onto the policy', async () => {
    const policy = policyFile(document);
    const service = serve();

    try {
      const result = await runCommand(
        [
          'permissions',
          'sync',
          '--from',
          policy.path,
          '--org',
          'link-foundation',
        ],
        { github: service }
      );

      expect(result.code).toBe(EXIT_CODES.SUCCESS);
      expect(result.asked).toEqual(['Proceed with 2 operation(s)?']);
      expect(service.states.get('box').access).toEqual([
        { type: 'team', name: 'maintainers', role: 'write' },
      ]);
      expect(service.states.get('box-dind').access).toEqual([
        { type: 'team', name: 'maintainers', role: 'write' },
      ]);
    } finally {
      policy.remove();
    }
  });

  it('shows the plan and changes nothing for --dry-run', async () => {
    const policy = policyFile(document);
    const service = serve();

    try {
      const result = await runCommand(
        [
          'permissions',
          'sync',
          '--from',
          policy.path,
          '--org',
          'link-foundation',
          '--dry-run',
        ],
        { github: service }
      );

      expect(result.code).toBe(EXIT_CODES.SUCCESS);
      expect(result.output).toContain('box: grant write to team maintainers');
      expect(result.output).toContain('box: revoke access from user konard');
      expect(result.output).toContain('Dry run: nothing was changed.');
      expect(result.asked).toEqual([]);
      expect(service.states.get('box').access.length).toBe(2);
    } finally {
      policy.remove();
    }
  });
});
