import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * npm runs this as prepublishOnly before a publish from the working tree, ahead of
 * prepack's build. The release workflow publishes a packed tarball, which runs no
 * package scripts, so this guards only a publish typed by hand.
 */

/**
 * Why npm must not publish this version with this --tag, or undefined when it may. `tag`
 * is the --tag npm was given, undefined when none was. npm 10 publishes a pre-release
 * under `latest` when no tag is given; npm 11 refuses it, but only after the build.
 */
export function publishRefusal(version, tag) {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/u.exec(version)?.[1];
  if (prerelease === undefined) return undefined;
  if (prerelease.split('.')[0] === 'dev') {
    return `${version} is this repository's development version and is never published. The release workflow publishes each release from its vX.Y.Z tag; see docs/release.md.`;
  }
  if (tag === undefined || tag === 'latest') {
    return `${version} is a pre-release. Publish it with a --tag other than latest, such as --tag next, so that it does not become what npm install gets.`;
  }
  return undefined;
}

// Compared through the real path, so a symlinked invocation still runs the check.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const refusal = publishRefusal(version, process.env.npm_config_tag || undefined);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
}
