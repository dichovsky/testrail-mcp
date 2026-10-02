# Releases

This is how `@dichovsky/testrail-mcp` is versioned, published, upgraded and rolled back. No release is on npm yet: the only version there is the deprecated placeholder `0.0.0-bootstrap.0`, and 1.0.0 is the first planned release.

## Versioning and compatibility

Versions follow semantic versioning, applied to what a client and its model depend on:

| Change | Version |
| --- | --- |
| A tool removed or renamed; an input made stricter so a previously valid call is refused; a result or error shape changed; a default limit lowered; the supported Node range narrowed | Major |
| A tool, optional input or optional result field added; a limit ceiling raised; a new TestRail version qualified | Minor |
| A fix that makes behaviour match the documentation; a dependency update with no behaviour change | Patch |

- **TestRail.** 10.7.0 is the full-coverage baseline. Older versions are best effort: a tool the instance does not support fails with TestRail's own error, and the server never hides it.
- **Node.** CI runs the newest 24 release on Linux, macOS and Windows. The package's engine range also admits 22.13 and later in the 22 series, and later majors; those are untested and best effort.
- **Driver.** Each release pins one exact, qualified driver version. The pin changes only with the review that [driver qualification](driver-qualification.md) describes.

## One-time setup

**GitHub.** Create the environment `npm-release` under the repository's settings.
- Add at least one required reviewer.
- Limit its deployments to tags matching `v*`.

The [release workflow](../.github/workflows/release.yml) publishes only from that environment.

**npm.** Trusted publishing lets the workflow publish with a short-lived GitHub OIDC credential, so no npm token is stored. npm attaches a provenance attestation to each such release. On npmjs.com, open the package's settings and add a trusted publisher:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `dichovsky` |
| Repository | `testrail-mcp` |
| Workflow filename | `release.yml` |
| Environment name | `npm-release` |

npm allows a trusted publisher only on a package that already exists, so the very first version must be published another way. There are two routes. The owner took the first, and published `0.0.0-bootstrap.0` on 2026-10-02, so what remains is the trusted publisher above.

- **Publish a placeholder first**, so that 1.0.0 goes through the workflow like every later release, with provenance.
  1. Set `version` to `0.0.0-bootstrap.0` in a scratch copy of the tree.
  2. Run `npm publish --access public --tag bootstrap` there. A pre-release needs a `--tag` other than `latest`: the [check below](#publishing-by-hand) refuses one without it, and so does npm 11. The tag does not keep `latest` free, though. The registry points `latest` at a package's first version whatever its tag, so until 1.0.0 is published, `npm install @dichovsky/testrail-mcp` gets the deprecated placeholder. Publishing 1.0.0 moves `latest` to it.
  3. Run `npm deprecate @dichovsky/testrail-mcp@0.0.0-bootstrap.0 "Placeholder; install 1.0.0 or later."`.
  4. Configure the trusted publisher above, then release 1.0.0 with the checklist below.
- **Publish 1.0.0 once from a terminal**, from the tagged, fully checked tree, with `npm publish --access public`. 1.0.0 then has no provenance attestation. The workflow the tag starts cannot finish for 1.0.0. Its publish job stops at a 1.0.0 published from a different tarball, and a byte-identical one fails the provenance check, so there is no workflow SBOM or GitHub release. Create the release by hand with `gh release create v1.0.0 --verify-tag --notes-file <notes>`, attaching the tarball you published. Every later version goes through the workflow.

Either way, revoke any token used for the bootstrap afterwards.

### Publishing by hand

`npm publish` from a working tree first runs `scripts/check-publish.mjs`, before anything is built. It refuses:
- the tree's own `-dev` version, under any tag;
- a pre-release without a `--tag` other than `latest`. npm 10 would publish one under `latest`, and npm 11 refuses one without `--tag` only after the build.

The release workflow publishes a packed tarball, which runs no package scripts, so the check does not affect it. `--ignore-scripts` skips the check, and the build with it.

## Release checklist

1. **Gates.**
   - CI passes on `main`.
   - Every record in [client evidence](evidence/clients/) holds the required-client results.
   - The live TestRail qualification evidence is complete: a [live qualification](live-qualification.md) record for 10.7.0 with no `fail`, and every `blocked` or `not_run` tool explained.
   - [Client configuration](client-compatibility.md) and the [release gates](implementation-plan.md#release-gates-and-evidence) list what each must contain.
2. **Version pull request.** Set `version` in `package.json` and `package-lock.json`, then replace `Unreleased` with the release date in that version's [changelog](../CHANGELOG.md) section. Merge it once CI passes.
3. **Tag.** Tag the merge commit on `main` as `vX.Y.Z` and push the tag.
4. **Approve.** The workflow re-runs every check on all six platforms, builds the release files, and then waits for the `npm-release` environment. Approve it.
5. **Publish.** The workflow runs its jobs in order, each with only the permission it needs:

| Job | Permission | What it does |
| --- | --- | --- |
| `verify` | read | `npm run check` on Node 24, on Linux, macOS and Windows |
| `build` | read | Refuses a tag that does not match `package.json`, and a changelog section that is missing or undated. Writes the notes, packs the tarball, and writes a CycloneDX inventory of a clean production install with `scripts/release-sbom.mjs` |
| `publish` | `id-token: write`, in `npm-release` | Publishes that exact tarball with `--provenance`, so npm refuses to publish it without an attestation. It checks out, installs and runs no package code. If the version is already published from the same tarball, it goes on; from a different one, it stops |
| `verify-published` | read | Installs the published version from npm into a clean directory with `scripts/verify-published.mjs`. Checks that npm serves the same integrity and holds a provenance attestation, and that the installed executable serves all 133 tools over MCP in both protocol eras |
| `release` | `contents: write` | Creates the GitHub release with the notes, the tarball and the inventory, or completes it on a re-run |

If a job after `publish` fails, fix the cause and re-run the workflow: the published version is recognised by its integrity, and the checks and the release run again. If the published package itself is faulty, never unpublish it. Fix forward with a new patch version, and deprecate the faulty one if users should avoid it.

## Upgrading, rolling back and uninstalling

- **Upgrade** by installing an exact version: `npm install --global @dichovsky/testrail-mcp@X.Y.Z`. Restart the MCP client afterwards so it launches the new executable. Configuration lives in the client's environment and carries over unchanged.
- **Roll back** by installing the previous exact version the same way. A deprecated version stays installable.
- **Uninstall** with `npm uninstall --global @dichovsky/testrail-mcp`.

Neither upgrading, rolling back nor uninstalling touches the download directory. Downloaded attachments are yours; the server never deletes a completed download, and an uninstall leaves them in place.
