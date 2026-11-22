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
- **Node.** The engine range is `>=26`. The pinned driver 10.0.0 also requires this range. CI runs the newest Node 26 release on Linux, macOS and Windows. Later major versions satisfy the range, but they are not tested. Support for them is best effort.
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

npm allows a trusted publisher only on a package that already exists. Thus, the first version had to be published another way. For this reason, the owner published the deprecated placeholder `0.0.0-bootstrap.0` on 2026-10-02, under the `bootstrap` tag. npm points `latest` at the first version of a package, whatever its tag. Thus, `latest` names the placeholder until 1.0.0.

The registry check in the workflow accepts a pre-release `latest` only while no stable version is published. Only this bootstrap case meets that condition. After you configure the trusted publisher, revoke all tokens that you used for the bootstrap.

### Publishing by hand

When you run `npm publish` from a working tree, it first runs `scripts/check-publish.mjs`. This check runs before the build. The check refuses:

- the `-dev` version of the tree, whatever the tag;
- a pre-release without a `--tag` other than `latest`. npm 10 publishes such a pre-release under `latest`. npm 11 refuses it without `--tag`, but only after the build.

The Publish workflow publishes with `--ignore-scripts`. This flag runs no package scripts, so the check does not apply to the workflow. `--ignore-scripts` skips both the check and the build.

## Release checklist

### Prepare

1. Merge the migration after the offline checks pass on Linux, macOS and Windows. During release preparation, do these audits:
   - Run the independent driver ledger audit.
   - Run the production dependency audits.

   The Publish workflow repeats the release audits.
2. Open the version pull request:
   1. Run `npm version 2.0.0 --no-git-tag-version --ignore-scripts`.
   2. Update the install example in the README.
   3. Move the Unreleased changelog entries into a dated 2.0.0 section.
   4. Merge the pull request after CI passes.
   5. Wait until CI passes on the merge commit.
3. Run [Prepare Candidate](../.github/workflows/prepare-candidate.yml) on that commit from `main`. The workflow uses Node 26.13.1 and npm 11.20.0.
   1. Download `candidate.tgz` and `candidate.json` from the same successful run attempt.
   2. Keep the two files together for qualification and publication.
   3. Start qualification after that attempt finishes.

   If you prepare the candidate again, use the files of the new attempt. Then run qualification again, even if the tarball digest stays the same.
4. Qualify the candidate:
   - Run [client qualification](client-runbook.md) for Claude Code, Codex desktop, Codex CLI and Copilot CLI on Node 26.
   - Run [live TestRail 10.8.1 qualification](live-qualification.md) with the same candidate.
   - Run the [Proxmox rehearsal](../proxmox/README.md#release-rehearsal) on disposable guests.

   The 1.0.0 evidence and its exceptions stay part of the record of that release.
5. Assemble a sanitized `qualification.json` with these contents:
   - `schema_version: 1`;
   - a `clients` array of four evidence records;
   - the `live` record that the packaged runner produced.

   Each record identifies the same commit, tarball integrity, Prepare Candidate run ID and attempt. Client records also include these items:
   - the actual version in `client.node_machine_version`;
   - the C10 trace facts;
   - the start and finish times of the run.

   Use the complete record of the live runner. This record includes its version check, planned steps, cleanup dispositions and sanitized readbacks.

### Publish

1. Make the draft release:
   1. Tag the verified candidate commit `release/2.0.0`.
   2. Push that tag.
   3. Make a draft GitHub Release for the existing tag.
   4. Attach `candidate.json`, `candidate.tgz` and `qualification.json`.
   5. Examine the assets for credentials and instance data before you make them public.
2. Prepare the release notes and check the evidence:
   1. Generate the release notes from the dated changelog.
   2. Append the live limitations block.
   3. Set `CANDIDATE_DIR` to the directory that holds the two files that you downloaded from Prepare Candidate.
   4. Run the local check.

   ```sh
   node scripts/release-notes.mjs release/2.0.0 > release-notes.md
   node scripts/release-evidence.mjs limitations qualification.json >> release-notes.md
   node scripts/release-evidence.mjs check "$CANDIDATE_DIR" qualification.json release-notes.md
   ```

   The local check validates the files and records. The Publish workflow also checks the original GitHub Actions artifact and its recorded lifetime.

3. Publish the draft GitHub Release. Then the read-only Verify job does these checks:
   - It checks the tag.
   - It compares the release assets with the successful Prepare Candidate attempt.
   - It rebuilds the tagged source independently and checks the archive digest.

   The job also requires these conditions:
   - The qualification records must fall within the verified lifetime of the candidate.
   - The live run must observe TestRail 10.8.1 and account for the planned steps.
   - The live run must create and delete its project. It must record a confirmed absence for each successful creation of a project, group or attachment.
   - Each created group or attachment must finish with a successful planned or cleanup deletion.
   - The live limitations block must match the evidence.

   The Publish workflow matches the deletion and readback of each attachment to its plan label. It requires zero cleanup residue. It rejects successful steps that leave a generated report, user or case field behind.
4. After Verify passes, approve the protected npm job. This job does these steps:
   1. It rehashes the verified tarball.
   2. It checks that the Prepare Candidate artifact is still within its lifetime.
   3. It uploads those same bytes through trusted publishing.
   4. It checks the version, `latest`, `gitHead` and tarball integrity on npm.
   5. It checks the provenance subject, repository, tagged ref, workflow path and source commit.

   The already-published path requires the same identity.
5. Verify a clean install of the published version and both protocol eras. Use the SHA-512 integrity from `candidate.json`.

   ```sh
   node scripts/verify-published.mjs @dichovsky/testrail-mcp@2.0.0 \
     --version 2.0.0 --integrity "$QUALIFIED_INTEGRITY" --require-provenance
   ```

If publication or verification fails, do these steps:

1. Before you retry, examine the exact version on npm. npm can accept an upload before the version appears in metadata.
2. Run the full workflow again, starting with Verify.

If a published artifact is faulty, release the fix as a new patch version. You can deprecate the faulty version if users should avoid it. Users on Node 24 can install the exact 1.0.0 release.

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
