import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterError } from '../contracts/errors.js';
import { containedRealPath } from './containment.js';

const DIRECTORY_PREFIX = 'testrail-mcp-staging-';
const OWNER_FILE = 'owner.json';
const MARKER = 'testrail-mcp-staging';
const COPY_CHUNK = 64 * 1024;

export interface StagingArea {
  readonly directory: string;
  readonly dispose: () => Promise<void>;
}

export interface StagedUpload {
  /** Give the driver a path, never an adapter-owned descriptor. */
  readonly path: string;
  readonly bytes: number;
  readonly dispose: () => Promise<void>;
}

/** Idempotent removal: cleanup runs on success, failure and settlement alike. */
function onceRemove(target: string): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  };
}

/**
 * Removal of one staged copy, emptied first.
 *
 * Disposal runs only once nothing should still read the copy. But after a request body
 * is abandoned mid-read, Node's file-backed Blob inside the driver keeps a descriptor on
 * the copy until garbage collection, and an unlinked file keeps its blocks while any
 * descriptor is open. Emptying it first means that descriptor holds no data. The staging
 * area itself is only ever removed, never emptied: shutdown can remove it while an
 * upload is still reading its copy.
 */
function onceDiscard(target: string): () => Promise<void> {
  const remove = onceRemove(target);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await truncate(target, 0).catch(() => undefined);
    await remove();
  };
}

export async function createStagingArea(parent: string): Promise<StagingArea> {
  const directory = join(parent, `${DIRECTORY_PREFIX}${process.pid}-${randomUUID()}`);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  // The marker identifies this directory as ours and records who owns it, so a later
  // process can tell an abandoned directory from one still in use.
  await writeFile(
    join(directory, OWNER_FILE),
    JSON.stringify({ marker: MARKER, pid: process.pid }),
    { mode: 0o600 },
  );
  return Object.freeze({ directory, dispose: onceRemove(directory) });
}

/**
 * Copy a validated source file into the staging area and return its staged path.
 *
 * The copy is the point. Validating a path and then handing that path to the driver
 * would leave a window in which the source is replaced between the two, so the bytes
 * sent need not be the bytes approved. Copying through a handle opened at validation
 * time binds the approval to the content.
 *
 * The size limit is enforced while copying rather than from the initial stat, because
 * a file may grow after it is measured. The signal is checked before anything is opened
 * and before each chunk, so an abandoned call stops copying and leaves nothing staged.
 */
export async function stageUpload(
  source: string,
  options: {
    readonly roots: readonly string[];
    readonly maxBytes: number;
    readonly stagingDirectory: string;
    /** Aborted once the call is abandoned: the copy stops before its next chunk. */
    readonly signal?: AbortSignal;
  },
): Promise<StagedUpload> {
  const stopIfAbandoned = (): void => {
    if (options.signal?.aborted === true) throw new AdapterError('CANCELLED');
  };
  // A call already abandoned opens and creates nothing.
  stopIfAbandoned();
  const resolved = await containedRealPath(source, options.roots);

  /*
   * O_NOFOLLOW guards the final component against a symlink swapped in after the
   * realpath above. It is unavailable on Windows, where only containment and the inode
   * check below apply.
   *
   * O_NONBLOCK is what makes the regular-file check below reachable. Opening a FIFO
   * for reading blocks until a writer connects, and that happens before anything can
   * observe the file type, so a caller naming a pipe inside an allowed root would hold
   * a libuv worker forever. Four such calls exhaust the default threadpool and stall
   * every other async operation in the process. It is a no-op for regular files.
   */
  const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(resolved, readFlags).catch(() => {
    throw new AdapterError('FILE_ACCESS_DENIED');
  });

  let closed = false;
  const closeSource = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };

  const target = join(options.stagingDirectory, randomUUID());
  // Armed only once the exclusive create below has made the target ours. A name that
  // already exists belongs to someone else, and removing it on the way out would
  // delete a file this call never created.
  let disposeTarget: () => Promise<void> = () => Promise.resolve();

  try {
    // Inspect the handle rather than the path: this is the file actually opened. Read as
    // BigInt because a file ID is 64 bits: a Windows (NTFS) ID routinely exceeds 2^53,
    // and as a number two different IDs can round to the same value.
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new AdapterError('FILE_ACCESS_DENIED');
    if (opened.size > BigInt(options.maxBytes)) throw new AdapterError('FILE_TOO_LARGE');

    // Where the platform reports an inode, confirm the path still names the file the
    // handle holds. The check is skipped only when the inode reads as zero.
    if (opened.ino !== 0n) {
      const named = await lstat(resolved, { bigint: true }).catch(() => null);
      if (named === null || named.ino !== opened.ino || named.dev !== opened.dev) {
        throw new AdapterError('FILE_ACCESS_DENIED');
      }
    }

    const staged = await open(target, 'wx', 0o600);
    disposeTarget = onceDiscard(target);
    let bytes = 0;
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK);
      for (;;) {
        // The partial copy is closed and removed by the catches below.
        stopIfAbandoned();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > options.maxBytes) throw new AdapterError('FILE_TOO_LARGE');
        // A write may accept less than it was given; loop until the chunk is all written.
        for (let offset = 0; offset < bytesRead;) {
          const { bytesWritten } = await staged.write(buffer, offset, bytesRead - offset);
          // A write that makes no progress would loop forever; treat it as a failure.
          if (bytesWritten <= 0) throw new AdapterError('FILE_ACCESS_DENIED');
          offset += bytesWritten;
        }
      }
    } catch (error) {
      await staged.close().catch(() => undefined);
      throw error;
    }
    // Closed on success where a failure can still be seen: a write error some
    // filesystems (NFS, for one) report only at close surfaces here, and a copy that
    // failed must not be uploaded. Close is not fsync; durability is not the aim.
    await staged.close();

    await closeSource();
    return Object.freeze({ path: target, bytes, dispose: disposeTarget });
  } catch (error) {
    await closeSource();
    await disposeTarget();
    throw error instanceof AdapterError ? error : new AdapterError('FILE_ACCESS_DENIED');
  }
}

/** Alive, or cannot be proven otherwise. Uncertainty always counts as alive. */
function ownerPresent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof of absence. EPERM means the process exists under
    // another user, and anything else is unknown; both are treated as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove staging directories this server left behind, and nothing else.
 *
 * Deletion requires positive evidence: our marker, a recorded owner, and proof that
 * the owner is gone. Anything unreadable, unmarked, or owned by a process that might
 * still exist is left alone. A stale directory is a wasted inode; deleting a live
 * one destroys an upload in flight, and a reused PID makes that a real possibility.
 *
 * Completed downloads are never inspected: they live in a different directory and
 * belong to the user.
 */
export async function recoverAbandonedStaging(parent: string): Promise<number> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
    const directory = join(parent, entry.name);
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(join(directory, OWNER_FILE), 'utf8'));
    } catch {
      continue; // No readable marker: not provably ours, so not ours to delete.
    }
    if (
      owner === null || typeof owner !== 'object' ||
      (owner as { marker?: unknown }).marker !== MARKER
    ) continue;
    const pid = (owner as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || ownerPresent(pid)) continue;
    try {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue; // A permission error is not a reason to try harder.
    }
  }
  return removed;
}
