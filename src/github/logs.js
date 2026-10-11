import { CliError, EXIT_CODES } from '../exit-codes.js';

/** Use only the API path; a signed download URL can contain credentials. */
export function unavailableLogs(httpStatus, path) {
  if (httpStatus !== 404 && httpStatus !== 410) {
    return null;
  }
  return {
    status: httpStatus === 410 ? 'logs-expired' : 'logs-unavailable',
    httpStatus,
    path,
  };
}

export function validateRetentionDays(days) {
  if (!Number.isFinite(days) || days <= 0) {
    throw new CliError('Retention days must be positive.', EXIT_CODES.USAGE);
  }
}

/** updated_at accounts for a recent rerun of an older run. */
export function expiredRun(run, retentionDays, now) {
  const timestamp = Date.parse(run.updated_at ?? run.created_at);
  return (
    Number.isFinite(timestamp) && timestamp < now() - retentionDays * 86400000
  );
}
