// Run `doctor --from` against the links-notation fixture and print calls.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../tests/fixtures/cli-runner.js';
import { desiredPolicy, driftApi, REPO } from '../tests/fixtures/drift-api.js';

const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
const policy = join(dir, 'policy.json');
writeFileSync(policy, JSON.stringify(desiredPolicy()));
const api = driftApi();
const args = ['doctor', REPO, '--from', policy, ...process.argv.slice(2)];
const result = await runCommand(args, { github: api, realPrompt: true });
console.log('code', result.code);
console.log(result.output);
console.log(result.errors ?? '');
console.log(api.calls.map((c) => `${c.method} ${c.path}`).join('\n'));
