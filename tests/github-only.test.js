import { describe, it, expect } from 'test-anywhere';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.(js|ts)$/.test(path)
        ? [path]
        : [];
  });
}

describe('GitHub-only runtime boundary', () => {
  it('has no external publishing ecosystems or built-in credential policy', () => {
    const forbidden =
      /\b(?:npm|pypi|crates(?:\.io)?|rubygems|nuget|jsr)\b|TRUSTED_PUBLISHING_SECRETS|requireStoredToken|publishingPolicy/i;
    const violations = sources('src').filter((file) => {
      const source = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,
        ''
      );
      return forbidden.test(source);
    });
    expect(violations).toEqual([]);
  });
});
