# Releases

This guide tells how to version, publish, upgrade and roll back `@dichovsky/testrail-mcp`. Version 1.0.0 is the first release. It was published on 2026-10-04. Before 1.0.0, npm held only the deprecated placeholder `0.0.0-bootstrap.0`.

## Versioning and compatibility

Versions follow semantic versioning. The rules apply to what a client and its model depend on:

| Change | Version |
| --- | --- |
| A tool removed or renamed; an input made stricter so a previously valid call is refused; a result or error shape changed; a default limit lowered; the supported Node range narrowed | Major |
| A tool, optional input or optional result field added; a limit ceiling raised; a new TestRail version qualified | Minor |
| A fix that makes behaviour match the documentation; a dependency update with no behaviour change | Patch |

- **TestRail.** The tools cover the TestRail 10.7.0 API reference. Version 10.8.1 is the baseline: the live qualification runs against it. Support for older versions is best effort. If the instance does not support a tool, the tool fails with the TestRail error. The server never hides that error.
- **TypeScript.** TypeScript 7 (`typescript`) builds the package and runs `typecheck`.
- **Lint.** `oxlint` with `oxlint-tsgolint` runs type-aware lint. It uses its own embedded TypeScript 7 checker, so it does not need the `typescript` package. Both packages are pinned exactly and updated together.
- **Node.** The engine range is `>=24`. The pinned driver 9.0.0 also requires this range. CI runs the newest 24 release on Linux, macOS and Windows. Later major versions satisfy the range, but they are not tested. Support for them is best effort.
- **Driver.** Each release pins one exact, qualified driver version. The pin changes only after the review that [driver qualification](driver-qualification.md) describes.

## One-time setup

Releases go through the [Publish workflow](../.github/workflows/publish.yml). `@dichovsky/testrail-api-client` uses the same release process. The workflow starts when a GitHub Release is published for a `release/X.Y.Z` tag.

**GitHub.** The environment `npm-publish` requires approval from the repository owner, `dichovsky`. The owner can approve their own release. Keep at least one required reviewer configured. The environment name in the workflow does not create an approval rule. Verify this setting before each release, because it can change without a commit. The command that follows fails if the reviewer rule is absent or empty:

```sh
gh api repos/dichovsky/testrail-mcp/environments/npm-publish \
  --jq '.protection_rules | any(.type == "required_reviewers" and (.reviewers | length > 0))' \
  | grep -qx true
```

**npm.** With trusted publishing, the workflow publishes with a short-lived GitHub OIDC credential. Thus, no npm token is stored. npm attaches a provenance attestation to each release that is published this way. On npmjs.com, open the package settings. Add a trusted publisher with these values:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `dichovsky` |
| Repository | `testrail-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | `npm-publish` |
| Permissions | `npm publish` allowed. If the relationship allows only `npm stage publish`, it refuses the workflow's `npm publish`. The first 1.0.0 attempt showed this refusal |

npm allows a trusted publisher only on a package that already exists. Thus, the first version had to be published another way. For this reason, the owner published the deprecated placeholder `0.0.0-bootstrap.0` on 2026-10-02, under the `bootstrap` tag. npm points `latest` at the first version of a package, whatever its tag. Thus, `latest` names the placeholder until 1.0.0. The registry check in the workflow accepts a pre-release `latest` only while no stable version is published. Only this bootstrap case meets that condition. After you configure the trusted publisher, revoke all tokens that you used for the bootstrap.

### Publishing by hand

When you run `npm publish` from a working tree, it first runs `scripts/check-publish.mjs`. This check runs before the build. The check refuses:

- the `-dev` version of the tree, whatever the tag;
- a pre-release without a `--tag` other than `latest`. npm 10 publishes such a pre-release under `latest`. npm 11 refuses it without `--tag`, but only after the build.

The Publish workflow publishes with `--ignore-scripts`. This flag runs no package scripts, so the check does not apply to the workflow. `--ignore-scripts` skips both the check and the build.

## Release checklist

### Prepare

1. **Gates.**
   - CI passes on `main`.
   - Each required client has its record in [client evidence](evidence/clients/). Alternatively, the owner decided to release without the record, and the release notes say so. For 1.0.0, the owner closed [R02](https://github.com/dichovsky/testrail-mcp/issues/23) with these results: Claude Code was recorded, Codex CLI was owner-reported, and Codex desktop and Copilot CLI were not tested.
   - The live TestRail qualification evidence is complete. It has these properties:
     - A [live qualification](live-qualification.md) record for 10.8.1 has no `fail`.
     - The record was made with the driver that the release pins (its `server.driver_version`).
     - Each `blocked` or `not_run` tool is explained and listed as a known limitation in the release notes.
   - [Client configuration](client-compatibility.md) and the [release gates](implementation-plan.md#release-gates-and-evidence) list what each gate must contain.
2. **Version pull request.**
   1. Choose a stable version that is newer than all published stable versions.
   2. Set the version with `npm version X.Y.Z --no-git-tag-version --ignore-scripts`. This command updates `package.json` and the two root version fields of `package-lock.json`.
   3. Move the `Unreleased` entries into a [changelog](../CHANGELOG.md) section with the heading `## [X.Y.Z] - YYYY-MM-DD`. Use the release version and date.
   4. Merge the pull request when CI passes on Linux, macOS and Windows.
   5. Fetch `main` and check CI on the merge commit.

### Publish

1. **Tag** the verified merge commit as `release/X.Y.Z`. Then push the tag. Never move an existing release tag.

   ```sh
   git fetch origin main --tags
   git tag release/X.Y.Z <merge commit>
   git push origin release/X.Y.Z
   ```

2. **Publish a stable GitHub Release** for that existing tag. Use the changelog section as its notes. Mark the release as latest. `--verify-tag` refuses to create a tag, so a typo cannot release a different commit. `scripts/release-notes.mjs` prints the section. It refuses a tag that does not match `package.json`. It also refuses a section that is missing or undated. It points the relative links of the section at the tagged tree.

   ```sh
   node scripts/release-notes.mjs release/X.Y.Z > release-notes.md
   gh release create release/X.Y.Z --verify-tag --title X.Y.Z --latest --notes-file release-notes.md
   ```

3. **Monitor the Publish run, and approve it.** The run has two jobs:

| Job | Permission | What it does |
| --- | --- | --- |
| `verify` | `contents: read` | Before any repository code runs, it checks three conditions: the event is a published, stable release; the tag is `release/X.Y.Z`; and the tag, the event's commit and the checkout are one commit that is reachable from `main`. Then `scripts/release-preflight.mjs context` checks that `package.json` and the lockfile name this package at that version. It also checks that npm and Node support trusted publishing. The job requires the dated changelog section of the version. Then it runs every gate: build, registry check, typecheck, lint, the tests with coverage, `npm audit --omit=dev`, and the packed-package smoke test. Next, `scripts/release-preflight.mjs registry` asks npm, with an isolated configuration, whether the version is published. A new version must be newer than `latest` and every published stable version. An identical release (same `gitHead`, `latest`, provenance and files) is skipped. Any other answer stops the release. Last, the job archives the tested `dist` with its SHA-256 |
| `publish` | `contents: read`, `id-token: write`, in `npm-publish` | Waits for approval. Before any repository code runs, it repeats the identity check. It verifies the SHA-256 and paths of the archive, and it restores the tested `dist`. It installs and runs no repository or dependency code. With an empty npm configuration, it checks again that the version is absent and still newer than the versions on npm. Then it publishes with `--provenance --ignore-scripts`. After that, it waits up to five minutes for npm to report four items: the version, the release commit as `gitHead`, the version as `latest`, and an SLSA provenance attestation. Last, it checks with `npm diff` that every published file is the tested build |

While the run waits, check the approval gate with the command that follows. The response from this endpoint, not this guide, shows the actual gate:

```sh
gh api repos/dichovsky/testrail-mcp/actions/runs/<run-id>/pending_deployments
```

### Verify after publication

- Make sure that the full Publish run succeeds.
- Install the published version into a clean directory and drive it with `node scripts/verify-published.mjs @dichovsky/testrail-mcp@X.Y.Z --version X.Y.Z --require-provenance`. The script checks that npm holds a provenance attestation. It also checks that the installed executable serves all 133 tools over MCP in both protocol eras.
- Confirm that the GitHub Release is public, stable and latest, and that it points at the verified commit.

If publication or its verification fails, examine the exact version on npm before you do anything else. npm can accept an upload while the version still answers 404 during processing.

- Never publish again under the same version.
- Re-run the full workflow, `verify` included. If you re-run `publish` alone, it reuses its earlier decision and fails the version-absence check.

`verify` recognizes an already published release only when its identity, provenance, `latest` and files all match.

If the published package itself is faulty, never unpublish it. Release the fix as a new patch version. Deprecate the faulty version if users should avoid it.

## Dependency maintenance

GitHub vulnerability alerts and Dependabot security updates are enabled for this repository. Security fixes come as pull requests. Each security fix requires review and passing checks before it is merged. A clean release audit describes the dependencies at the time of the audit. Alerts also cover vulnerabilities that are disclosed while the repository is idle.

[Dependabot configuration](../.github/dependabot.yml) checks npm dependencies and GitHub Actions every Monday at 09:00 Europe/Kyiv. These checks start after the configuration is on the default branch. npm updates keep exact version pins. Weekly version updates use three groups:

- the MCP server and client packages;
- oxlint and oxlint-tsgolint;
- Vitest and its coverage package.

Security-update pull requests are separate. Driver updates still need the [qualification process](driver-qualification.md), which includes the release ledger and parameter evidence. An automated pull request does not qualify a driver release. Review Actions updates also. Vulnerability alerts do not cover SHA-pinned actions, and the version-update checks keep those pins current. See [GitHub's alert limitations](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts#limitations).

When you maintain the release configuration, check the effective settings with the commands that follow. When alerts are enabled, the alerts endpoint succeeds with no body. The security-fix endpoint reports `enabled: true`:

```sh
gh api repos/dichovsky/testrail-mcp/vulnerability-alerts --silent
gh api repos/dichovsky/testrail-mcp/automated-security-fixes --jq '.enabled'
```

## Upgrading, rolling back and uninstalling

- **Upgrade:** install an exact version with `npm install --global @dichovsky/testrail-mcp@X.Y.Z`. Then restart the MCP client, so that it launches the new executable. The configuration is in the client's environment, and it stays the same.
- **Roll back:** install the previous exact version with the same command. A deprecated version can still be installed.
- **Uninstall:** run `npm uninstall --global @dichovsky/testrail-mcp`.

Upgrade, rollback and uninstall do not change the download directory. Downloaded attachments belong to you. The server never deletes a completed download. An uninstall does not remove downloaded attachments.
