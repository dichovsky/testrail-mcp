import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectDirectory, 'package.json'), 'utf8'));
const npmExecutable = process.env.npm_execpath;
assert.ok(npmExecutable, 'Run this check with npm run test:package.');
assert.equal(packageJson.name, '@dichovsky/testrail-mcp');

// Avoid inheriting a developer's TestRail credentials into any smoke-test process.
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^TESTRAIL/iu.test(name)),
);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'testrail-mcp-package-'));
const installDirectory = join(temporaryDirectory, 'isolated install with spaces');

function runNpm(args, cwd, env = cleanEnvironment) {
  // Invoking npm's JS entry point avoids npm.cmd quoting differences on Windows.
  const result = spawnSync(process.execPath, [npmExecutable, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: args[0] === 'install' ? 180_000 : 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);
    throw new Error(
      `npm ${args[0]} failed (exit ${result.status}, signal ${result.signal ?? 'none'}).\n${diagnostic}`,
    );
  }
  return result;
}

try {
  const packed = JSON.parse(
    runNpm(
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory],
      projectDirectory,
    ).stdout,
  );
  // npm 12 keys the JSON report by package name; npm 10/11 return an array.
  const reports = Array.isArray(packed) ? packed : Object.values(packed);
  assert.equal(reports.length, 1, 'Expected exactly one packed tarball.');
  const [manifest] = reports;
  assert.equal(manifest.name, packageJson.name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(basename(manifest.filename), manifest.filename, 'Unexpected tarball filename.');
  assert.equal(manifest.bundled.length, 0, 'Dependencies must not be bundled in the tarball.');

  const files = new Set(manifest.files.map(({ path }) => path));
  const publicRootFiles = new Set(['package.json', 'README.md', 'LICENSE']);
  for (const path of files) {
    const segments = path.split('/');
    const isBuildArtifact =
      path.startsWith('dist/') &&
      /\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u.test(path) &&
      segments.every((segment) => segment.length > 0 && !segment.startsWith('.'));
    assert.ok(publicRootFiles.has(path) || isBuildArtifact, `Unexpected packed file: ${path}`);
    assert.ok(
      !segments.some((segment) => /^(?:node_modules|fixtures|__fixtures__|tests?|__tests__)$/iu.test(segment)) &&
        !/(?:\.(?:test|spec)\.|(?:^|\/)(?:vitest|vite|eslint|tsconfig)\.config\.)/iu.test(path),
      `Development-only file in tarball: ${path}`,
    );
  }
  for (const required of [...publicRootFiles, 'dist/cli.js', 'dist/cli.js.map']) {
    assert.ok(files.has(required), `Missing packed file: ${required}`);
  }
  for (const path of files) {
    if (path.endsWith('.js')) {
      assert.ok(files.has(`${path}.map`), `Missing source map for ${path}`);
    }
  }

  mkdirSync(installDirectory);
  runNpm(
    [
      'install',
      '--prefix',
      installDirectory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temporaryDirectory, manifest.filename),
    ],
    installDirectory,
  );

  const installedDirectory = join(installDirectory, 'node_modules', '@dichovsky', 'testrail-mcp');
  const installedPackage = JSON.parse(readFileSync(join(installedDirectory, 'package.json'), 'utf8'));
  assert.equal(installedPackage.name, packageJson.name);
  assert.equal(installedPackage.version, packageJson.version);
  assert.equal(installedPackage.type, 'module');
  assert.deepEqual(installedPackage.bin, { 'testrail-mcp': 'dist/cli.js' });
  assert.deepEqual(installedPackage.exports, { './package.json': './package.json' });
  assert.deepEqual(installedPackage.dependencies, packageJson.dependencies);
  for (const [name, version] of Object.entries(installedPackage.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu, `Dependency must use an exact version: ${name}`);
  }

  const installedCli = join(installedDirectory, 'dist', 'cli.js');
  assert.ok(readFileSync(installedCli, 'utf8').startsWith('#!/usr/bin/env node\n'), 'Missing CLI shebang.');
  const shim = join(installDirectory, 'node_modules', '.bin', `testrail-mcp${process.platform === 'win32' ? '.cmd' : ''}`);
  accessSync(shim, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  if (process.platform !== 'win32') {
    assert.equal(realpathSync(shim), realpathSync(installedCli), 'Installed bin points at the wrong file.');
  }

  for (const path of files) {
    if (!path.endsWith('.map')) continue;
    const map = JSON.parse(readFileSync(join(installedDirectory, path), 'utf8'));
    assert.equal(map.version, 3, `Invalid source-map version: ${path}`);
    assert.equal(map.file, basename(path, '.map'), `Wrong source-map target: ${path}`);
    assert.equal(typeof map.mappings, 'string', `Missing source-map mappings: ${path}`);
    assert.ok(Array.isArray(map.names), `Missing source-map names: ${path}`);
    assert.ok(Array.isArray(map.sources) && map.sources.length > 0, `Missing source-map sources: ${path}`);
    assert.ok(Array.isArray(map.sourcesContent), `Source map must embed sources: ${path}`);
    assert.equal(map.sourcesContent.length, map.sources.length, `Incomplete embedded sources: ${path}`);
    for (const [index, source] of map.sources.entries()) {
      const sourcePath = resolve(projectDirectory, dirname(path), map.sourceRoot ?? '', source);
      assert.ok(sourcePath.startsWith(join(projectDirectory, 'src') + sep), `Unexpected source-map input: ${path}`);
      assert.equal(map.sourcesContent[index], readFileSync(sourcePath, 'utf8'), `Incorrect embedded source: ${path}`);
    }
  }

  const environments = [
    ['without TestRail configuration', cleanEnvironment],
    ['with invalid TestRail configuration', {
      ...cleanEnvironment,
      TESTRAIL_BASE_URL: 'invalid-url-for-package-smoke-test',
      TESTRAIL_EMAIL: 'package-smoke-test@example.test',
      TESTRAIL_API_KEY: 'synthetic-package-smoke-test-key',
      TESTRAIL_MCP_UPLOAD_ROOTS: 'invalid-json',
    }],
  ];
  for (const [description, env] of environments) {
    for (const flag of ['--help', '-h', '--version', '-v']) {
      const result = runNpm(
        ['exec', '--loglevel=error', '--offline', '--no', '--prefix', installDirectory, '--', 'testrail-mcp', flag],
        installDirectory,
        env,
      );
      assert.equal(result.stderr, '', `${flag} must leave stderr empty ${description}.`);
      if (flag === '--version' || flag === '-v') {
        assert.equal(result.stdout, `${packageJson.version}\n`, `Incorrect ${flag} output ${description}.`);
      } else {
        assert.match(result.stdout, /Usage:.*testrail-mcp/iu, `Missing usage in ${flag} output ${description}.`);
      }
    }
  }
  console.log(`Package smoke passed: ${manifest.name}@${manifest.version}, ${files.size} allowed files, installed CLI verified.`);
} catch (error) {
  const diagnostic = error instanceof Error ? error.message : String(error);
  console.error(`Package smoke failed: ${diagnostic.slice(0, 4000)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
