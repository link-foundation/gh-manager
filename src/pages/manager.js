import { CliError, EXIT_CODES } from '../exit-codes.js';
import { repositoryTarget } from '../github/discovery.js';
import { repoPath } from '../github/rest.js';
import {
  pollUntil,
  VERIFICATION_INTERVAL_MS,
  VERIFICATION_TIMEOUT_MS,
} from '../verification.js';

export function pagesSource({ actions, branch } = {}) {
  if (Boolean(actions) === Boolean(branch)) {
    throw new CliError(
      'Choose exactly one of --actions or --branch <branch>[:/|:/docs].',
      EXIT_CODES.USAGE
    );
  }
  if (actions) {
    return { build_type: 'workflow' };
  }
  const [name, path = '/'] = branch.split(':');
  if (
    !name ||
    branch.split(':').length > 2 ||
    !['/', '/docs'].includes(path) ||
    /[\s~^:?*[\\]/.test(name) ||
    name.includes('..') ||
    name.startsWith('-')
  ) {
    throw new CliError(
      'Supply a branch and optionally :/ or :/docs.',
      EXIT_CODES.USAGE
    );
  }
  return { build_type: 'legacy', source: { branch: name, path } };
}

function matches(site, wanted) {
  return (
    site.enabled &&
    site.build_type === wanted.build_type &&
    (wanted.build_type === 'workflow' ||
      (site.source?.branch === wanted.source.branch &&
        site.source?.path === wanted.source.path))
  );
}

export function createPagesManager({
  rest,
  verificationTimeout = VERIFICATION_TIMEOUT_MS,
} = {}) {
  const manager = {
    async status(target) {
      const repo = repositoryTarget(target);
      // Establish access before interpreting an ambiguous Pages 404 as absent.
      await rest.request(repoPath(repo));
      const site = await rest.request(`${repoPath(repo)}/pages`, {
        allowNotFound: true,
      });
      if (site === null) {
        return { enabled: false, build_type: 'disabled', source: null };
      }
      if (!['legacy', 'workflow'].includes(site?.build_type)) {
        throw new CliError('GitHub did not report a Pages build_type.');
      }
      return { ...site, enabled: true };
    },
    async setSource(target, source) {
      const repo = repositoryTarget(target);
      const wanted =
        source?.build_type === 'workflow'
          ? pagesSource({ actions: true })
          : pagesSource({
              branch: `${source?.source?.branch ?? ''}:${source?.source?.path ?? '/'}`,
            });
      const before = await manager.status(repo);
      if (matches(before, wanted)) {
        return { ...before, changed: false, verifiedBy: 'api' };
      }
      await rest.request(`${repoPath(repo)}/pages`, {
        method: before.enabled ? 'PUT' : 'POST',
        body: wanted,
      });
      const { accepted, value } = await pollUntil({
        read: () => manager.status(repo),
        accept: (site) => matches(site, wanted),
        timeout: verificationTimeout,
        interval: VERIFICATION_INTERVAL_MS,
      });
      if (!accepted) {
        throw new CliError(
          'GitHub did not confirm the requested Pages source.',
          EXIT_CODES.VERIFICATION_FAILED
        );
      }
      return { ...value, changed: true, verifiedBy: 'api' };
    },
  };
  return manager;
}
