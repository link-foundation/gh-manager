import { describe, it, expect } from 'test-anywhere';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const job = parse(readFileSync('.github/workflows/example-app.yml', 'utf8'))
  .jobs['preview-regen'];

describe('preview regeneration shell contract', () => {
  it('uses Bash for container steps and passes drift through the environment', () => {
    expect(job.defaults?.run?.shell).toBe('bash');
    const summary = job.steps.find(
      (step) => step.name === 'Summarize regeneration result'
    );
    expect(summary.env?.DRIFT).toBe('${{ steps.drift.outputs.drift }}');
    expect(summary.run).not.toContain('${{');
  });

  it('executes the real summary script for both drift states', () => {
    if (typeof Deno !== 'undefined' || process.platform === 'win32') {
      return;
    }
    const summary = job.steps.find(
      (step) => step.name === 'Summarize regeneration result'
    );
    for (const drift of ['true', 'false']) {
      const work = mkdtempSync(join(tmpdir(), 'preview-summary-'));
      try {
        const result = spawnSync(
          job.defaults?.run?.shell ?? 'sh',
          ['-e', '-c', summary.run],
          {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, DRIFT: drift },
          }
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          drift === 'true' ? 'regenerated' : 'up to date'
        );
        expect(result.stderr).toBe('');
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  });
});
