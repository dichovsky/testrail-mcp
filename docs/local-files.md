# Local file layer

`src/files/` implements F07: containment for caller-supplied upload paths, bounded staging copies, abandoned-staging recovery, and persistent attachment downloads.

## What this layer is and is not

It bounds what the server will read and write on behalf of a caller. It is **not** isolation from a malicious process running as the same OS user, and must not be described as such — anything that user can do to the filesystem, it can still do while this server runs.

## Containment

A caller-supplied path must be absolute, must resolve, and its **resolved** location must lie inside a configured root. `realpath` resolves the whole symlink chain, so containment is judged on the real destination rather than the name used to reach it: a link inside a root pointing outside one is rejected.

Roots are resolved too. A configured root can itself sit behind a symlink — macOS's own temporary directory does — and comparing a resolved candidate against an unresolved root would deny every legitimate file.

Containment compares **path components**, not string prefixes. `/data/rootsomething` begins with `/data/root` as a string but is a different directory; `path.relative` answers this correctly on both platforms, including drive letters and case rules.

Missing, unreadable and out-of-root paths all produce the same refusal, because distinguishing them would leak filesystem layout.

## Why staging copies

Validating a path and then handing that same path to the driver leaves a window in which the source is replaced between the two, so the bytes sent need not be the bytes approved. Staging opens a handle at validation time and copies through it, binding the approval to the content.

The size limit is enforced **while copying**, not from the initial `stat`, because a file can grow after it is measured. The staged copy is created exclusively with restrictive permissions inside a private per-process directory, and the driver receives a path — never an adapter-owned descriptor, whose ownership is hard to guarantee across early DNS failures and platform fallbacks.

Where inode identity is meaningful, the opened handle is checked against the path it came from, so a file swapped between resolution and open is caught. `O_NOFOLLOW` guards the final component where the platform provides it; Windows reports no usable inode and no such flag, so containment carries the check there.

## Recovery deletes only what it can prove

An abandoned staging directory is removed only with positive evidence: our marker, a recorded owner PID, and proof that the owner is gone. `ESRCH` is the only proof of absence — `EPERM` means the process exists under another user, and anything unreadable or unmarked is left alone. A stale directory wastes an inode; deleting a live one destroys an upload in flight, and PID reuse makes that a real possibility. Completed downloads are never inspected.

## Downloads are additive and never destructive

The caller never chooses the destination. The name is generated, creation is exclusive, and the result is returned only after the bytes are written and the handle closed — so a reported path always refers to a complete file. A failure part-way removes the partial output. Once committed the file is kept even if delivery later fails, because the user now owns it.

Repeating a download creates another distinct retained file. That local additive effect is why these tools carry non-read-only, non-idempotent annotations despite being ordinary TestRail GETs. No original filename or media type is invented; the driver returns only bytes, and contents never appear as inline base64.

## Verification

`tests/files.test.ts` uses disposable directories only. It covers component-versus-prefix containment, traversal, symlink escape and symlink-within-root, non-regular sources, source replacement after staging, a file that lies about its size, handle-close counting, idempotent disposal, recovery's four refusal cases, and download exclusivity with cleanup on write and close failure.

Mutation-checked: string-prefix containment, skipping `realpath`, forwarding the source path instead of copying, trusting the initial size, opening downloads with `w` instead of `wx`, and ignoring the ownership marker each fail a test.

One of those mutations exposed a flaw in the tests themselves. The symlink-escape case originally survived removal of `realpath`, because on macOS the unresolved candidate failed to match the resolved root — it rejected for the wrong reason. The fixture now resolves its base directory, so the symlink is the only variable and the test fails when the protection is removed.
