/**
 * Basic usage example
 *
 * Shows the parts of gh-manager that need neither a browser nor a token:
 * turning a pattern into a concrete list of packages, refusing a pattern that
 * would select everything, and turning a policy file into grants and revokes.
 *
 * Run with any runtime:
 * - Bun: bun examples/basic-usage.js
 * - Node.js: node examples/basic-usage.js
 * - Deno: deno run examples/basic-usage.js
 */

import {
  describeOperation,
  diffAccess,
  globToRegExpSource,
  matchPackageNames,
  parsePolicy,
  resolveTargets,
} from '../src/index.js';

// The packages an owner actually has. `gh-manager` reads this list from the
// GitHub API, or from the packages page when the API returns nothing.
const knownPackages = ['box', 'box-dind', 'box-slim', 'gh-manager', 'deep'];

/**
 * Stand-in for the enumeration gh-manager performs against GitHub.
 * @returns {string[]} The package names that exist
 */
function listNames() {
  return knownPackages;
}

console.log('Glob patterns:');
console.log(`  box*  compiles to  ${globToRegExpSource('box*')}`);
console.log(
  `  box*  matches      ${matchPackageNames(knownPackages, { pattern: 'box*' }).join(', ')}`
);
console.log(
  `  ^box-  matches     ${matchPackageNames(knownPackages, { pattern: '^box-', regex: true }).join(', ')}`
);

console.log('\nResolving what a command would act on:');
const fromPattern = await resolveTargets({ pattern: 'box*', listNames });
console.log(`  --pattern 'box*'   -> ${fromPattern.names.join(', ')}`);

const explicit = await resolveTargets({
  targets: ['box', 'box-dind'],
  listNames,
});
console.log(`  box box-dind       -> ${explicit.names.join(', ')}`);

// A pattern that selects everything is never expanded silently.
try {
  await resolveTargets({ pattern: '*', listNames });
} catch (error) {
  console.log(
    `  --pattern '*'      -> refused (exit ${error.exitCode}): ${error.message}`
  );
}

// A pattern that matches nothing fails loudly; it is never a silent no-op.
try {
  await resolveTargets({ pattern: 'nothing-*', listNames });
} catch (error) {
  console.log(
    `  --pattern 'nothing-*' -> refused (exit ${error.exitCode}): ${error.message}`
  );
}

console.log('\nPlanning permission changes from a policy:');
const policy = parsePolicy({
  packages: [
    {
      name: 'box',
      teams: { maintainers: 'admin', reviewers: 'read' },
    },
  ],
});

const [entry] = policy.entries;
const operations = diffAccess({
  packageName: entry.names[0],
  // What the package settings page currently shows.
  current: [
    { type: 'team', name: 'maintainers', role: 'write' },
    { type: 'user', name: 'former-contributor', role: 'admin' },
  ],
  desired: entry.grantees,
  exclusive: entry.exclusive,
});

for (const operation of operations) {
  console.log(`  ${describeOperation(operation)}`);
}
