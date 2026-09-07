/**
 * A cache of the organization settings that gate package operations.
 *
 * Reading these settings costs a browser navigation, and they change rarely —
 * usually never, and when they do it is because this tool changed them. Making
 * a package public therefore opened the organization settings page every time
 * only to be told the same thing it was told the run before.
 *
 * The cache is written in links notation, which is what the rest of the
 * foundation uses for small structured records, and lives in the application
 * directory beside the profile and the logs:
 *
 *   ~/.gh-manager/
 *   └── org-settings/
 *       └── <org>.lino
 *
 * A cached entry is a hint, never an authority. It answers "is this operation
 * worth attempting" so a run can skip a navigation it does not need; it never
 * decides that an operation succeeded. The page and the API remain the only
 * things that confirm a change, so a stale entry costs one wasted attempt
 * rather than a wrong answer.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Parser } from 'links-notation';

/** How long a cached entry is trusted before it is read again. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** The container visibilities an organization can allow. */
const VISIBILITIES = ['public', 'private', 'internal'];

/**
 * Resolve the directory holding the cached settings.
 * @param {string} appDir - Application directory
 * @returns {string} Cache directory
 */
export function cacheDir(appDir) {
  return path.join(appDir, 'org-settings');
}

/**
 * Resolve the cache file of one organization.
 * @param {string} appDir - Application directory
 * @param {string} org - Organization login
 * @returns {string} Cache file path
 */
export function cacheFile(appDir, org) {
  return path.join(cacheDir(appDir), `${org}.lino`);
}

/**
 * Read the single value of a link, when it has exactly one.
 * @param {Object} link - Parsed link
 * @returns {string|null} The value's id, or null
 */
function soleValue(link) {
  return link?.values?.length === 1 ? link.values[0].id : null;
}

/**
 * Find a link by id among a list.
 * @param {Array<Object>} links - Parsed links
 * @param {string} id - Link id
 * @returns {Object|null} The matching link, or null
 */
function byId(links, id) {
  return links.find((link) => link.id === id) ?? null;
}

/**
 * Find the group a bare name introduces, and return the rest of its members.
 *
 * `(packages (containers ...))` parses as an unnamed link whose first value is
 * the name and whose remaining values are the members, rather than as a link
 * whose id is the name. Only `(name: value)` puts the name in `id`, so a group
 * has to be located by its first value.
 * @param {Array<Object>} links - Parsed links to search
 * @param {string} name - Group name
 * @returns {Array<Object>} The group's members, empty when it is absent
 */
function groupMembers(links, name) {
  for (const link of links) {
    if (link.id === null && link.values?.[0]?.id === name) {
      return link.values.slice(1);
    }

    if (link.id === name) {
      return link.values ?? [];
    }
  }

  return [];
}

/**
 * Turn cached settings into links notation.
 *
 * Timestamps are stored as epoch seconds because `:` is a delimiter in links
 * notation, so an ISO 8601 string cannot be written as a bare value.
 * @param {Object} entry - Cache entry
 * @param {string} entry.org - Organization login
 * @param {number} entry.fetchedAt - Epoch seconds when the settings were read
 * @param {Object} entry.containers - Allowed visibilities, keyed by name
 * @returns {string} Links notation document
 */
export function formatSettings({ org, fetchedAt, containers }) {
  const allowed = VISIBILITIES.map(
    (name) => `(${name}: ${Boolean(containers[name])})`
  ).join(' ');

  return `${[
    `(org: ${org})`,
    `(fetchedAt: ${Math.floor(fetchedAt)})`,
    `(packages (containers ${allowed}))`,
  ].join('\n')}\n`;
}

/**
 * Parse cached settings from links notation.
 * @param {string} source - Links notation document
 * @returns {{org: string|null, fetchedAt: number|null, containers: Object}} Cache entry
 */
export function parseSettings(source) {
  const links = new Parser().parse(source);
  const containersMembers = groupMembers(
    groupMembers(links, 'packages'),
    'containers'
  );
  const containers = {};

  for (const name of VISIBILITIES) {
    const value = soleValue(byId(containersMembers, name));
    if (value !== null) {
      containers[name] = value === 'true';
    }
  }

  const fetchedAt = Number(soleValue(byId(links, 'fetchedAt')));

  return {
    org: soleValue(byId(links, 'org')),
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    containers,
  };
}

/**
 * Create the cache bound to an application directory.
 * @param {Object} options - Cache options
 * @param {string} options.appDir - Application directory
 * @param {Object} options.log - Logger
 * @param {number} [options.ttlSeconds] - How long an entry is trusted
 * @param {() => number} [options.now] - Clock, in epoch seconds
 * @returns {Object} Cache
 */
export function createOrgSettingsCache({
  appDir,
  log,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = () => Date.now() / 1000,
}) {
  return {
    /**
     * Read the cached settings of an organization.
     *
     * A missing, unreadable, or expired entry is a miss rather than an error:
     * the caller reads the page instead, which is what it would have done
     * without a cache at all.
     * @param {string} org - Organization login
     * @returns {{containers: Object, fetchedAt: number}|null} Entry, or null on a miss
     */
    read(org) {
      let source;

      try {
        source = readFileSync(cacheFile(appDir, org), 'utf8');
      } catch {
        return null;
      }

      let entry;

      try {
        entry = parseSettings(source);
      } catch (error) {
        log.debug(
          `ignoring unreadable settings cache for ${org}: ${error.message}`
        );
        return null;
      }

      if (entry.fetchedAt === null) {
        return null;
      }

      const age = now() - entry.fetchedAt;

      if (age > ttlSeconds) {
        log.debug(
          `settings cache for ${org} is ${Math.round(age)}s old; re-reading`
        );
        return null;
      }

      return { containers: entry.containers, fetchedAt: entry.fetchedAt };
    },

    /**
     * Store the settings of an organization.
     * @param {string} org - Organization login
     * @param {Object} containers - Allowed container visibilities
     * @returns {void}
     */
    write(org, containers) {
      mkdirSync(cacheDir(appDir), { recursive: true });
      writeFileSync(
        cacheFile(appDir, org),
        formatSettings({ org, fetchedAt: now(), containers }),
        'utf8'
      );
    },

    /**
     * Forget the cached settings of an organization.
     *
     * Called after the tool changes a setting, so the next read reflects what
     * the tool just did rather than what it saw before.
     * @param {string} org - Organization login
     * @returns {void}
     */
    invalidate(org) {
      try {
        writeFileSync(cacheFile(appDir, org), '', 'utf8');
      } catch {
        // Nothing cached, so nothing to forget.
      }
    },
  };
}
