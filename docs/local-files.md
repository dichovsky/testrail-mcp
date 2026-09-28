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

The size limit is enforced **while copying**, not from the initial `stat`, because a file can grow after it is measured. The staged copy is created exclusively with restrictive permissions inside a private per-process directory. If its generated name already exists the copy is refused, and the existing file is left alone: cleanup is armed only once the exclusive create has made the name ours. The copy is closed before it is handed over, and a failed close refuses it, since a deferred write error means the bytes may not have reached the disk. The driver receives a path — never an adapter-owned descriptor, whose ownership is hard to guarantee across early DNS failures and platform fallbacks.

Where inode identity is meaningful, the opened handle is checked against the path it came from after opening, so a file replaced once it is open is caught. `O_NOFOLLOW` refuses a final component swapped for a symlink before the open, where the platform provides the flag. Neither closes every window. A regular file swapped in between resolution and open is read, and so is an intermediate directory replaced by a symlink, because `O_NOFOLLOW` guards only the last component. Those are races a process running as the same user would have to win, which this layer does not claim to prevent. On Windows the flag does not exist, and the inode check runs only if the platform reports one.

The source is opened non-blocking, and that is what makes the regular-file check reachable at all. Opening a FIFO for reading blocks until a writer connects — before anything can observe the file type — so a caller naming a pipe inside an allowed root would hold a libuv worker indefinitely. Four such calls exhaust the default threadpool and stall every other async operation in the process, not merely this tool. A named pipe is an ordinary artifact that can sit innocently under a directory an operator points a root at, so this needs no hostile local process. `O_NONBLOCK` is a no-op for regular files, so nothing else changes.

One bound is still missing. The copy loop ends only at EOF or on exceeding the byte limit, so a file that grows slowly while staying under the limit keeps the call waiting for a long time. Staging runs before the call is admitted, so it holds no execution slot, but it has no deadline either and does not observe cancellation.

A staged copy outlives cancellation and the response watchdog until the driver settles. Shutdown is the exception: once the 5-second drain gives up, the staging area is removed even if an upload has still not settled.

## Recovery deletes only what it can prove

An abandoned staging directory is removed only with positive evidence: the staging name prefix, our marker, a recorded owner PID, and proof that the owner is gone. `ESRCH` is the only proof of absence — `EPERM` means the process exists under another user, and anything unreadable or unmarked is left alone. A stale directory wastes an inode; deleting a live one destroys an upload in flight, and PID reuse makes that a real possibility. Completed downloads are never inspected.

## Downloads are additive and never destructive

The caller never chooses the destination. The name is generated, creation is exclusive, and the result is returned only after the bytes are written and the handle closed — so a reported path always refers to a complete file. A failure part-way removes the partial output. Once committed the file is kept even if delivery later fails, because the user now owns it.

Repeating a download creates another distinct retained file. That local additive effect is why these tools carry non-read-only, non-idempotent annotations despite being ordinary TestRail GETs. No original filename or media type is invented; the driver returns only bytes, and contents never appear as inline base64.

## Verification

`tests/files.test.ts` uses disposable directories only. It covers:
- component-versus-prefix containment, traversal, symlink escape and symlink-within-root, and a root configured through a symlink;
- non-regular sources, source replacement after staging, a file replaced once it is open, a final component swapped for a symlink before the open, and a file that lies about its size;
- the exact size limit, and one byte over it refused before a staged copy is opened;
- a staged-name collision that leaves the existing file alone, a failed close, a failed, a short and a zero-progress write, and source-close counting on success and on each failure path;
- idempotent disposal;
- recovery's refusals: no prefix, no marker, the wrong marker, a corrupt marker, a live owner in another process, and a liveness check failing with `EPERM` or anything but `ESRCH`;
- a unique, exclusively created staging directory;
- downloads: a forced name collision, 25 concurrent writes, exact byte counts for multi-byte text and large binary content, the exact size limit, and cleanup on write and close failure.

Each test starts from the real `node:fs/promises`, since a module spy's fake is reset between tests.

Mutation-checked: string-prefix containment, skipping `realpath`, forwarding the source path instead of copying, trusting the initial size, opening downloads with `w` instead of `wx`, and ignoring the ownership marker each fail a test. The F07 acceptance audit added more, listed in its PR.

`tests/transport/file-lifetime.test.ts` proves that the registered tools actually route through this layer. `testrail_add_attachment_to_case` refuses a `../` traversal and a symlink escaping its root with `FILE_ACCESS_DENIED` and `write_outcome: "not_started"`, before any DNS lookup or request, and follows a symlink that stays inside a root, sending the target's content. A `testrail_get_attachment` download survives runtime shutdown and staging disposal. The packaged executable, pointed at a local stand-in for TestRail, keeps a download through stdin-closure shutdown and a restart. The restart's recovery removes an abandoned staging directory whose owner is provably gone, and a new download creates a second distinct file. Mutation-checked: dropping the root comparison, refusing every symlink, writing downloads into the staging area, deleting downloads on shutdown and skipping startup recovery each fail it.

Security review added two more that now fail: removing `O_NONBLOCK`, and removing the explicit regular-file guard. The second had previously been uncatchable — the only non-regular case tested was a directory, and reading a directory throws `EISDIR` on its own, producing the same refusal the test asserted. The guard could have been deleted with the suite still green. A pipe case closes that.

One of those mutations exposed a flaw in the tests themselves. The symlink-escape case originally survived removal of `realpath`, because on macOS the unresolved candidate failed to match the resolved root — it rejected for the wrong reason. The fixture now resolves its base directory, so the symlink is the only variable and the test fails when the protection is removed.
