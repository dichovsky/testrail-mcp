# Releases

This is how `@dichovsky/testrail-mcp` is versioned, published, upgraded and rolled back. 1.0.0 is the first release. Before it, npm held only the deprecated placeholder `0.0.0-bootstrap.0`.

## Versioning and compatibility

Versions follow semantic versioning, applied to what a client and its model depend on:

| Change | Version |
| --- | --- |
| A tool removed or renamed; an input made stricter so a previously valid call is refused; a result or error shape changed; a default limit lowered; the supported Node range narrowed | Major |
| A tool, optional input or optional result field added; a limit ceiling raised; a new TestRail version qualified | Minor |
| A fix that makes behaviour match the documentation; a dependency update with no behaviour change | Patch |

- **TestRail.** The tools cover TestRail's 10.7.0 API reference. 10.8.1 is the baseline, the version the live qualification runs against. Older versions are best effort: a tool the instance does not support fails with TestRail's own error, and the server never hides it.
- **TypeScript.** TypeScript 7 (`@typescript/native`) builds the package and runs `typecheck`. `typescript` stays on 6.x only because typescript-eslint does not yet accept 7; `typecheck:ts6` keeps both compilers agreeing. Drop it, and the 6.x pin, once typescript-eslint supports TypeScript 7.
- **Node.** The engine range is `>=24`, which the pinned driver 9.0.0 requires as well. CI runs the newest 24 release on Linux, macOS and Windows. Later majors satisfy the range but are untested and best effort.
- **Driver.** Each release pins one exact, qualified driver version. The pin changes only with the review that [driver qualification](driver-qualification.md) describes.

## One-time setup

Releases go through the [Publish workflow](../.github/workflows/publish.yml), the process `@dichovsky/testrail-api-client` releases with. Publishing a GitHub Release for a `release/X.Y.Z` tag starts it.

**GitHub.** Create the environment `npm-publish` under the repository's settings, and add at least one required reviewer. The publish job waits there for approval. Its reviewers may approve their own release, so the gate is a deliberate pause, not a second review. It is configuration outside this repository and can be removed without a commit, so check it before each release:

```sh
gh api repos/dichovsky/testrail-mcp/environments/npm-publish --jq '.protection_rules'
```

**npm.** Trusted publishing lets the workflow publish with a short-lived GitHub OIDC credential, so no npm token is stored. npm attaches a provenance attestation to each such release. On npmjs.com, open the package's settings and add a trusted publisher:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `dichovsky` |
| Repository | `testrail-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | `npm-publish` |

npm allows a trusted publisher only on a package that already exists, so the very first version had to be published another way. The owner published the deprecated placeholder `0.0.0-bootstrap.0` on 2026-10-02 for that: it was published under the `bootstrap` tag, but npm points `latest` at a package's first version whatever its tag, so `latest` names the placeholder until 1.0.0. The workflow's registry check accepts a pre-release `latest` only while no stable version is published, which is that case alone. After the trusted publisher is configured, revoke any token used for the bootstrap.

### Publishing by hand

`npm publish` from a working tree first runs `scripts/check-publish.mjs`, before anything is built. It refuses:
- the tree's own `-dev` version, under any tag;
- a pre-release without a `--tag` other than `latest`. npm 10 would publish one under `latest`, and npm 11 refuses one without `--tag` only after the build.

The Publish workflow publishes with `--ignore-scripts`, which runs no package scripts, so the check does not affect it. `--ignore-scripts` skips the check, and the build with it.

## Release checklist

### Prepare

1. **Gates.**
   - CI passes on `main`.
   - Every required client has its record in [client evidence](evidence/clients/), or the owner has decided to release without it and the release notes say so. For 1.0.0 the owner closed [R02](https://github.com/dichovsky/testrail-mcp/issues/23) with Claude Code recorded, Codex CLI owner-reported, and Codex desktop and Copilot CLI not tested.
   - The live TestRail qualification evidence is complete: a [live qualification](live-qualification.md) record for 10.8.1 with no `fail`, made with the driver the release pins (its `server.driver_version`), and every `blocked` or `not_run` tool explained and listed as a known limitation in the release notes.
   - [Client configuration](client-compatibility.md) and the [release gates](implementation-plan.md#release-gates-and-evidence) list what each must contain.
2. **Version pull request.** Choose a stable version newer than every published stable version. Set it with `npm version X.Y.Z --no-git-tag-version --ignore-scripts`, which updates `package.json` and both root version fields of `package-lock.json`. Replace `Unreleased` with the release date in that version's [changelog](../CHANGELOG.md) section. Merge the pull request once CI passes on Linux, macOS and Windows, then fetch `main` and check CI on the merge commit.

### Publish

1. **Tag** the verified merge commit as `release/X.Y.Z` and push the tag. Never move an existing release tag.

   ```sh
   git fetch origin main --tags
   git tag release/X.Y.Z <merge commit>
   git push origin release/X.Y.Z
   ```

2. **Publish a stable GitHub Release** for that existing tag, with the changelog section as its notes, marked latest. `--verify-tag` refuses to create a tag, so a typo cannot release another commit. `scripts/release-notes.mjs` prints the section and refuses a tag that does not match `package.json` or a section that is missing or undated; it points the section's relative links at the tagged tree.

   ```sh
   node scripts/release-notes.mjs release/X.Y.Z > release-notes.md
   gh release create release/X.Y.Z --verify-tag --title X.Y.Z --latest --notes-file release-notes.md
   ```

3. **Follow the Publish run, and approve it.** It runs two jobs:

| Job | Permission | What it does |
| --- | --- | --- |
| `verify` | `contents: read` | Before any repository code runs, checks that the event is a published, stable release, that the tag is `release/X.Y.Z`, and that the tag, the event's commit and the checkout are one commit reachable from `main`. Then, with `scripts/release-preflight.mjs context`, it checks that `package.json` and the lockfile name this package at that version, and that npm and Node support trusted publishing. It requires the version's dated changelog section, then runs every gate: build, registry check, both typechecks, lint, the tests with coverage, `npm audit --omit=dev`, and the packed-package smoke test. `scripts/release-preflight.mjs registry` then asks npm, with an isolated configuration, whether the version is published. A new version must be newer than `latest` and every published stable version. An identical release (same `gitHead`, `latest`, provenance and files) is skipped. Any other answer stops the release. Last, it archives the tested `dist` with its SHA-256 |
| `publish` | `contents: read`, `id-token: write`, in `npm-publish` | Waits for approval. Repeats the identity check before any repository code runs, verifies the archive's SHA-256 and paths, and restores the tested `dist`. It installs and runs no repository or dependency code. With an empty npm configuration it re-checks that the version is absent and still newer than what npm holds, then publishes with `--provenance --ignore-scripts`. Afterwards it waits up to five minutes for npm to report the version, the release commit as `gitHead`, the version as `latest` and an SLSA provenance attestation, and checks with `npm diff` that every published file is the tested build |

Check the approval gate while the run waits; this, not this guide, says what the gate is:

```sh
gh api repos/dichovsky/testrail-mcp/actions/runs/<run-id>/pending_deployments
```

### Verify after publication

- Require the whole Publish run to succeed.
- Install the published version into a clean directory and drive it, with `node scripts/verify-published.mjs @dichovsky/testrail-mcp@X.Y.Z --version X.Y.Z --require-provenance`. It checks that npm holds a provenance attestation and that the installed executable serves all 133 tools over MCP in both protocol eras.
- Confirm the GitHub Release is public, stable and latest, and points at the verified commit.

If publication or its verification fails, look at the exact version on npm before anything else: npm may accept an upload while the version still answers 404 during processing. Never publish again under the same version. Re-run the whole workflow, `verify` included: re-running `publish` alone reuses its earlier decision and fails the version-absence check. `verify` recognises an already published release only when its identity, provenance, `latest` and files all match. If the published package itself is faulty, never unpublish it. Fix forward with a new patch version, and deprecate the faulty one if users should avoid it.

## Upgrading, rolling back and uninstalling

- **Upgrade** by installing an exact version: `npm install --global @dichovsky/testrail-mcp@X.Y.Z`. Restart the MCP client afterwards so it launches the new executable. Configuration lives in the client's environment and carries over unchanged.
- **Roll back** by installing the previous exact version the same way. A deprecated version stays installable.
- **Uninstall** with `npm uninstall --global @dichovsky/testrail-mcp`.

Neither upgrading, rolling back nor uninstalling touches the download directory. Downloaded attachments are yours; the server never deletes a completed download, and an uninstall leaves them in place.
