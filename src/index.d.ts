/**
 * Type definitions for the gh-manager library surface.
 *
 * The CLI is one consumer of these modules; a release script can import them
 * directly when it already knows which packages it publishes.
 */

/** Owner of a set of packages. */
export interface PackageOwner {
  /** 'orgs' for organizations, 'users' for personal accounts. */
  scope: 'orgs' | 'users';
  /** Organization name or account login. */
  name: string;
}

/** Effective settings, after config.json, the environment, and flags. */
export interface Settings extends AppPaths {
  org: string | null;
  account: string | null;
  engine: string;
  channel: string;
  headless: boolean;
  packageType: string;
  [key: string]: unknown;
}

/** Paths inside the application directory. */
export interface AppPaths {
  appDir: string;
  configFile: string;
  profileDir: string;
  logsDir: string;
}

/** A team or user a package permission applies to. */
export interface Grantee {
  type: 'team' | 'user';
  name: string;
}

/** One access row of a package. */
export interface AccessEntry extends Grantee {
  role: Role;
}

/** Package permission roles, in increasing order of power. */
export type Role = 'read' | 'write' | 'admin';

/** Package visibilities gh-manager can set. */
export type Visibility = 'public' | 'private' | 'internal';

/** A single grant or revoke, as produced by diffAccess. */
export interface AccessOperation {
  kind: 'grant' | 'revoke';
  packageName: string;
  grantee: Grantee;
  role: Role | null;
}

/** One normalized entry of a policy file. */
export interface PolicyEntry {
  names: string[];
  pattern: string | null;
  regex: boolean;
  exclusive: boolean;
  grantees: AccessEntry[];
}

/** A parsed policy file. */
export interface Policy {
  entries: PolicyEntry[];
}

/** Options shared by the pattern helpers. */
export interface MatchOptions {
  /** Glob by default, regular expression with `regex: true`. */
  pattern: string;
  regex?: boolean;
}

/** Options accepted by resolveTargets. */
export interface ResolveTargetsOptions extends Partial<MatchOptions> {
  /** Names given explicitly; they win over a pattern. */
  targets?: string[];
  /** Allow a pattern that selects everything. */
  all?: boolean;
  /** Lazy enumeration of the packages that exist. */
  listNames: () => Promise<string[]>;
}

/** The packages a command should act on. */
export interface ResolvedTargets {
  names: string[];
  fromPattern: boolean;
  known: string[];
}

/** Options accepted by runCli. */
export interface RunCliOptions {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  env?: Record<string, string | undefined>;
  home?: string;
  domains?: CommandDomain[];
  deps?: Record<string, unknown>;
}

/** One verb of a command domain. */
export interface CommandVerb {
  summary: string;
  run: (context: unknown) => number | Promise<number>;
}

/** A pluggable area of GitHub management. */
export interface CommandDomain {
  name: string;
  summary: string;
  usage: string[];
  verbs: Record<string, CommandVerb>;
  /** Words this domain forwards to another domain, keyed by word. */
  nested?: Record<string, string>;
}

/** Result of setting a package visibility. */
export interface VisibilityResult {
  packageName: string;
  visibility: Visibility;
  changed: boolean;
  verified: boolean;
  /** Whether the API or the page confirmed the change. */
  verifiedBy: 'api' | 'page';
  reported: string | null;
}

/** Result of deleting a package. */
export interface DeleteResult {
  packageName: string;
  deleted: boolean;
  verified: boolean;
  /** Whether the API or the page confirmed the deletion. */
  verifiedBy: 'api' | 'page';
}

/** Reads and writes for the packages of one owner. */
export interface PackageGateway {
  listPackages: () => Promise<{
    packages: Array<Record<string, unknown>>;
    source: 'api' | 'browser';
  }>;
  listNames: () => Promise<string[]>;
  readVisibility: (packageName: string) => Promise<string | null>;
  setVisibility: (options: {
    packageName: string;
    visibility: Visibility;
  }) => Promise<VisibilityResult>;
  deletePackage: (options: { packageName: string }) => Promise<DeleteResult>;
}

/** A browser session bound to the persistent gh-manager profile. */
export interface BrowserSession {
  commander: Record<string, unknown>;
  connection: Record<string, unknown>;
  page: unknown;
  capture: (label: string) => Promise<string[]>;
  close: () => Promise<void>;
}

/** Stable exit codes, so a pipeline can branch instead of parsing output. */
export declare const EXIT_CODES: {
  readonly SUCCESS: 0;
  readonly FAILURE: 1;
  readonly USAGE: 2;
  readonly AUTH: 3;
  readonly NO_MATCHES: 4;
  readonly ABORTED: 5;
  readonly VERIFICATION_FAILED: 6;
};

/** Error carrying an explicit exit code. */
export declare class CliError extends Error {
  constructor(message: string, exitCode?: number, options?: ErrorOptions);
  exitCode: number;
}

/** Read the exit code carried by an error. */
export declare const exitCodeForError: (error: unknown) => number;

/** Run one gh-manager command line and resolve with its exit code. */
export declare const runCli: (
  argv: string[],
  options?: RunCliOptions
) => Promise<number>;

/** Parse an argument vector into positionals and flags. */
export declare const parseArgs: (argv: string[]) => {
  positionals: string[];
  flags: Record<string, unknown>;
};

/** Declarations of every flag the CLI accepts. */
export declare const FLAG_SPECS: Record<string, Record<string, unknown>>;

/** The domains that ship with gh-manager. */
export declare const DOMAINS: CommandDomain[];

/** Find a domain by name. */
export declare const findDomain: (
  domains: CommandDomain[],
  name: string
) => CommandDomain | undefined;

/** Built-in configuration defaults. */
export declare const DEFAULT_CONFIG: Record<string, string | boolean | null>;

/** Keys `gh-manager config` accepts. */
export declare const CONFIGURABLE_KEYS: string[];

/** Paths inside an application directory. */
export declare const appPaths: (appDir: string) => AppPaths;

/** Create the application directory and its subdirectories. */
export declare const ensureAppDir: (appDir: string) => AppPaths;

/** Read config.json, tolerating a missing or unreadable file. */
export declare const loadStoredConfig: (
  appDir: string
) => Record<string, unknown>;

/** Resolve the application directory from --app-dir, environment, and home. */
export declare const resolveAppDir: (options?: {
  appDir?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}) => string;

/** Resolve the owner every package request is made against. */
export declare const resolveOwner: (settings: Settings) => PackageOwner;

/** Merge defaults, config.json, environment, and flags. */
export declare const resolveSettings: (options?: {
  flags?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  home?: string;
}) => Settings;

/** Merge values into config.json. */
export declare const saveStoredConfig: (
  appDir: string,
  values: Record<string, unknown>
) => Record<string, unknown>;

/** Replace config.json with the given values. */
export declare const writeStoredConfig: (
  appDir: string,
  values: Record<string, unknown>
) => Record<string, unknown>;

/** Build a predicate over package names. */
export declare const createMatcher: (
  options: MatchOptions
) => (name: string) => boolean;

/** Convert a glob into an anchored regular expression source. */
export declare const globToRegExpSource: (pattern: string) => string;

/** Report whether a pattern selects everything. */
export declare const isOverBroadPattern: (
  options: Partial<MatchOptions>
) => boolean;

/** Filter package names with a pattern. */
export declare const matchPackageNames: (
  names: string[],
  options: MatchOptions
) => string[];

/** Resolve the package names a command should act on. */
export declare const resolveTargets: (
  options: ResolveTargetsOptions
) => Promise<ResolvedTargets>;

/** Error thrown for a GitHub API response the client cannot use. */
export declare class GitHubApiError extends Error {
  constructor(message: string, details: { status: number; path: string });
  status: number;
  path: string;
}

/** The subset of the GitHub API gh-manager reads. */
export interface RestClient {
  hasToken: boolean;
  request: (
    path: string,
    options?: { allowNotFound?: boolean }
  ) => Promise<unknown>;
  listPackages: (options: {
    owner: PackageOwner;
    packageType: string;
  }) => Promise<Array<Record<string, unknown>>>;
  getPackage: (options: {
    owner: PackageOwner;
    packageType: string;
    packageName: string;
  }) => Promise<Record<string, unknown> | null>;
}

/** Create a minimal GitHub REST client. */
export declare const createRestClient: (options?: {
  token?: string | null;
  fetch?: typeof fetch;
  baseUrl?: string;
}) => RestClient;

/** Find the API token, and say where it came from. */
export declare const resolveToken: (options?: {
  token?: string;
  env?: Record<string, string | undefined>;
  readCliToken?: () => string | null;
}) => { token: string | null; source: string | null };

/** Reads and writes for the packages of one owner. */
export declare const createPackageGateway: (options: {
  owner: PackageOwner;
  packageType: string;
  rest: RestClient;
  log: unknown;
  getSession: () => Promise<BrowserSession>;
  verificationTimeout?: number;
}) => PackageGateway;

/** Describe one operation in a line a human can approve. */
export declare const describeOperation: (operation: AccessOperation) => string;

/** Compare the current access list of a package with the desired one. */
export declare const diffAccess: (options: {
  packageName: string;
  current: AccessEntry[];
  desired: AccessEntry[];
  exclusive?: boolean;
}) => AccessOperation[];

/** Validate and normalize a policy document. */
export declare const parsePolicy: (document: unknown) => Policy;

/** Validate a role name. */
export declare const validateRole: (role: unknown, where: string) => Role;

/** Options accepted by the browser session helpers. */
export interface BrowserSessionOptions {
  settings: Settings;
  log: unknown;
  loadModule?: () => Promise<Record<string, unknown>>;
}

/** Open a browser on the persistent gh-manager profile. */
export declare const openBrowserSession: (
  options: BrowserSessionOptions
) => Promise<BrowserSession>;

/** Open a session, run a callback, and always close the browser. */
export declare const withBrowserSession: <T>(
  options: BrowserSessionOptions,
  callback: (session: BrowserSession) => Promise<T>
) => Promise<T>;

/** Package permission roles. */
export declare const ROLES: readonly Role[];

/** Package visibilities gh-manager can set. */
export declare const VISIBILITIES: readonly Visibility[];
