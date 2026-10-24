/** Only settings failures are actionable; unavailable logs remain scan errors. */
export const LOG_RULES = [
  {
    pattern:
      /dependency graph (?:is |has been )?(?:disabled|not enabled)|dependency review is not supported on this repository/i,
    setting: 'dependency-graph',
    required: 'enabled',
  },
  {
    pattern: /get pages site failed|ensure github pages has been enabled/i,
    setting: 'pages',
    required: 'workflow',
  },
  {
    pattern:
      /codeql analyses from advanced configurations cannot be processed when the default setup is enabled/i,
    setting: 'code-scanning-default-setup',
    required: 'disabled',
  },
  {
    pattern: /code scanning is not enabled for this repository/i,
    setting: 'code-scanning',
    required: 'enabled',
  },
];
export function logRequirements(failure) {
  return (failure.matches ?? []).flatMap((match) =>
    LOG_RULES.filter((rule) => rule.pattern.test(match.text)).map((rule) => ({
      setting: rule.setting,
      required: rule.required,
      evidence: {
        kind: 'log',
        runId: failure.runId,
        runUrl: failure.runUrl,
        jobId: match.jobId,
        job: match.job,
        line: match.line,
        text: match.text,
      },
    }))
  );
}
