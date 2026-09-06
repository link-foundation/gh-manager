import { describe, it, expect } from 'test-anywhere';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const exampleRoot = 'examples/universal-app';
const packageJsonPath = `${exampleRoot}/package.json`;
const appSourcePath = `${exampleRoot}/src/App.js`;
const viteConfigPath = `${exampleRoot}/vite.config.js`;
const capacitorConfigPath = `${exampleRoot}/capacitor.config.json`;
const workflowPath = '.github/workflows/example-app.yml';
const docsPath = `${exampleRoot}/README.md`;

function readText(filePath) {
  return readFileSync(filePath, 'utf8').replaceAll('\r\n', '\n');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

describe('universal React example app', () => {
  it('defines the expected app package and build targets', () => {
    expect(existsSync(packageJsonPath)).toBe(true);

    const packageJson = readJson(packageJsonPath);

    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe('module');
    expect(packageJson.main).toBe('electron/main.cjs');
    expect(Boolean(packageJson.dependencies.react)).toBe(true);
    expect(Boolean(packageJson.dependencies['react-dom'])).toBe(true);
    expect(Boolean(packageJson.dependencies['@capacitor/core'])).toBe(true);
    expect(Boolean(packageJson.devDependencies.vite)).toBe(true);
    expect(Boolean(packageJson.devDependencies.electron)).toBe(true);
    expect(Boolean(packageJson.devDependencies['electron-builder'])).toBe(true);
    expect(Boolean(packageJson.devDependencies['@capacitor/cli'])).toBe(true);

    expect(packageJson.scripts.build).toBe('vite build');
    expect(packageJson.scripts['desktop:package']).toContain(
      'electron-builder --dir'
    );
    expect(packageJson.scripts['mobile:sync']).toContain('cap sync');
    expect(packageJson.scripts['mobile:android:build']).toContain(
      'cap build android'
    );
    expect(packageJson.scripts['mobile:ios:run']).toContain('cap run ios');
  });

  it('renders a visual UI using the package pattern matcher', () => {
    const appSource = readText(appSourcePath);

    expect(appSource).toContain("from '../../../src/patterns.js'");
    expect(appSource).toContain(
      'matchPackageNames(packageNames, { pattern, regex })'
    );
    expect(appSource).toContain('isOverBroadPattern({ pattern, regex })');
    expect(appSource).toContain('Matched');
    expect(appSource).toContain('Skipped');
  });

  it('imports only modules a bundler can resolve for the browser', () => {
    const appSource = readText(appSourcePath);
    const entry = appSource.match(/from '(\.\.\/\.\.\/\.\.\/src\/[^']+)'/);

    expect(Boolean(entry)).toBe(true);

    const unbundlable = [];
    const seen = new Set();
    const queue = [entry[1].replace('../../../', '')];

    while (queue.length > 0) {
      const modulePath = queue.pop();

      if (seen.has(modulePath)) {
        continue;
      }

      seen.add(modulePath);
      const source = readText(modulePath);

      for (const [, specifier] of source.matchAll(
        /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
      )) {
        if (specifier.startsWith('.')) {
          queue.push(resolvePath(dirname(modulePath), specifier));
        } else {
          unbundlable.push(`${modulePath} -> ${specifier}`);
        }
      }
    }

    expect(unbundlable).toEqual([]);
  });

  it('shares the Vite build output with Capacitor and GitHub Pages', () => {
    const viteConfig = readText(viteConfigPath);
    const capacitorConfig = readJson(capacitorConfigPath);

    expect(viteConfig).toContain('GITHUB_PAGES');
    expect(viteConfig).toContain('base: resolveBasePath()');
    expect(viteConfig).toContain("outDir: 'dist'");
    expect(capacitorConfig.webDir).toBe('dist');
    expect(capacitorConfig.appId).toBe('foundation.link.template.example');
  });

  it('adds root scripts and a workflow for web, desktop, and mobile checks', () => {
    const rootPackageJson = readJson('package.json');
    const workflow = readText(workflowPath);

    expect(rootPackageJson.scripts['example:web:build']).toBe(
      'npm --prefix examples/universal-app run build'
    );
    expect(rootPackageJson.scripts['example:desktop:package']).toBe(
      'npm --prefix examples/universal-app run desktop:package'
    );
    expect(rootPackageJson.scripts['example:mobile:sync']).toBe(
      'npm --prefix examples/universal-app run mobile:sync'
    );

    expect(workflow).toContain(
      'npm ci --prefix examples/universal-app --no-audit --no-fund'
    );
    expect(workflow).toContain('npm run example:web:build');
    expect(workflow).toContain('npm run example:desktop:package');
    expect(workflow).toContain('actions/configure-pages@v6');
    expect(workflow).toContain('actions/upload-pages-artifact');
    expect(workflow).toContain('actions/deploy-pages');
    expect(workflow).toContain('EXAMPLE_APP_ENABLE_ANDROID_BUILD');
    expect(workflow).toContain('EXAMPLE_APP_ENABLE_IOS_BUILD');
  });

  it('documents local validation without store credentials', () => {
    const docs = readText(docsPath);

    expect(docs).toContain('npm install --prefix examples/universal-app');
    expect(docs).toContain('npm run example:web:build');
    expect(docs).toContain('npm run example:desktop:package');
    expect(docs).toContain('npm run example:mobile:sync');
    expect(docs).toContain('Apple Developer Program');
    expect(docs).toContain('Google Play Console');
  });

  it('regenerates preview screenshots with browser-commander on every push to main', () => {
    const rootPackageJson = readJson('package.json');
    const workflow = readText(workflowPath);
    const script = readText('scripts/update-preview-images.mjs');
    const rootReadme = readText('README.md');

    expect(rootPackageJson.scripts['example:web:preview-images']).toBe(
      'node scripts/update-preview-images.mjs'
    );
    expect(existsSync('scripts/update-preview-images.mjs')).toBe(true);

    expect(workflow).toContain('preview-regen:');
    expect(workflow).toContain(
      'image: mcr.microsoft.com/playwright:v1.59.1-noble'
    );
    expect(workflow).toContain('browser-commander');
    expect(workflow).not.toContain('npx playwright install');
    expect(workflow).toContain('node scripts/update-preview-images.mjs');
    expect(workflow).toContain('[skip ci]');

    expect(script).toContain("from 'browser-commander'");
    expect(script).toContain("from 'playwright'");
    expect(script).toContain('docs/screenshots/example-app');

    expect(rootReadme).toContain('Auto-regenerated preview screenshots');
    expect(rootReadme).toContain('npm run example:web:preview-images');
  });
});
