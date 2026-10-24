/** Read-only CI settings diagnosis using the public library API. */
import { createDoctor, createRestClient } from '../src/index.js';

const repo = process.argv[2];
if (!repo) {
  throw new Error('Usage: node examples/diagnose-repository.js owner/repo');
}
const rest = createRestClient({
  token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
});
// Page-only settings are unknown when no signed-in browser is supplied.
const doctor = createDoctor({
  rest,
  log: { debug: (message) => process.stderr.write(`${message}\n`) },
});
const report = await doctor.scan({ repo });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.exitCode;
