# Local file layer

`src/files/` implements F07's filesystem algorithms: containment for caller-supplied upload paths, bounded staging copies, abandoned-staging recovery, and persistent attachment downloads. `src/execution/executor.ts` owns when these algorithms run and their lifetime alongside ordinary calls. Transport supplies neither staging directories nor per-call cleanup callbacks.

## What this layer is and is not

This layer bounds what the server will read and write on behalf of a caller. It is **not** isolation from a malicious process that runs as the same OS user. Do not describe it as isolation. Anything that user can do to the filesystem, a malicious process can still do while this server runs.

## Containment

A caller-supplied path must meet these conditions:

- It must be absolute.
- It must resolve.
- Its **resolved** location must lie inside a configured root.

`realpath` resolves the whole symlink chain. Thus, the server judges containment on the real destination rather than the name used to reach it. The server rejects a link inside a root that points outside one.

The server resolves roots too. A configured root can itself sit behind a symlink. The temporary directory of macOS is one example. Comparing a resolved candidate against an unresolved root would deny every legitimate file.

Containment compares **path components**, not string prefixes. `/data/rootsomething` begins with `/data/root` as a string but is a different directory. `path.relative` answers this question correctly on both platforms, including drive letters and case rules.

Missing, unreadable and out-of-root paths all produce the same refusal, because distinguishing them would leak filesystem layout.

## Why staging copies

Suppose the server validates a path and then hands that same path to the driver. A window then exists between the two steps. The source can be replaced in this window, so the bytes sent need not be the bytes approved. Staging opens a handle at validation time and copies through it. Staging thus binds the approval to the content.

The size limit is enforced **while copying**, not from the initial `stat`, because a file can grow after it is measured.

The staged copy is created exclusively with restrictive permissions inside a private per-process directory. Those permissions are POSIX modes: `0600` for the copy and `0700` for the directory. On Windows, Node sets no ACL, and the modes have no effect. Thus, a staged copy is as private as the temporary directory that it is made in.

That directory is per-user by default. If `TMP` or `TEMP` points at a directory that other local users can read, they can read staged copies too. The adapter sets no ACL of its own.

If its generated name already exists, the copy is refused, and the existing file is left alone. Cleanup is armed only once the exclusive create has made the name ours. The copy is closed before it is handed over. A failed close refuses the copy, since a deferred write error means the bytes may not have reached the disk.

The driver receives a path, never an adapter-owned descriptor. Ownership of such a descriptor is hard to guarantee across early DNS failures and platform fallbacks.

Where inode identity is meaningful, the opened handle is checked against the path it came from after opening. Thus, a file replaced once it is open is caught. Identities are compared exactly, as 64-bit values. A Windows (NTFS) file ID routinely exceeds 2^53. At that size, a JavaScript number would round two different files to the same identity.

`O_NOFOLLOW` refuses a final component swapped for a symlink before the open (the open fails with `ELOOP`), where the platform provides the flag. Neither closes every window. A regular file swapped in between resolution and open is read. So is an intermediate directory replaced by a symlink, because `O_NOFOLLOW` guards only the last component. Those are races that a process running as the same user would have to win. This layer does not claim to prevent these races. Such a process could as easily copy any file that it can read into a root.

On Windows, the flag does not exist. The open follows a swapped-in link, and the identity check is what refuses the swap. That check runs only if the platform reports a file ID.

Opening the source non-blocking is what makes the regular-file check reachable at all. Opening a FIFO for reading blocks until a writer connects. The block occurs before anything can observe the file type. Thus, a caller that names a pipe inside an allowed root would hold a libuv worker indefinitely. Four such calls exhaust the default threadpool and stall every other async operation in the process, not merely this tool.

A named pipe is an ordinary artifact that can sit innocently under a directory that an operator points a root at. Thus, this scenario needs no hostile local process. `O_NONBLOCK` is a no-op for regular files, so nothing else changes.

## Staging runs inside the call's slot

The executor validates input and configured list bounds before it asks its runtime to admit the call. For an admitted upload, the executor does these actions in order within the same tracked operation:

1. It lazily creates the shared staging area.
2. It stages the file.
3. It calls the driver.

Concurrent uploads share creation. A failed creation is forgotten, so a later upload can retry.

Staging is therefore bounded like the request that it precedes. These limits bound it:

- the four-call slot limit;
- the fixed 60-second response watchdog;
- the caller's cancellation.

A call refused as `BUSY`, or cancelled before admission, creates no staging area or copy. This order has one consequence. If all slots of a server are busy, the server answers `BUSY` to an upload whose file it would refuse. The server answers before it checks the path. Thus, the answer is `BUSY`, not `FILE_ACCESS_DENIED`.

Two events can end the wait while the file is still being copied:

- If the watchdog ends the wait, the server answers the caller at once with `TIMEOUT` and `write_outcome: "not_started"`.
- If the caller's cancellation ends the wait, the call ends at once with `CANCELLED` and `not_started`. The `tool_call` diagnostic records this outcome. The SDK suppresses the response. Thus, a client that cancelled through `notifications/cancelled` receives nothing for that call, as for any cancelled call (see [stdio transport](transport.md)).

In both cases, the copy stops before its next 64 KiB chunk and is removed. Nothing is sent afterwards, even if the copy had just finished. The call holds its slot until the copy has stopped. Node cannot interrupt a filesystem call. Thus, a filesystem call that never returns, such as a read on a hung network mount, holds its slot until it returns.

Once the request has been dispatched, a staged copy outlives cancellation and the response watchdog until the driver settles. The reason: the request may still be reading the copy. Settlement cleanup is the only disposer of the copy.

Shutdown is the exception. Once the 5-second drain gives up, the staging area is removed even if an upload has still not settled. This removal is deliberate. The process exits 250 ms later. On POSIX, removing a file does not disturb a request body that is already reading the file. A copy that is still being made at that point is never sent. By then, the driver client has been destroyed, and the driver refuses new requests.

Disposing of a copy empties it before removing it. After a request body is abandoned part-way through, Node's file-backed Blob inside the driver keeps a descriptor on the copy until garbage collection. An unlinked file keeps its blocks while any descriptor is open. On a memory-backed `/tmp`, an unemptied copy would hold up to `max_file_bytes` of memory per abandoned upload. The copy would hold this memory for as long as an idle server goes without a collection. Emptied first, the lingering descriptor holds no data. The descriptor itself belongs to Node and the driver, not to this layer, and closes only at garbage collection.

The descriptor behavior was measured on Linux with Node 22.22.2 and 24.21.0. The measurement read a Blob from `openAsBlob` part-way and cancelled it. One descriptor stays open after cancellation and after unlinking. No descriptor stays open after a forced collection. At shutdown, the server only removes the staging area and never empties it, since an upload may still be reading its copy then.

## Recovery deletes only what it can prove

At startup, the executor calls recovery before it constructs the shared driver. Recovery removes an abandoned staging directory only with positive evidence. The evidence is:

- the staging name prefix;
- our marker;
- a recorded owner PID;
- proof that the owner is gone.

`ESRCH` is the only proof of absence. `EPERM` means that the process exists under another user. Recovery leaves alone anything that is unreadable or unmarked. A stale directory wastes an inode. Deleting a live one destroys an upload in flight, and PID reuse makes such a deletion a real possibility. Recovery never inspects completed downloads.

## Downloads are additive and never destructive

The caller never chooses the destination. The server generates the name, and creation is exclusive. The server returns the result only after it writes the bytes and closes the handle. Thus, a reported path always refers to a complete file. A failure part-way removes the partial output.

Shutdown is the exception. A write that is still under way when the 5-second drain gives up can be cut short by the exit that follows. A write that is cut short leaves a partial file in the download directory that nothing reports as downloaded (see [invocation lifetime](runtime-lifetime.md#shutdown)).

Once the server commits the file, it keeps the file even if delivery later fails, because the user now owns the file.

Repeating a download creates another distinct retained file. That local additive effect is why these tools carry non-read-only, non-idempotent annotations despite being ordinary TestRail GETs. The server does not invent an original filename or media type. The driver returns only bytes. Contents never appear as inline base64.

## Verification

`tests/files.test.ts` uses disposable directories only. It covers:
- component-versus-prefix containment, traversal, symlink escape and symlink-within-root, and a root configured through a symlink;
- non-regular sources, source replacement after staging, a file replaced once it is open, a final component swapped for a symlink before the open, file identities that differ only beyond 2^53, and a file that lies about its size;
- the exact size limit, and one byte over it refused before a staged copy is opened;
- a staged-name collision that leaves the existing file alone, a failed close, a failed, a short and a zero-progress write, and handle-close counting, per handle, on success and on each failure path. A final component swapped for a symlink is counted on every platform. On Windows, the identity check is what refuses the swap. The non-regular case is skipped on Windows, because Windows cannot open a directory as a file. The open-file replacement case is skipped too, because Windows refuses to rename over a file that is open;
- a copy stopped by its signal before its next chunk, which closes both handles and leaves nothing staged, and a call already abandoned, which opens nothing;
- idempotent disposal, and a copy emptied before it is removed, so a descriptor still open on it holds no data;
- recovery's refusals: no prefix, no marker, the wrong marker, a corrupt marker, a live owner in another process, and a liveness check failing with `EPERM` or anything but `ESRCH`;
- a unique, exclusively created staging directory;
- downloads: a forced name collision, 25 concurrent writes, exact byte counts for multi-byte text and large binary content, the exact size limit, and cleanup on write and close failure.

Each test starts from the real `node:fs/promises` and `node:crypto`. Every spied export is reset after each test, since a module spy's fake would otherwise leak into the next test. A fixture that replaces a handle's `stat` forwards its options, because staging asks for BigInt stats.

Three cases are POSIX-only by nature:

- The permission modes are checked only off Windows, where they have no effect (see above).
- The FIFO case is skipped on Windows. There, a named pipe lives only under `\\.\pipe\` and cannot sit inside a directory root, so the case does not apply there.
- The open-file replacement fixture renames over an open file, which Windows refuses.

Mutation-checked. Each of these mutations fails a test:

- string-prefix containment;
- skipping `realpath`;
- forwarding the source path instead of copying;
- trusting the initial size;
- opening downloads with `w` instead of `wx`;
- ignoring the ownership marker.

The F07 acceptance audit added more mutations. Its PR lists them. F07's closing work added four mutations that each fail a test here:

- dropping the abort check in the copy loop;
- dropping the abort check that is made before anything is opened;
- comparing file identities as numbers rather than BigInts;
- removing a copy without emptying it.

Removing `O_NOFOLLOW` now fails the new close-count case as well as the swap test.

`tests/transport/upload-staging.test.ts` drives `testrail_add_attachment_to_case` through the pipeline. It tests these cases:

- The source's first read is paused. The watchdog is already running, and the call holds a slot. When the watchdog fires, the caller gets `TIMEOUT` with `write_outcome: "not_started"`. The slot stays held until the paused read returns. The copy then stops without reading another chunk. Its own promise rejects `CANCELLED`. The pipeline makes no lookup or request.
- The watchdog fires while a finished copy is still being closed, after the last per-chunk check of the copy. The caller gets `TIMEOUT` with `not_started`. The copy completes. The pipeline still makes no lookup or request. The check after staging stops the send through the call's own abandonment, with no caller signal involved.
- The caller cancels just as the copy finishes. The pipeline returns `CANCELLED` with `not_started`. Nothing is sent. Settlement disposes the finished copy.

`tests/transport/tool-call.test.ts` shows that a call refused as `BUSY` never asks for the staging area.

Mutation-checked. Each of these mutations fails one of these tests:

- staging before admission;
- setting `dispatched` before staging;
- not aborting the staging signal when the call answers;
- not passing that signal to staging;
- dropping the check after staging;
- narrowing that check to the caller's cancellation;
- leaving the caller's cancellation out of that signal;
- dropping the settlement cleanup.

`tests/transport/file-lifetime.test.ts` proves that the registered tools actually route through this layer. `testrail_add_attachment_to_case` refuses a `../` traversal. It also refuses a symlink that escapes its root. The refusals use `FILE_ACCESS_DENIED` and `write_outcome: "not_started"`, and they occur before any DNS lookup or request. The tool follows a symlink that stays inside a root, and it sends the content of the target. A `testrail_get_attachment` download survives runtime shutdown and staging disposal. The packaged executable, pointed at a local stand-in for TestRail, keeps a download through stdin-closure shutdown and a restart. The restart's recovery removes an abandoned staging directory whose owner is provably gone, and a new download creates a second distinct file. Mutation-checked. Each of these mutations fails it:

- dropping the root comparison;
- refusing every symlink;
- writing downloads into the staging area;
- deleting downloads on shutdown;
- skipping startup recovery.

Security review added two more mutations that now fail:

- removing `O_NONBLOCK`;
- removing the explicit regular-file guard.

The second mutation had previously been uncatchable. The only non-regular case tested was a directory. Reading a directory throws `EISDIR` on its own, and this produced the same refusal that the test asserted. The guard could have been deleted with the suite still green. A pipe case closes this gap.

One of those mutations exposed a flaw in the tests themselves. The symlink-escape case originally survived the removal of `realpath`. On macOS, the unresolved candidate failed to match the resolved root, so the case rejected for the wrong reason. The fixture now resolves its base directory, so the symlink is the only variable. Thus, the test fails when the protection is removed.
