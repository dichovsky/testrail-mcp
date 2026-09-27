# Releases

This is how `@dichovsky/testrail-mcp` is versioned, published, upgraded and rolled back. The package is not yet published; 1.0.0 is the first planned release.

## Versioning and compatibility

Versions follow semantic versioning, applied to what a client and its model depend on:

| Change | Version |
| --- | --- |
| A tool removed or renamed; an input made stricter so a previously valid call is refused; a result or error shape changed; a default limit lowered; the supported Node range narrowed | Major |
| A tool, optional input or optional result field added; a limit ceiling raised; a new TestRail version qualified | Minor |
| A fix that makes behaviour match the documentation; a dependency update with no behaviour change | Patch |

- **TestRail.** 10.7.0 is the full-coverage baseline. Older versions are best effort: a tool the instance does not support fails with TestRail's own error, and the server never hides it.
- **Node.** 22.13 or later in the 22 series, and 24, on Linux, macOS and Windows, which are the versions and systems CI runs. Other versions the package's engine range admits are best effort.
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

npm allows a trusted publisher only on a package that already exists, so the very first version must be published another way. The owner chooses one of these before tagging 1.0.0:

- **Publish 1.0.0 once from a terminal.** Use `npm publish --access public` on the tagged, fully checked tree, then configure trusted publishing for every later version. 1.0.0 then has no provenance attestation.
- **Publish a placeholder first.** Publish `0.0.0-bootstrap.0` from a terminal and deprecate it at once (`npm deprecate`). Configure trusted publishing, then release 1.0.0 through the workflow with provenance.

Either way, revoke any token used for the bootstrap afterwards.

## Release checklist

1. **Gates.**
   - CI passes on `main`.
   - Every record in [client evidence](evidence/clients/) holds the required-client results.
   - The live TestRail qualification evidence is complete.
   - [Client configuration](client-compatibility.md) and the [release gates](implementation-plan.md#release-gates-and-evidence) list what each must contain.
2. **Version pull request.** Set `version` in `package.json` and `package-lock.json`, then replace `Unreleased` with the release date in that version's [changelog](../CHANGELOG.md) section. Merge it once CI passes.
3. **Tag.** Tag the merge commit on `main` as `vX.Y.Z` and push the tag.
4. **Approve.** The workflow re-runs every check on all six platforms and then waits for the `npm-release` environment. Approve it.
5. **Publish.** The workflow:
   - refuses a tag that does not match `package.json`, and a changelog section that is missing or undated;
   - packs the tarball and writes a CycloneDX dependency inventory;
   - publishes that exact tarball;
   - installs the published version from npm into a clean directory with `scripts/verify-published.mjs`, and checks that npm serves the same integrity, holds a provenance attestation, and that the installed executable serves all 133 tools over MCP in both protocol eras;
   - creates the GitHub release with the notes, the tarball and the inventory.

If publishing fails after the version reached npm, never unpublish it. Fix forward with a new patch version, and deprecate the faulty one if users should avoid it.

## Upgrading, rolling back and uninstalling

- **Upgrade** by installing an exact version: `npm install --global @dichovsky/testrail-mcp@X.Y.Z`. Restart the MCP client afterwards so it launches the new executable. Configuration lives in the client's environment and carries over unchanged.
- **Roll back** by installing the previous exact version the same way. A deprecated version stays installable.
- **Uninstall** with `npm uninstall --global @dichovsky/testrail-mcp`.

Neither upgrading, rolling back nor uninstalling touches the download directory. Downloaded attachments are yours; the server never deletes a completed download, and an uninstall leaves them in place.
