/** Declaration probe: npx --package typescript tsc --noEmit --strict --module nodenext experiments/issue-24-api.mts */
import {
  createDoctor,
  createPagesManager,
  createRestClient,
  pagesSource,
  createRunManager,
  type DoctorReport,
} from '../src/index.js';
const rest = createRestClient({ token: 'fixture' });
const pages = createPagesManager({ rest, verificationTimeout: 0 });
const site = await pages.setSource('acme/one', pagesSource({ actions: true }));
const report: DoctorReport = await createDoctor({ rest, pages }).scan(
  { org: 'acme' },
  { fix: false, rerun: false }
);
await createRunManager({ rest }).failuresForRepository('acme/one', {
  branch: 'main',
});
void [site, report];
