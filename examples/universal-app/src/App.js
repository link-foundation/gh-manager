import { createElement as h, useMemo, useState } from 'react';
import { isOverBroadPattern, matchPackageNames } from '../../../src/index.js';

const repositoryUrl =
  import.meta.env.VITE_REPOSITORY_URL ??
  'https://github.com/link-foundation/gh-manager';

const desktopTargets = [
  {
    label: 'Windows',
    detail: 'Installer or portable package from the latest desktop build.',
  },
  {
    label: 'macOS',
    detail: 'Signed archive when Apple credentials are configured.',
  },
  {
    label: 'Linux',
    detail: 'Zip, deb, or rpm output from Electron Forge.',
  },
];

function parseNames(value) {
  return value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function selectPackages(packageNames, pattern, regex) {
  try {
    return {
      matched: matchPackageNames(packageNames, { pattern, regex }),
      overBroad: isOverBroadPattern({ pattern, regex }),
      error: null,
    };
  } catch (error) {
    return { matched: [], overBroad: false, error: error.message };
  }
}

function TextField({ id, label, value, onChange }) {
  return h(
    'label',
    { className: 'pattern-field', htmlFor: id },
    h('span', null, label),
    h('input', {
      id,
      type: 'text',
      spellCheck: false,
      value,
      onChange: (event) => onChange(event.target.value),
    })
  );
}

function ResultTile({ label, value, tone }) {
  return h(
    'div',
    { className: `result-tile result-tile-${tone}` },
    h('span', { className: 'result-label' }, label),
    h('strong', null, String(value))
  );
}

function MatchRow({ name, matched }) {
  return h(
    'li',
    { className: matched ? 'match-hit' : 'match-miss' },
    h('span', null, name),
    h('small', null, matched ? 'selected' : 'skipped')
  );
}

function DownloadTarget({ label, detail }) {
  return h('li', null, h('span', null, label), h('small', null, detail));
}

export function App() {
  const [pattern, setPattern] = useState('box*');
  const [names, setNames] = useState('box, box-dind, gh-manager, deep-index');
  const [regex, setRegex] = useState(false);
  const packageNames = useMemo(() => parseNames(names), [names]);
  const selection = useMemo(
    () => selectPackages(packageNames, pattern, regex),
    [packageNames, pattern, regex]
  );
  const matched = new Set(selection.matched);

  return h(
    'main',
    { className: 'app-shell' },
    h(
      'section',
      { className: 'workspace', 'aria-labelledby': 'matcher-title' },
      h(
        'div',
        { className: 'matcher-panel' },
        h('p', { className: 'eyebrow' }, 'Package function UI'),
        h('h1', { id: 'matcher-title' }, 'Which packages match?'),
        h(
          'div',
          { className: 'input-grid' },
          h(TextField, {
            id: 'pattern-input',
            label: 'Pattern (--pattern)',
            value: pattern,
            onChange: setPattern,
          }),
          h(TextField, {
            id: 'names-input',
            label: 'Known package names',
            value: names,
            onChange: setNames,
          })
        ),
        h(
          'label',
          { className: 'mode-toggle', htmlFor: 'regex-toggle' },
          h('input', {
            id: 'regex-toggle',
            type: 'checkbox',
            checked: regex,
            onChange: (event) => setRegex(event.target.checked),
          }),
          h('span', null, 'Read the pattern as a regular expression (--regex)')
        ),
        h(
          'div',
          { className: 'results-grid', 'aria-live': 'polite' },
          h(ResultTile, {
            label: 'Matched',
            value: selection.matched.length,
            tone: 'green',
          }),
          h(ResultTile, {
            label: 'Skipped',
            value: packageNames.length - selection.matched.length,
            tone: 'blue',
          })
        ),
        selection.error
          ? h('p', { className: 'notice notice-error' }, selection.error)
          : null,
        selection.overBroad
          ? h(
              'p',
              { className: 'notice' },
              'This pattern selects every package, so gh-manager refuses it unless you pass --all.'
            )
          : null,
        h(
          'ul',
          { className: 'match-list' },
          packageNames.map((name) =>
            h(MatchRow, { key: name, name, matched: matched.has(name) })
          )
        )
      ),
      h(
        'aside',
        { className: 'distribution-panel', 'aria-labelledby': 'desktop-title' },
        h('h2', { id: 'desktop-title' }, 'Desktop builds'),
        h(
          'p',
          null,
          'The same React bundle is used by GitHub Pages, Electron, Android, and iOS.'
        ),
        h(
          'ul',
          { className: 'target-list' },
          desktopTargets.map((target) =>
            h(DownloadTarget, { key: target.label, ...target })
          )
        ),
        h(
          'a',
          {
            className: 'download-link',
            href: `${repositoryUrl}/releases/latest`,
            target: '_blank',
            rel: 'noreferrer',
          },
          'Open desktop downloads'
        )
      )
    )
  );
}
