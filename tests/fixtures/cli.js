import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.js';

export async function apiCommand(args, api, deps = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gh-manager-api-cli-'));
  const stdout = [];
  const stderr = [];
  try {
    const code = await runCli(args, {
      env: {},
      home,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      deps: {
        resolveToken: () => ({ token: 'fake', source: 'test' }),
        createRest: () => api.rest,
        readSecret: () => 'value',
        confirm: () => true,
        ...deps,
      },
    });
    return { code, output: stdout.join('\n'), errors: stderr.join('\n') };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
