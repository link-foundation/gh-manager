import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, it, expect } from 'test-anywhere';

const { jobs } = parse(readFileSync('.github/workflows/release.yml', 'utf8'));

describe('release versioning runtimes', () => {
  for (const jobName of ['release', 'instant-release', 'changeset-check']) {
    it(`installs Node.js and pinned Deno before versioning in ${jobName}`, () => {
      const steps = jobs[jobName].steps;
      const versionIndex = steps.findIndex((step) =>
        /changeset:version|version-and-commit/.test(step.run ?? '')
      );
      expect(versionIndex).toBeGreaterThan(-1);
      for (const runtime of ['actions/setup-node', 'denoland/setup-deno']) {
        const setupIndex = steps.findIndex((step) =>
          step.uses?.startsWith(`${runtime}@`)
        );
        expect(setupIndex).toBeGreaterThan(-1);
        expect(setupIndex).toBeLessThan(versionIndex);
        expect(steps[setupIndex].if).toBeUndefined();
      }
      const deno = steps.find((step) => step.uses?.startsWith('denoland/'));
      expect(deno.uses).toMatch(/@[a-f0-9]{40}$/);
      expect(deno.with['deno-version']).toBe('v2.x');
    });
  }

  it('exercises real versioning after validating PR changesets', () => {
    const job = jobs['changeset-check'];
    expect(job.if).toContain("github.event_name == 'pull_request'");
    const validationIndex = job.steps.findIndex((step) =>
      step.run?.includes('node scripts/validate-changeset.mjs')
    );
    const versionIndex = job.steps.findIndex((step) =>
      step.run?.includes('npm run changeset:version')
    );
    expect(versionIndex).toBeGreaterThan(validationIndex);
    expect(job.steps[versionIndex].if).toBeUndefined();
    expect(job.steps[versionIndex]['timeout-minutes']).toBe(5);
    expect(jobs['pipeline-status'].needs).toContain('changeset-check');
  });
});
