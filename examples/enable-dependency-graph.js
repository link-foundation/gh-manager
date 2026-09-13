/**
 * Enable the dependency graph of several repositories.
 *
 * This is the workflow the `security` domain was written for: a
 * `actions/dependency-review` job fails with "Dependency review is not
 * supported on this repository. Please ensure that Dependency graph is enabled"
 * and the toggle that fixes it exists nowhere but the settings page, so no
 * script built on the REST or GraphQL API can flip it.
 *
 * `runCli` returns an exit code and never calls `process.exit`, so the whole
 * command line runs in process and its outcome is a value this script can act
 * on. A repository whose graph is already on exits `0` without changing
 * anything, which is what makes the loop safe to re-run.
 *
 * Run with any runtime, after `gh-manager auth login`:
 * - Bun: bun examples/enable-dependency-graph.js owner/repo [owner/repo...]
 * - Node.js: node examples/enable-dependency-graph.js owner/repo [owner/repo...]
 * - Deno: deno run -A examples/enable-dependency-graph.js owner/repo
 */

import { EXIT_CODES, runCli } from '../src/index.js';

const repositories = process.argv.slice(2);

if (repositories.length === 0) {
  console.error(
    'Name the repositories to act on: node examples/enable-dependency-graph.js owner/repo [owner/repo...]'
  );
  process.exitCode = EXIT_CODES.USAGE;
} else {
  const failed = [];

  for (const repository of repositories) {
    // `--yes` answers the confirmation this script has already made on the
    // operator's behalf; `--json` keeps standard output parseable.
    const code = await runCli([
      'security',
      'dependency-graph',
      repository,
      '--enable',
      '--yes',
      '--json',
    ]);

    if (code !== EXIT_CODES.SUCCESS) {
      failed.push({ repository, code });
    }
  }

  for (const { repository, code } of failed) {
    console.error(`${repository} was not changed (exit ${code})`);
  }

  // The screenshot and the page HTML of any failure are in ~/.gh-manager/logs/.
  process.exitCode = failed.length === 0 ? EXIT_CODES.SUCCESS : failed[0].code;
}
