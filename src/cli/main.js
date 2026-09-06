/**
 * The entry point every invocation goes through.
 *
 * `runCli` returns an exit code and never calls `process.exit`, which is
 * what makes the whole CLI testable in-process: a test can run a command with
 * fake output sinks and a fake browser and assert on both the output and the
 * code a release pipeline would see.
 */

import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

import { EXIT_CODES, CliError, exitCodeForError } from '../exit-codes.js';
import { DOMAINS, findDomain } from '../domains/index.js';
import { parseArgs } from './args.js';
import { createRunContext } from './context.js';
import { formatDomainUsage, formatUsage } from './usage.js';

/**
 * Read the version out of the installed package.json.
 * @returns {Promise<string>} Version string
 */
async function readVersion() {
  const manifest = new URL('../../package.json', import.meta.url);
  const { version } = JSON.parse(await readFile(manifest, 'utf8'));
  return version;
}

/**
 * Resolve the domain a command line names.
 * @param {Array<Object>} domains - Registered domains
 * @param {string} name - Name from the command line
 * @returns {Object} Domain definition
 */
function requireDomain(domains, name) {
  const domain = findDomain(domains, name);

  if (!domain) {
    throw new CliError(
      `Unknown domain "${name}". Available: ${domains.map((entry) => entry.name).join(', ')}.`,
      EXIT_CODES.USAGE
    );
  }

  return domain;
}

/**
 * Resolve the domain a command line names, following the nested spellings a
 * domain forwards elsewhere.
 *
 * A domain may declare `nested: { <word>: '<domain>' }`, which makes
 * `gh-manager package permissions grant box` mean `gh-manager permissions
 * grant box`. The forwarding target is a name looked up in the registry, so
 * the two domains stay independent of each other and the `domains` override
 * `runCli` accepts still decides what both spellings resolve to.
 * @param {Array<Object>} domains - Registered domains
 * @param {string[]} positionals - Positionals, starting at the domain name
 * @returns {{domain: Object, rest: string[]}} Domain and what follows it
 */
function resolveCommand(domains, positionals) {
  const [name, ...rest] = positionals;
  const domain = requireDomain(domains, name);
  const forwarded = domain.nested?.[rest[0]];

  return forwarded
    ? { domain: requireDomain(domains, forwarded), rest: rest.slice(1) }
    : { domain, rest };
}

/**
 * Resolve the verb a command line names.
 * @param {Object} domain - Domain definition
 * @param {string} name - Verb from the command line
 * @returns {Object} Verb definition
 */
function requireVerb(domain, name) {
  const verb = domain.verbs[name];

  if (!verb) {
    throw new CliError(
      `Unknown verb "${name}" for ${domain.name}. Available: ${Object.keys(domain.verbs).join(', ')}.`,
      EXIT_CODES.USAGE
    );
  }

  return verb;
}

/**
 * Handle the command lines that only print text.
 * @param {Object} options - Dispatch inputs
 * @param {string[]} options.positionals - Positional arguments
 * @param {Object} options.flags - Parsed flags
 * @param {Array<Object>} options.domains - Registered domains
 * @param {Function} options.stdout - Output sink
 * @returns {Promise<number|null>} Exit code, or null when there is work to do
 */
async function handleHelp({ positionals, flags, domains, stdout }) {
  const [first] = positionals;

  if (flags.version && !first) {
    stdout(await readVersion());
    return EXIT_CODES.SUCCESS;
  }

  if (first === 'help') {
    const named = positionals.slice(1);
    stdout(
      named.length > 0
        ? formatDomainUsage(resolveCommand(domains, named).domain)
        : formatUsage(domains)
    );
    return EXIT_CODES.SUCCESS;
  }

  if (!first) {
    stdout(formatUsage(domains));
    return flags.help ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE;
  }

  const { domain, rest } = resolveCommand(domains, positionals);

  if (rest.length === 0 || flags.help) {
    stdout(formatDomainUsage(domain));
    return flags.help ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE;
  }

  return null;
}

/**
 * Run one gh-manager command line.
 * @param {string[]} argv - Arguments after the executable and script
 * @param {Object} [options] - Runtime options
 * @param {Function} [options.stdout] - Standard output sink
 * @param {Function} [options.stderr] - Standard error sink
 * @param {Object} [options.env] - Environment variables
 * @param {string} [options.home] - Home directory override
 * @param {Array<Object>} [options.domains] - Command registry
 * @param {Object} [options.deps] - Injectable dependencies, used by tests
 * @returns {Promise<number>} Exit code
 */
export async function runCli(
  argv,
  {
    stdout = console.log,
    stderr = console.error,
    env = process.env,
    home,
    domains = DOMAINS,
    deps,
  } = {}
) {
  let flags = {};

  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;

    const printed = await handleHelp({
      positionals: parsed.positionals,
      flags,
      domains,
      stdout,
    });

    if (printed !== null) {
      return printed;
    }

    const { domain, rest } = resolveCommand(domains, parsed.positionals);
    const [verbName, ...targets] = rest;
    const verb = requireVerb(domain, verbName);
    const context = createRunContext({
      targets,
      flags,
      env,
      home,
      stdout,
      stderr,
      deps,
    });

    try {
      return (await verb.run(context)) ?? EXIT_CODES.SUCCESS;
    } finally {
      await context.close();
    }
  } catch (error) {
    stderr(`error: ${error.message}`);

    if (flags.verbose && error.stack) {
      stderr(error.stack);
    }

    return exitCodeForError(error);
  }
}
