/**
 * Declarative package permissions.
 *
 * `gh-manager permissions sync --from policy.json` converges the access lists
 * of a set of packages towards a file, so the intended permissions live in the
 * repository, not in someone's memory. The parsing and the diffing are
 * pure functions: they are the part that decides what will be revoked, and that
 * decision is worth testing without a browser.
 *
 * Expected shape:
 *
 *   {
 *     "packages": [
 *       {
 *         "pattern": "box*",
 *         "exclusive": true,
 *         "teams": { "maintainers": "write" },
 *         "users": { "konard": "admin" }
 *       }
 *     ]
 *   }
 */

import { ROLES } from '../browser/selectors.js';
import { CliError, EXIT_CODES } from '../exit-codes.js';

/**
 * Fail with a usage error that names the offending part of the policy.
 * @param {string} message - What is wrong
 * @returns {never} Always throws
 */
function invalid(message) {
  throw new CliError(`Invalid policy file: ${message}`, EXIT_CODES.USAGE);
}

/**
 * Validate a role name.
 * @param {string} role - Role from the policy
 * @param {string} where - Location used in the error message
 * @returns {string} The role, lowercased
 */
export function validateRole(role, where) {
  const value = String(role ?? '').toLowerCase();

  if (!ROLES.includes(value)) {
    throw new CliError(
      `${where} must be one of ${ROLES.join(', ')}; got "${role}"`,
      EXIT_CODES.USAGE
    );
  }

  return value;
}

/**
 * Turn a `{ name: role }` map into grantee descriptors.
 * @param {Object} map - Map of names to roles
 * @param {string} type - 'team' or 'user'
 * @returns {Array<{type: string, name: string, role: string}>} Grantees
 */
function granteesFromMap(map, type) {
  if (map === undefined) {
    return [];
  }

  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    invalid(`"${type}s" must be an object mapping names to roles`);
  }

  return Object.entries(map).map(([name, role]) => ({
    type,
    name,
    role: validateRole(role, `Policy: role of ${type} "${name}"`),
  }));
}

/**
 * Read one entry of the policy.
 * @param {Object} entry - Raw entry
 * @param {number} index - Position in the file, for error messages
 * @returns {Object} Normalized entry
 */
function parseEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    invalid(`packages[${index}] must be an object`);
  }

  const names = entry.names ?? (entry.name ? [entry.name] : []);

  if (!Array.isArray(names)) {
    invalid(`packages[${index}].names must be an array`);
  }

  if (names.length === 0 && !entry.pattern) {
    invalid(`packages[${index}] needs "name", "names", or "pattern"`);
  }

  return {
    names,
    pattern: entry.pattern ?? null,
    regex: Boolean(entry.regex),
    // Sync means "make it look like this", so anyone not listed loses access
    // unless the entry opts out of that.
    exclusive: entry.exclusive !== false,
    grantees: [
      ...granteesFromMap(entry.teams, 'team'),
      ...granteesFromMap(entry.users, 'user'),
    ],
  };
}

/**
 * Parse a policy document.
 * @param {any} document - Parsed JSON
 * @returns {{entries: Array<Object>}} Normalized policy
 */
export function parsePolicy(document) {
  if (!document || typeof document !== 'object') {
    invalid('the file must contain a JSON object');
  }

  if (!Array.isArray(document.packages)) {
    invalid('"packages" must be an array');
  }

  return { entries: document.packages.map(parseEntry) };
}

/**
 * Diff the access a package has against the access a policy entry wants.
 * @param {Object} options - Diff options
 * @param {string} options.packageName - Package the rows belong to
 * @param {Array<{type: string, name: string, role: string}>} options.current - Current rows
 * @param {Array<{type: string, name: string, role: string}>} options.desired - Wanted access
 * @param {boolean} [options.exclusive] - Revoke grantees the policy omits
 * @returns {Array<Object>} Operations to apply
 */
export function diffAccess({
  packageName,
  current,
  desired,
  exclusive = true,
}) {
  const key = (grantee) => `${grantee.type}:${grantee.name.toLowerCase()}`;
  const currentByKey = new Map(current.map((row) => [key(row), row]));
  const desiredKeys = new Set(desired.map(key));
  const operations = [];

  for (const grantee of desired) {
    const existing = currentByKey.get(key(grantee));

    if (existing?.role !== grantee.role) {
      operations.push({
        kind: 'grant',
        packageName,
        grantee: { type: grantee.type, name: grantee.name },
        role: grantee.role,
      });
    }
  }

  if (!exclusive) {
    return operations;
  }

  for (const row of current) {
    if (!desiredKeys.has(key(row))) {
      operations.push({
        kind: 'revoke',
        packageName,
        grantee: { type: row.type, name: row.name },
        role: null,
      });
    }
  }

  return operations;
}

/**
 * Describe one operation for the confirmation prompt and the run output.
 * @param {Object} operation - Operation from diffAccess
 * @returns {string} Human readable line
 */
export function describeOperation({ kind, packageName, grantee, role }) {
  const who = `${grantee.type} ${grantee.name}`;

  return kind === 'grant'
    ? `${packageName}: grant ${role} to ${who}`
    : `${packageName}: revoke access from ${who}`;
}
