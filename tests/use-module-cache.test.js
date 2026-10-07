import { describe, it, expect } from 'test-anywhere';
import { loadUse } from '../scripts/use-module.mjs';

describe('use-m cache URL isolation', () => {
  it('fetches each requested URL and reuses only that URL’s cached loader', async () => {
    const url = (label) =>
      `data:text/javascript,${encodeURIComponent(`({ use: Object.assign(async () => ({}), { label: '${label}' }) })`)}`;
    const first = await loadUse({
      url: url('first'),
      attempts: 1,
      timeoutMs: 1000,
    });
    expect(first.label).toBe('first');
    const second = await loadUse({
      url: url('second'),
      attempts: 1,
      timeoutMs: 1000,
    });
    expect(second.label).toBe('second');
    expect(await loadUse({ url: url('first') })).toBe(first);
  });
});
