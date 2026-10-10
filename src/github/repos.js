import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repoPath } from './rest.js';
import { accountName, pages, repositoryTarget } from './discovery.js';

function fileMatcher(pattern) {
  if (typeof pattern !== 'string' || !pattern.length) {
    throw new CliError('Supply a nonempty file glob.', EXIT_CODES.USAGE);
  }
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        source += '(?:.*/)?';
        index++;
      } else {
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

async function treeEntries(rest, base, branch) {
  const recursive = await rest.request(
    `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  if (!Array.isArray(recursive.tree)) {
    throw new CliError('GitHub returned an unreadable tree.');
  }
  if (!recursive.truncated) {
    return recursive.tree;
  }
  const entries = [];
  const pending = [{ sha: recursive.sha ?? branch, prefix: '' }];
  while (pending.length) {
    const { sha, prefix } = pending.pop();
    const tree = await rest.request(
      `${base}/git/trees/${encodeURIComponent(sha)}`
    );
    if (tree.truncated || !Array.isArray(tree.tree)) {
      throw new CliError('GitHub truncated a nonrecursive tree.');
    }
    for (const item of tree.tree) {
      const path = `${prefix}${item.path}`;
      if (item.type === 'tree') {
        pending.push({ sha: item.sha, prefix: `${path}/` });
      } else {
        entries.push({ ...item, path });
      }
    }
  }
  return entries;
}

async function blobContent(rest, base, sha) {
  const blob = await rest.request(
    `${base}/git/blobs/${encodeURIComponent(sha)}`
  );
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new CliError('GitHub returned unreadable file content.');
  }
  return Buffer.from(blob.content, 'base64').toString('utf8');
}

/** Stable repository discovery service. File globs support *, ?, and **. */
export function createRepoManager({ rest, log } = {}) {
  return {
    async list({
      org,
      user,
      includeArchived = false,
      includeForks = false,
    } = {}) {
      if (Boolean(org) === Boolean(user)) {
        throw new CliError('Choose exactly one org or user.', EXIT_CODES.USAGE);
      }
      const path = org
        ? `/orgs/${accountName(org)}/repos`
        : `/users/${accountName(user)}/repos`;
      log?.debug(`repos API: GET ${path}`);
      const items = await pages(rest, path);
      return items.filter(
        (item) =>
          (includeArchived || !item.archived) && (includeForks || !item.fork)
      );
    },

    async files(target, { match = [], content = false, ref } = {}) {
      const patterns = match.map(fileMatcher);
      if (!patterns.length) {
        throw new CliError(
          'Supply at least one file match glob.',
          EXIT_CODES.USAGE
        );
      }
      const base = repoPath(repositoryTarget(target));
      const branch = ref ?? (await rest.request(base)).default_branch;
      if (!branch) {
        throw new CliError('GitHub did not return a default branch.');
      }
      const treePath = `${base}/git/trees/${encodeURIComponent(branch)}`;
      log?.debug(`repos API: GET ${treePath}`);
      const entries = await treeEntries(rest, base, branch);
      const files = [];
      for (const item of entries) {
        if (
          item.type !== 'blob' ||
          !patterns.some((pattern) => pattern.test(item.path))
        ) {
          continue;
        }
        const file = { path: item.path, sha: item.sha };
        if (content) {
          file.content = await blobContent(rest, base, item.sha);
        }
        files.push(file);
      }
      return files.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
