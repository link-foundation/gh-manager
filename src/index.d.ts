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
  /** A command without an explicit verb dispatches to this verb. */
  defaultVerb?: string;
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

/** A repository, as gh-manager names one. */
export interface Repository {
  owner: string;
  name: string;
}

/** One "Code security and analysis" setting gh-manager can manage. */
export interface SecurityFeature {
  id: string;
  label: string;
  summary: string;
  headings: string[];
  read: Record<string, unknown> | null;
  write: Record<string, unknown> | null;
  requires?: string;
}

/** What a read of one security setting concluded. */
export interface SecurityStatus {
  id: string;
  label: string;
  state: 'enabled' | 'disabled' | 'unknown';
  /** Which half of GitHub answered: 'none' when neither could. */
  source: 'api' | 'page' | 'none';
  locked?: boolean;
  reason?: string;
  visibility?: string;
  defaultState?: 'enabled' | 'disabled' | 'unknown';
  differsFromDefault?: boolean | null;
}

/** Result of setting one security setting. */
export interface SecurityResult {
  feature: string;
  state: 'enabled' | 'disabled';
  /** False when the setting already had the wanted state. */
  changed: boolean;
  /** What performed the change, null when nothing had to. */
  changedBy: 'api' | 'browser' | null;
  /** What proved the outcome. */
  verifiedBy: 'api' | 'page' | 'none';
}

/** Reads and writes for the security settings of one repository. */
export interface SecurityGateway {
  readFeature: (feature: SecurityFeature) => Promise<SecurityStatus>;
  readAll: () => Promise<SecurityStatus[]>;
  setFeature: (options: {
    feature: SecurityFeature;
    enabled: boolean;
  }) => Promise<SecurityResult>;
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

/** Logs may be expired (410) or absent/deleted (404). No signed URLs are returned. */
export interface UnavailableLogs {
  status: 'logs-expired' | 'logs-unavailable';
  httpStatus: 404 | 410;
  path: string;
}

/** The subset of the GitHub API gh-manager reads. */
export interface RestClient {
  hasToken: boolean;
  request: (
    path: string,
    options?: { allowNotFound?: boolean; method?: string; body?: unknown }
  ) => Promise<unknown>;
  send: (
    path: string,
    options?: { method?: string; body?: unknown }
  ) => Promise<{ status: number; ok: boolean; body: unknown }>;
  text: (path: string) => Promise<string | UnavailableLogs>;
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

/** Reads and writes for the security settings of one repository. */
export declare const createSecurityGateway: (options: {
  repo: Repository;
  rest: RestClient;
  log: unknown;
  getSession: () => Promise<BrowserSession>;
  verificationTimeout?: number;
}) => SecurityGateway;

/** The code security settings gh-manager can read and set. */
export declare const SECURITY_FEATURES: SecurityFeature[];

/** Identifiers of the code security settings, in listing order. */
export declare const SECURITY_FEATURE_IDS: string[];

/** Look up one security setting by the name the command line uses. */
export declare const findSecurityFeature: (id: string) => SecurityFeature;

/** Render a repository as `owner/name`. */
export declare const repoSlug: (repo: Repository) => string;

/** Parse one repository target, `owner/repo` or `repo`. */
export declare const parseRepoSpec: (
  spec: string,
  options: { defaultOwner: () => PackageOwner }
) => Repository;

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

/** Actions secret scopes are explicit; organization filtering is a list option. */
export type SecretScope =
  | { org: string; repo?: never; environment?: never }
  | { org?: never; repo: Repository; environment?: string };

export interface SecretMetadata {
  name: string;
  created_at?: string;
  updated_at?: string;
  visibility?: 'all' | 'private' | 'selected';
  selected_repositories?: { id: number; name: string; full_name: string }[];
}

export interface SecretOptions {
  visibility?: 'all' | 'private' | 'selected';
  repos?: string[];
  reason?: string;
  expiresAt?: string | null;
  dryRun?: boolean;
}

export interface SecretCallbackContext {
  name: string;
  scope: SecretScope;
  /** Existing GitHub values are unreadable. The caller chooses its validation. */
  metadata?: SecretMetadata | null;
  expiresAt?: string | null;
  /** Present only for a new candidate; never returned in results. */
  value?: string;
  reason?: string;
}

export interface SecretEnsureOptions extends SecretOptions {
  /** Disable organization-to-repository fallback explicitly. Default: enabled with repos. */
  fallback?: boolean;
  health?: { status: SecretHealthStatus; expiresAt?: string | null };
  failurePatterns?: string[];
  /** Default: seven days. */
  rotateBeforeMs?: number;
  validate?: (
    context: SecretCallbackContext
  ) =>
    | { valid: boolean; expiresAt?: string }
    | Promise<{ valid: boolean; expiresAt?: string }>;
  acquire?: (
    context: SecretCallbackContext
  ) =>
    | string
    | { value: string; expiresAt?: string }
    | Promise<string | { value: string; expiresAt?: string }>;
  /** Runs only after successful storage and metadata verification. */
  revokePrevious?: (
    context: SecretCallbackContext
  ) => unknown | Promise<unknown>;
}

export interface SecretResult {
  name: string;
  changed?: boolean;
  /** False for access-only updates; safe for callers deciding whether to revoke. */
  valueChanged?: boolean;
  /** GitHub accepted the ciphertext; metadata/access were re-read. Not plaintext validation. */
  verified?: boolean;
  verification?: string;
  reason?: string;
  expiresAt?: string | null;
  dryRun?: boolean;
  operation?: string;
  scope?: SecretScope;
  visibility?: 'all' | 'private' | 'selected';
  repos?: string[];
  path?: 'organization' | 'repository';
  fallbackReason?: string;
  results?: SecretResult[];
}

export interface SecretManager {
  list(options?: { repo?: string }): Promise<SecretMetadata[]>;
  getMetadata(name: string): Promise<SecretMetadata | null>;
  set(
    name: string,
    value: string | undefined,
    options?: SecretOptions
  ): Promise<SecretResult>;
  ensure(name: string, options?: SecretEnsureOptions): Promise<SecretResult>;
  delete(name: string, options?: { dryRun?: boolean }): Promise<SecretResult>;
  cleanup(
    names: string[],
    options: {
      reason: string;
      dryRun?: boolean;
      /** The caller verifies that deletion of these names is appropriate. */
      verify?: (context: {
        names: string[];
        reason: string;
        scope: SecretScope;
        secrets: SecretMetadata[];
      }) => boolean | Promise<boolean>;
    }
  ): Promise<{
    reason: string;
    deleted?: string[];
    names?: string[];
    dryRun?: boolean;
    verified?: boolean;
    requires?: string;
    audit?: SecretAudit | null;
  }>;
}

export declare function createSecretManager(options: {
  rest: RestClient;
  scope: SecretScope;
  log?: { debug: (message: string) => void };
  verificationTimeout?: number;
  now?: () => number;
  /** Recover a denied organization request and return a client using the refreshed login. */
  recoverOrganizationAuth?: () => Promise<RestClient | null>;
}): SecretManager;

export interface SecretAuditReference {
  repository: string;
  workflow: string;
  name: string;
  line: number;
  recommendation: string;
}
export interface SecretAudit {
  references: SecretAuditReference[];
  dynamicReferences: { repository: string; workflow: string }[];
  unreadable: { repository: string; workflow: string }[];
  unused: string[];
  possiblyUnused: string[];
  complete: boolean;
}
export declare function auditWorkflows(options: {
  rest: RestClient;
  repos: Repository[];
  secrets?: SecretMetadata[];
  inventoryComplete?: boolean;
}): Promise<SecretAudit>;
export declare function githubAppPlan(org: string): {
  registration: string;
  permissions: { contents: string; pull_requests: string };
  installation: string;
  credentials: string[];
  workflow: string;
  fallback: string;
};

/** Stable GitHub discovery API, available from the package entry. */
export interface GitHubServiceOptions {
  rest: RestClient;
  log?: {
    debug: (message: string) => void;
    /** Scan progress and summaries; the CLI writes these to stderr. */
    progress?: (message: string) => void;
  };
  now?: () => number;
}
export interface RepositoryInfo {
  id?: number;
  name: string;
  full_name: string;
  default_branch: string;
  archived?: boolean;
  fork?: boolean;
  private?: boolean;
}
export interface RepositoryListOptions {
  org?: string;
  user?: string;
  includeArchived?: boolean;
  includeForks?: boolean;
}
export interface RepositoryFile {
  path: string;
  sha: string;
  content?: string;
}
export interface RepoManager {
  list(options: RepositoryListOptions): Promise<RepositoryInfo[]>;
  /** Open issues across owned repositories; includes forks and archives by default. */
  issues(options: RepositoryListOptions): Promise<RepositoryIssue[]>;
  files(
    repo: Repository | string,
    options: { match: string[]; content?: boolean; ref?: string }
  ): Promise<RepositoryFile[]>;
}
export interface RepositoryIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open';
  html_url: string;
  repository: string;
  [key: string]: unknown;
}
export declare function createRepoManager(
  options: GitHubServiceOptions
): RepoManager;

export interface WorkflowRun {
  id: number;
  workflow_id: number;
  status: string;
  conclusion: string | null;
  run_attempt?: number;
  head_branch: string;
  head_sha?: string;
  path?: string;
  html_url: string;
  created_at?: string;
  updated_at?: string;
  referenced_workflows?: { path: string; sha: string; ref?: string }[];
}
export interface WorkflowStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at?: string;
  completed_at?: string;
}
export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: WorkflowStep[];
}
export interface RunListOptions {
  workflow?: string;
  branch?: string;
  status?: string;
  event?: string;
  limit?: number;
}
export interface LogMatch {
  line: number;
  text: string;
}
export interface RunLogMatch extends LogMatch {
  repository: string;
  runId: number;
  runUrl: string;
  jobId: number;
  job: string;
}
export interface RunFailure {
  repository: string;
  workflow?: string;
  status: 'failure';
  runId: number;
  runUrl: string;
  matches: RunLogMatch[];
}
export interface RunLogsUnavailable extends UnavailableLogs {
  repository: string;
  runId: number;
  runUrl: string;
  url: string;
  jobId?: number;
  job?: string;
}
export interface RunUnknown {
  repository: string;
  workflow?: string;
  status: 'unknown';
  reason:
    | 'logs-expired'
    | 'logs-unavailable'
    | 'repository-error'
    | 'workflow-error';
  runId?: number;
  runUrl?: string;
  matches?: RunLogMatch[];
  unavailableLogs?: RunLogsUnavailable[];
  error?: string;
}
export interface RunFailureScanOptions {
  org: string;
  grep?: string[];
  includeArchived?: boolean;
  includeForks?: boolean;
  /** Skip older log evidence; defaults to 90 days. */
  retentionDays?: number;
}
export interface RunFailureReport {
  matches: RunFailure[];
  /** Counts unavailable job logs, or one count for an unavailable/expired run. */
  unavailableLogs: {
    repository: string;
    reason: 'logs-expired' | 'logs-unavailable';
    count: number;
  }[];
  errors: RunUnknown[];
  repositories: {
    repository: string;
    /** Number of matching log lines. */
    matches: number;
    unavailableLogs: number;
    errors: number;
  }[];
}
export interface RunManager {
  failuresForRepository(
    target: Repository | string,
    options?: { branch?: string; grep?: string[] }
  ): Promise<Array<RunFailure | RunUnknown>>;
  list(
    repo: Repository | string,
    options?: RunListOptions
  ): Promise<WorkflowRun[]>;
  get(repo: Repository | string, id: number): Promise<WorkflowRun>;
  jobs(repo: Repository | string, id: number): Promise<WorkflowJob[]>;
  /** Unfiltered GitHub-masked log text for callers implementing classification. */
  jobLog(
    repo: Repository | string,
    id: number
  ): Promise<string | UnavailableLogs>;
  logs(
    run: number | string,
    options?: {
      repo?: Repository | string;
      grep?: string[];
      failedOnly?: boolean;
    }
  ): Promise<Array<RunLogMatch | RunLogsUnavailable>>;
  /** Detailed results retained for existing library consumers. */
  failures(
    options: RunFailureScanOptions
  ): Promise<Array<RunFailure | RunUnknown>>;
  /** Compact report used by runs failures CLI output. */
  failureReport(options: RunFailureScanOptions): Promise<RunFailureReport>;
}
export declare function createRunManager(
  options: GitHubServiceOptions
): RunManager;

export type SecretHealthStatus =
  | 'ok'
  | 'auth-failing'
  | 'unknown'
  | 'expiring'
  | 'expired';
export interface SecretHealthEvidence {
  repository: string;
  workflow?: string;
  status: SecretHealthStatus;
  reason?: string;
  error?: string;
  runId?: number;
  runUrl?: string;
  jobId?: number;
  job?: string;
  step?: string;
  stepNumber?: number;
  match?: LogMatch;
}
export interface SecretHealthResult {
  name: string;
  status: SecretHealthStatus;
  evidence: SecretHealthEvidence[];
  expiresAt: string | null;
  expiry: {
    status: 'valid' | 'expiring' | 'expired' | 'unknown';
    expiresAt?: string;
    scope?: SecretScope;
    reason?: 'expiry-absent' | 'expiry-invalid' | 'expiry-unreadable';
  };
  warnings: string[];
}
export interface SecretHealthOptions {
  scope: SecretScope;
  repos?: string[];
  branch?: string;
  failurePatterns?: string[];
  /** Skip older log evidence; defaults to 90 days. */
  retentionDays?: number;
  /** Expiry warning window; defaults to seven days. */
  rotateBeforeMs?: number;
  /** Workflow test inputs; durations are milliseconds. */
  inputs?: Record<string, string | boolean | number>;
  timeout?: number;
  interval?: number;
}
export interface SecretHealth {
  health(
    name: string,
    options: SecretHealthOptions
  ): Promise<SecretHealthResult>;
  test(name: string, options: SecretHealthOptions): Promise<SecretHealthResult>;
}
export declare function createSecretHealth(
  options: GitHubServiceOptions & {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }
): SecretHealth;
export {
  createSecretManager as secrets,
  createSecretHealth as health,
  createRepoManager as repos,
  createRunManager as runs,
};

/** Protection always keeps deletion and non-fast-forward rules enabled. */
export interface ProtectionRule {
  type: string;
  parameters?: Record<string, unknown>;
}

export type ProtectionTarget =
  | { org: string; user?: never; repo?: never }
  | { user: string; org?: never; repo?: never }
  | { repo: Repository; org?: never; user?: never };

export interface ProtectionEntry {
  repository?: string;
  repo?: Repository;
  fork?: boolean;
  action: 'create' | 'update' | 'already protected' | 'skipped' | 'failed';
  route?: 'ruleset' | 'classic' | 'organization ruleset';
  reason?: string;
  limitation?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  branches?: Record<string, unknown>[];
  id?: number;
  changed?: boolean;
  verified?: boolean;
  verifiedBranch?: string;
  branchVerification?: string;
  exitCode?: number;
}

export interface ProtectionPlan {
  target: ProtectionTarget;
  policy: { name: string; rules: ProtectionRule[] };
  repositories: ProtectionEntry[];
  organization?: ProtectionEntry;
  fallbackReason?: string;
  dryRun?: boolean;
}

export interface ProtectionOptions {
  name?: string;
  /** Extra rules are additive; the defaults cannot be removed. */
  rules?: ProtectionRule[];
  document?: {
    name?: string;
    rules: ProtectionRule[];
    target?: 'branch';
    enforcement?: 'active';
  };
  dryRun?: boolean;
  /** Required for bulk changes and updates; called again for a revised fallback plan. */
  confirm?: (plan: ProtectionPlan) => boolean | Promise<boolean>;
  /** Called before consent is requested, including fallback plans. */
  onPlan?: (plan: ProtectionPlan) => void | Promise<void>;
}

export interface ProtectionManager {
  plan(
    target: ProtectionTarget,
    options?: ProtectionOptions
  ): Promise<ProtectionPlan>;
  protect(
    target: ProtectionTarget,
    options?: ProtectionOptions
  ): Promise<ProtectionPlan>;
}

export declare function createProtectionManager(options: {
  rest: RestClient;
  log?: { debug: (message: string) => void };
  verificationTimeout?: number;
}): ProtectionManager;

export declare const DEFAULT_PROTECTION_RULES: readonly Readonly<ProtectionRule>[];

export interface PagesSource {
  build_type: 'workflow' | 'legacy';
  source?: { branch: string; path: '/' | '/docs' };
}
export interface PagesStatus {
  enabled: boolean;
  build_type: 'workflow' | 'legacy' | 'disabled';
  source?: { branch: string; path: string } | null;
  changed?: boolean;
  verifiedBy?: 'api';
}
export interface PagesManager {
  status(target: Repository | string): Promise<PagesStatus>;
  setSource(
    target: Repository | string,
    source: PagesSource
  ): Promise<PagesStatus>;
}
export declare function pagesSource(flags: {
  actions?: boolean;
  branch?: string;
}): PagesSource;
export declare function createPagesManager(options: {
  rest: RestClient;
  verificationTimeout?: number;
}): PagesManager;
export interface DoctorEvidence {
  kind: 'file' | 'log';
  file?: string;
  runId?: number;
  runUrl?: string;
  jobId?: number;
  job?: string;
  line: number;
  text: string;
}
export interface DoctorFinding {
  setting: string;
  current: string;
  required: string;
  evidence: DoctorEvidence[];
  fixable: boolean;
  resolved: boolean;
  reason?: string;
  error?: string;
  result?: SecurityResult | PagesStatus;
}
export interface DoctorRepository {
  repository: string;
  findings: DoctorFinding[];
  errors: Array<Record<string, unknown>>;
  reruns: Array<{
    runId: number;
    status: 'requested' | 'skipped';
    reason?: string;
    runUrl?: string;
  }>;
}
export interface DoctorReport {
  repositories: DoctorRepository[];
  dryRun: boolean;
  fix: boolean;
  remaining: number;
  exitCode: number;
}
export interface Doctor {
  scan(
    target: { repo?: Repository | string; org?: string; user?: string },
    options?: {
      fix?: boolean;
      dryRun?: boolean;
      rerun?: boolean;
      includeArchived?: boolean;
      includeForks?: boolean;
      confirm?: (
        plan: Array<DoctorFinding & { repository: string }>
      ) => boolean | Promise<boolean>;
    }
  ): Promise<DoctorReport>;
}
export declare function createDoctor(options: {
  rest: RestClient;
  log?: { debug: (message: string) => void };
  getSession?: () => Promise<BrowserSession>;
  security?: (repo: Repository) => SecurityGateway;
  repos?: RepoManager;
  runs?: RunManager;
  pages?: PagesManager;
}): Doctor;

/** Scope of a non-secret Actions variable. Environment scope requires a repository. */
export type VariableScope =
  | { org: string; repo?: never; environment?: never }
  | { repo: Repository | string; org?: never; environment?: string };
export interface VariableContext {
  repo: Repository | string;
  environment?: string;
}
export interface ActionsVariable {
  name: string;
  value: string;
  scope: VariableScope;
  visibility?: 'selected' | 'all' | 'private';
  selected_repositories?: { id: number; full_name: string; name?: string }[];
  created_at?: string;
  updated_at?: string;
}
export interface EffectiveVariable {
  repo: Repository;
  environment?: string;
  name: string;
  value: string | null;
  scope: VariableScope | null;
  candidates: ActionsVariable[];
  verified: true;
}
export interface VariableEnsureOptions {
  dryRun?: boolean;
  visibility?: 'selected' | 'all' | 'private';
  /** Explicit selected grants are added; existing grants and visibility are preserved. */
  repos?: string[];
  /** Consumer contexts to verify; cannot infer environments the caller has not supplied. */
  contexts?: VariableContext[];
}
export interface VariableEnsureResult {
  kind: 'setting';
  name: string;
  scope: VariableScope;
  changed: boolean;
  wouldChange: boolean;
  dryRun: boolean;
  verified: boolean;
  reason?: string;
  state: ActionsVariable | null;
  effective: EffectiveVariable[];
}
export interface VariableManager {
  list(): Promise<ActionsVariable[]>;
  /** Returns null only after establishing access to the scope inventory. */
  get(name: string): Promise<ActionsVariable | null>;
  effective(
    name: string,
    context?: VariableContext
  ): Promise<EffectiveVariable>;
  ensure(
    name: string,
    value: string,
    options?: VariableEnsureOptions
  ): Promise<VariableEnsureResult>;
  delete(
    name: string,
    options?: { dryRun?: boolean }
  ): Promise<{
    name: string;
    scope: VariableScope;
    changed: boolean;
    wouldChange: boolean;
    dryRun: boolean;
    verified: boolean;
  }>;
}
export declare function createVariableManager(
  options: GitHubServiceOptions & {
    scope: VariableScope;
    verificationTimeout?: number;
  }
): VariableManager;
export { createVariableManager as variables };

/** The caller supplies honest verification evidence; dry runs cannot authorize CI. */
export interface RepairChange {
  kind: 'setting' | 'workflow';
  changed: boolean;
  verified: boolean;
  dryRun?: boolean;
}
export interface RepairVerificationInput {
  repo: Repository | string;
  workflow: string;
  runId: number;
  jobIds: number[];
  changes: RepairChange[];
  /** Required when workflow code changed. The ref must resolve to this new full SHA. */
  revision?: { ref: string; sha: string };
  /** Monitor a run the caller started after verification, e.g. by merging workflow code. */
  newRunId?: number;
  /** New-revision job names if the workflow renamed affected jobs. */
  jobNames?: string[];
  requiredPermissions?: {
    job: string;
    permission: string;
    level: 'read' | 'write' | 'none';
  }[];
  inputs?: Record<string, string>;
  /** Finite wall-clock budget for polling, milliseconds; default 600000. */
  timeout?: number;
  interval?: number;
  dryRun?: boolean;
}
export interface RepairJobEvidence {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  steps?: WorkflowStep[];
}
export interface RepairVerificationResult {
  repository: string;
  workflow: string;
  status:
    | 'success'
    | 'failure'
    | 'timeout'
    | 'verification-failed'
    | 'prerequisite'
    | 'skipped'
    | 'dry-run';
  success: boolean;
  reason?: string;
  runId?: number | null;
  runAttempt?: number | null;
  sha?: string | null;
  conclusion?: string | null;
  runUrl?: string | null;
  jobs?: RepairJobEvidence[];
  prerequisites?: {
    file: string;
    job: string;
    permission: string;
    required: string;
    reason: string;
  }[];
  attempts?: Omit<RepairVerificationResult, 'repository' | 'workflow'>[];
}
export declare function createRepairVerifier(
  options: GitHubServiceOptions & {
    sleep?: (ms: number) => Promise<void> | void;
  }
): {
  verify(input: RepairVerificationInput): Promise<RepairVerificationResult>;
};
