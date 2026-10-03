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

The size limit is enforced **while copying**, not from the initial `stat`, because a file can grow after it is measured. The staged copy is created exclusively with restrictive permissions inside a private per-process directory. Those permissions are POSIX modes: `0600` for the copy and `0700` for the directory. On Windows, Node sets no ACL and the modes have no effect, so a staged copy is as private as the temporary directory it is made in. That directory is per-user by default; if `TMP` or `TEMP` points at a directory other local users can read, they can read staged copies too. The adapter sets no ACL of its own. If its generated name already exists the copy is refused, and the existing file is left alone: cleanup is armed only once the exclusive create has made the name ours. The copy is closed before it is handed over, and a failed close refuses it, since a deferred write error means the bytes may not have reached the disk. The driver receives a path — never an adapter-owned descriptor, whose ownership is hard to guarantee across early DNS failures and platform fallbacks.

Where inode identity is meaningful, the opened handle is checked against the path it came from after opening, so a file replaced once it is open is caught. Identities are compared exactly, as 64-bit values: a Windows (NTFS) file ID routinely exceeds 2^53, where a JavaScript number would round two different files to the same identity. `O_NOFOLLOW` refuses a final component swapped for a symlink before the open (the open fails with `ELOOP`), where the platform provides the flag. Neither closes every window. A regular file swapped in between resolution and open is read, and so is an intermediate directory replaced by a symlink, because `O_NOFOLLOW` guards only the last component. Those are races a process running as the same user would have to win, which this layer does not claim to prevent; such a process could as easily copy any file it can read into a root. On Windows the flag does not exist: the open follows a swapped-in link, and the identity check is what refuses it. That check runs only if the platform reports a file ID.

The source is opened non-blocking, and that is what makes the regular-file check reachable at all. Opening a FIFO for reading blocks until a writer connects — before anything can observe the file type — so a caller naming a pipe inside an allowed root would hold a libuv worker indefinitely. Four such calls exhaust the default threadpool and stall every other async operation in the process, not merely this tool. A named pipe is an ordinary artifact that can sit innocently under a directory an operator points a root at, so this needs no hostile local process. `O_NONBLOCK` is a no-op for regular files, so nothing else changes.

## Staging runs inside the call's slot

The runtime admits an upload before anything is staged, then stages the file and calls the driver within the same tracked operation. Staging is therefore bounded like the request it precedes: by the four-call slot limit, the fixed 60-second response watchdog and the caller's cancellation. A call refused as `BUSY`, or cancelled before admission, copies nothing. One consequence of that order: on a server whose slots are all busy, an upload whose file would be refused is answered `BUSY` before its path is checked, rather than `FILE_ACCESS_DENIED`.

When the watchdog ends the wait while the file is still being copied, the caller is answered at once with `TIMEOUT` and `write_outcome: "not_started"`. When the caller's cancellation ends it, the call ends at once with `CANCELLED` and `not_started`, which the `tool_call` diagnostic records; the SDK suppresses the response, so a client that cancelled through `notifications/cancelled` receives nothing for that call, as for any cancelled call (see [stdio transport](transport.md)). Either way, the copy stops before its next 64 KiB chunk and is removed, and nothing is sent afterwards, even if the copy had just finished. The slot is held until the copy has stopped. A filesystem call that never returns, such as a read on a hung network mount, holds its slot until it returns, because Node cannot interrupt it.

Once the request has been dispatched, a staged copy outlives cancellation and the response watchdog until the driver settles, because the request may still be reading it. Settlement cleanup is its only disposer. Shutdown is the exception: once the 5-second drain gives up, the staging area is removed even if an upload has still not settled. This is deliberate. The process exits 250 ms later. On POSIX, removing a file does not disturb a request body already reading it. A copy still being made at that point is never sent, because by then the client has been destroyed and the driver refuses new requests.

Disposing of a copy empties it before removing it. After a request body is abandoned part-way through, Node's file-backed Blob inside the driver keeps a descriptor on the copy until garbage collection, and an unlinked file keeps its blocks while any descriptor is open. On a memory-backed `/tmp` that would be up to `max_file_bytes` of memory per abandoned upload, for as long as an idle server goes without a collection. Emptied first, the lingering descriptor holds no data. The descriptor itself belongs to Node and the driver, not to this layer, and closes only at garbage collection. That was measured on Linux with Node 22.22.2 and 24.21.0 by reading a Blob from `openAsBlob` part-way and cancelling it: one descriptor stays open after cancellation and after unlinking, and none after a forced collection. The staging area at shutdown is only removed, never emptied, since an upload may still be reading its copy then.

## Recovery deletes only what it can prove

An abandoned staging directory is removed only with positive evidence: the staging name prefix, our marker, a recorded owner PID, and proof that the owner is gone. `ESRCH` is the only proof of absence — `EPERM` means the process exists under another user, and anything unreadable or unmarked is left alone. A stale directory wastes an inode; deleting a live one destroys an upload in flight, and PID reuse makes that a real possibility. Completed downloads are never inspected.

## Downloads are additive and never destructive

The caller never chooses the destination. The name is generated, creation is exclusive, and the result is returned only after the bytes are written and the handle closed — so a reported path always refers to a complete file. A failure part-way removes the partial output. Once committed the file is kept even if delivery later fails, because the user now owns it.

Repeating a download creates another distinct retained file. That local additive effect is why these tools carry non-read-only, non-idempotent annotations despite being ordinary TestRail GETs. No original filename or media type is invented; the driver returns only bytes, and contents never appear as inline base64.

## Verification

`tests/files.test.ts` uses disposable directories only. It covers:
- component-versus-prefix containment, traversal, symlink escape and symlink-within-root, and a root configured through a symlink;
- non-regular sources, source replacement after staging, a file replaced once it is open, a final component swapped for a symlink before the open, file identities that differ only beyond 2^53, and a file that lies about its size;
- the exact size limit, and one byte over it refused before a staged copy is opened;
- a staged-name collision that leaves the existing file alone, a failed close, a failed, a short and a zero-progress write, and handle-close counting, per handle, on success and on each failure path. A final component swapped for a symlink is counted on every platform; on Windows it is the identity check that refuses it. The non-regular case is skipped on Windows, which cannot open a directory as a file, and so is the open-file replacement case, because Windows refuses to rename over a file that is open;
- a copy stopped by its signal before its next chunk, which closes both handles and leaves nothing staged, and a call already abandoned, which opens nothing;
- idempotent disposal, and a copy emptied before it is removed, so a descriptor still open on it holds no data;
- recovery's refusals: no prefix, no marker, the wrong marker, a corrupt marker, a live owner in another process, and a liveness check failing with `EPERM` or anything but `ESRCH`;
- a unique, exclusively created staging directory;
- downloads: a forced name collision, 25 concurrent writes, exact byte counts for multi-byte text and large binary content, the exact size limit, and cleanup on write and close failure.

Each test starts from the real `node:fs/promises` and `node:crypto`: every spied export is reset after each test, since a module spy's fake would otherwise leak into the next one. A fixture that replaces a handle's `stat` forwards its options, because staging asks for BigInt stats.

Three cases are POSIX-only by nature. The permission modes are checked only off Windows, where they have no effect (see above). The FIFO case is skipped on Windows, where a named pipe lives only under `\\.\pipe\` and cannot sit inside a directory root, so it does not apply there. The open-file replacement fixture renames over an open file, which Windows refuses.

Mutation-checked: string-prefix containment, skipping `realpath`, forwarding the source path instead of copying, trusting the initial size, opening downloads with `w` instead of `wx`, and ignoring the ownership marker each fail a test. The F07 acceptance audit added more, listed in its PR. F07's closing work added four that each fail a test here: dropping the abort check in the copy loop; dropping the one made before anything is opened; comparing file identities as numbers rather than BigInts; and removing a copy without emptying it. Removing `O_NOFOLLOW` now fails the new close-count case as well as the swap test.

`tests/transport/upload-staging.test.ts` drives `testrail_add_attachment_to_case` through the pipeline. With the source's first read paused, the watchdog is already running and the call holds a slot. When the watchdog fires, the caller gets `TIMEOUT` with `write_outcome: "not_started"`, and the slot stays held until the paused read returns. The copy then stops without reading another chunk, its own promise rejects `CANCELLED`, and no lookup or request is made. When the caller cancels just as the copy finishes, the pipeline returns `CANCELLED` with `not_started`, nothing is sent, and settlement disposes the finished copy. `tests/transport/tool-call.test.ts` shows a call refused as `BUSY` never asks for the staging area. Mutation-checked: staging before admission, setting `dispatched` before staging, not aborting the staging signal when the call answers, not passing that signal to staging, dropping the check after staging, leaving the caller's cancellation out of that signal, and dropping the settlement cleanup each fail one of these tests.

`tests/transport/file-lifetime.test.ts` proves that the registered tools actually route through this layer. `testrail_add_attachment_to_case` refuses a `../` traversal and a symlink escaping its root with `FILE_ACCESS_DENIED` and `write_outcome: "not_started"`, before any DNS lookup or request, and follows a symlink that stays inside a root, sending the target's content. A `testrail_get_attachment` download survives runtime shutdown and staging disposal. The packaged executable, pointed at a local stand-in for TestRail, keeps a download through stdin-closure shutdown and a restart. The restart's recovery removes an abandoned staging directory whose owner is provably gone, and a new download creates a second distinct file. Mutation-checked: dropping the root comparison, refusing every symlink, writing downloads into the staging area, deleting downloads on shutdown and skipping startup recovery each fail it.

Security review added two more that now fail: removing `O_NONBLOCK`, and removing the explicit regular-file guard. The second had previously been uncatchable — the only non-regular case tested was a directory, and reading a directory throws `EISDIR` on its own, producing the same refusal the test asserted. The guard could have been deleted with the suite still green. A pipe case closes that.

One of those mutations exposed a flaw in the tests themselves. The symlink-escape case originally survived removal of `realpath`, because on macOS the unresolved candidate failed to match the resolved root — it rejected for the wrong reason. The fixture now resolves its base directory, so the symlink is the only variable and the test fails when the protection is removed.
