import {
  createRestClient,
  createRunManager,
  JobsUnavailableError,
} from '../src/index.js';

// Read-only example: GH_TOKEN needs Actions:read and Checks:read for private repos.
const [repo, runId] = process.argv.slice(2);
const rest = createRestClient({
  token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
});
const runs = createRunManager({
  rest,
  log: { debug: (message) => console.error(message) },
});
try {
  const jobs = await runs.jobs(repo, Number(runId));
  console.log(
    JSON.stringify(
      jobs.map(
        ({
          id,
          name,
          status,
          conclusion,
          run_attempt,
          head_sha,
          discovery,
        }) => ({
          id,
          name,
          status,
          conclusion,
          runAttempt: run_attempt,
          sha: head_sha,
          discovery,
        })
      ),
      null,
      2
    )
  );
} catch (error) {
  if (!(error instanceof JobsUnavailableError)) {
    throw error;
  }
  console.log(JSON.stringify(error.evidence, null, 2));
  process.exitCode = 1;
}
