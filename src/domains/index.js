/**
 * The command registry.
 *
 * A domain is a plain object — `{ name, summary, usage, verbs }` — so adding a
 * new area of GitHub management means writing one module and listing it here,
 * or passing it to `runCli` as an extra domain. Nothing else in the CLI needs
 * to know the domain exists.
 */

import { authDomain } from './auth.js';
import { configDomain } from './config.js';
import { packageDomain } from './package.js';
import { permissionsDomain } from './permissions.js';
import { securityDomain } from './security.js';
import { secretDomain } from './secret.js';
import { protectDomain } from './protect.js';
import { repoDomain, runsDomain } from './discovery.js';

/** Domains that ship with gh-manager. */
export const DOMAINS = [
  authDomain,
  packageDomain,
  permissionsDomain,
  securityDomain,
  secretDomain,
  protectDomain,
  repoDomain,
  runsDomain,
  configDomain,
];

/**
 * Find a domain by name.
 * @param {Array<Object>} domains - Registered domains
 * @param {string} name - Name from the command line
 * @returns {Object|undefined} The domain, when it exists
 */
export function findDomain(domains, name) {
  return domains.find((domain) => domain.name === name);
}

export {
  authDomain,
  configDomain,
  packageDomain,
  permissionsDomain,
  securityDomain,
  secretDomain,
  protectDomain,
  repoDomain,
  runsDomain,
};
