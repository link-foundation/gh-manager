/** Emit a Playwright MCP probe using the actual serialized browser inspector. */
import { inspectSecurityRows } from '../src/browser/dom.js';
import { SECURITY_FEATURES } from '../src/security/features.js';
import {
  SECURITY_CONTROLS,
  SECURITY_LOCK_PHRASES,
} from '../src/browser/selectors.js';

const evaluation = inspectSecurityRows(
  { evaluate: (value) => value },
  {
    features: SECURITY_FEATURES,
    controls: SECURITY_CONTROLS,
    lockPhrases: SECURITY_LOCK_PHRASES,
  }
);
const html =
  '<div class="Box-row"><h3>Future checkbox</h3><input type="checkbox" checked></div><div class="Box-row"><h3>Future policy</h3><span>Enabled for all repositories in the organization</span></div>';
console.log(`async (page) => {
  await page.setContent(${JSON.stringify(html)});
  const inspect = ${evaluation.fn.toString()};
  const args = ${JSON.stringify(evaluation.args[0])};
  const before = await page.evaluate(inspect, args);
  const checkbox = before.rows.find(row => row.label === 'Future checkbox');
  const policy = before.rows.find(row => row.label === 'Future policy');
  if (checkbox.state !== 'enabled' || policy.state !== 'enabled' || !policy.locked) throw new Error('Incorrect initial state');
  await page.locator('input[type=checkbox]').click();
  const after = await page.evaluate(inspect, args);
  if (after.rows.find(row => row.label === 'Future checkbox').state !== 'disabled') throw new Error('Stale checked attribute was read');
  return {initial: checkbox.state, changed: 'disabled', policyLocked: policy.locked};
}`);
