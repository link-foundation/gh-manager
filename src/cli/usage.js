/**
 * Help text, generated from the command registry.
 *
 * The registry is the single source of truth for which domains and verbs
 * exist, so help can never drift from what the CLI actually accepts.
 */

/**
 * Pad a name so the summaries line up.
 * @param {string[]} names - All names in the column
 * @returns {(name: string) => string} Padding function
 */
function padder(names) {
  const width = Math.max(...names.map((name) => name.length));
  return (name) => name.padEnd(width);
}

/**
 * Build the top level help text.
 * @param {Array<Object>} domains - Registered domains
 * @returns {string} Help text
 */
export function formatUsage(domains) {
  const pad = padder(domains.map((domain) => domain.name));
  const lines = [
    'gh-manager - manage GitHub packages through a real browser session',
    '',
    'Usage: gh-manager <domain> <verb> [targets...] [options]',
    '',
    'Domains:',
    ...domains.map((domain) => `  ${pad(domain.name)}  ${domain.summary}`),
    '',
    'Common options:',
    '  --org <name>          Organization that owns the packages',
    '  --account <login>     Personal account that owns the packages',
    '  --package-type <type> Package ecosystem (default: container)',
    '  --pattern <glob>      Select packages by name pattern',
    '  --regex               Treat --pattern as a regular expression',
    '  --all                 Allow a pattern that selects everything',
    '  --dry-run             Show what would happen, change nothing',
    '  --yes, -y             Answer confirmation prompts in advance',
    '  --headless            Run the browser without a window',
    '  --app-dir <path>      Application directory (default: ~/.gh-manager)',
    '  --token <token>       API token for reads and verification',
    '  --json                Machine readable output where available',
    '  --verbose             Print what the tool is doing',
    '  --help, -h            Show help for a domain',
    '  --version, -v         Print the version',
    '',
    'Run `gh-manager <domain> --help` for the verbs of one domain.',
  ];

  return lines.join('\n');
}

/**
 * Describe the words a domain forwards to another domain.
 * @param {Object} domain - Domain definition
 * @returns {string[]} Help lines, empty when the domain forwards nothing
 */
function formatNested(domain) {
  const words = Object.keys(domain.nested ?? {});

  if (words.length === 0) {
    return [];
  }

  return [
    '',
    'Forwards to:',
    ...words.map(
      (word) =>
        `  ${word}  the ${domain.nested[word]} domain, so \`gh-manager ${domain.name} ${word} <verb>\`` +
        ` and \`gh-manager ${domain.nested[word]} <verb>\` are the same command`
    ),
  ];
}

/**
 * Build the help text of one domain.
 * @param {Object} domain - Domain definition
 * @returns {string} Help text
 */
export function formatDomainUsage(domain) {
  const names = Object.keys(domain.verbs);
  const pad = padder(names);

  return [
    `gh-manager ${domain.name} - ${domain.summary}`,
    '',
    'Verbs:',
    ...names.map((name) => `  ${pad(name)}  ${domain.verbs[name].summary}`),
    ...formatNested(domain),
    '',
    ...domain.usage,
  ].join('\n');
}
