import { CliError, EXIT_CODES } from '../exit-codes.js';
import { parseRepoSpec } from './repo.js';
import { URLSearchParams } from 'node:url';

export function repositoryTarget(spec) {
  if (typeof spec === 'string') {
    return parseRepoSpec(spec, {
      defaultOwner: () => {
        throw new CliError('Use owner/repo.', EXIT_CODES.USAGE);
      },
    });
  }
  if (!spec?.owner || !spec?.name) {
    throw new CliError('Use owner/repo.', EXIT_CODES.USAGE);
  }
  return parseRepoSpec(`${spec?.owner}/${spec?.name}`, {
    defaultOwner: () => ({}),
  });
}

export function accountName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CliError('Supply a GitHub account login.', EXIT_CODES.USAGE);
  }
  return encodeURIComponent(value);
}

export function selectedTargets(org, specs) {
  accountName(org);
  return [
    ...new Map(
      specs.map((spec) => {
        const repo = repositoryTarget(
          spec.includes('/') ? spec : `${org}/${spec}`
        );
        if (repo.owner.toLowerCase() !== org.toLowerCase()) {
          throw new CliError(
            'Selected repositories must belong to the organization.',
            EXIT_CODES.USAGE
          );
        }
        return [`${repo.owner}/${repo.name}`.toLowerCase(), repo];
      })
    ).values(),
  ];
}

export async function pages(rest, path, property, { query = {}, limit } = {}) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new CliError('Limit must be a positive integer.', EXIT_CODES.USAGE);
  }
  const items = [];
  for (let page = 1; ; page++) {
    const parameters = new URLSearchParams({
      ...query,
      per_page: '100',
      page: String(page),
    });
    const body = await rest.request(`${path}?${parameters}`);
    const batch = property ? body?.[property] : body;
    if (!Array.isArray(batch)) {
      throw new CliError('GitHub returned an incomplete inventory.');
    }
    items.push(...batch);
    if (limit && items.length >= limit) {
      return items.slice(0, limit);
    }
    if (batch.length < 100) {
      return items;
    }
  }
}

export function expressions(patterns = []) {
  try {
    return patterns.map((pattern) => new RegExp(pattern, 'i'));
  } catch {
    throw new CliError(
      'Invalid failure/log regular expression.',
      EXIT_CODES.USAGE
    );
  }
}

// GitHub masks configured secret values. Also withhold common credentials
// accidentally printed by tools before producing structured log evidence.
export function redactLine(line) {
  return line
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:[\w-]*(?:token|password|secret|api[_-]?key)[\w-]*)\s*[:=]\s*)["']?[^\s"']+["']?/gi,
      '$1[REDACTED]'
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      '[REDACTED]'
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function matchingLines(source, patterns = []) {
  const regexes = expressions(patterns);
  return source.split(/\r?\n/).flatMap((raw, index) => {
    const text = raw.replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
      ''
    );
    if (
      !text ||
      (regexes.length && !regexes.some((regex) => regex.test(text)))
    ) {
      return [];
    }
    return [{ line: index + 1, text: redactLine(text) }];
  });
}
