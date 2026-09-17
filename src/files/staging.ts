import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 * a file may grow after it is measured.
 */
export async function stageUpload(
  source: string,
  options: {
    readonly roots: readonly string[];
    readonly maxBytes: number;
    readonly stagingDirectory: string;
  },
): Promise<StagedUpload> {
  const resolved = await containedRealPath(source, options.roots);

  /*
   * O_NOFOLLOW guards the final component against a symlink swapped in after the
   * realpath above; it is unavailable on Windows, where containment carries the check.
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
  const disposeTarget = onceRemove(target);

  try {
    // Inspect the handle rather than the path: this is the file actually opened.
    const opened = await handle.stat();
    if (!opened.isFile()) throw new AdapterError('FILE_ACCESS_DENIED');
    if (opened.size > options.maxBytes) throw new AdapterError('FILE_TOO_LARGE');

    // Where inode identity is meaningful, confirm the path still names the file the
    // handle holds. Windows reports no usable inode, so this is skipped there.
    if (opened.ino !== 0) {
      const named = await lstat(resolved).catch(() => null);
      if (named === null || named.ino !== opened.ino || named.dev !== opened.dev) {
        throw new AdapterError('FILE_ACCESS_DENIED');
      }
    }

    const staged = await open(target, 'wx', 0o600);
    let bytes = 0;
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > options.maxBytes) throw new AdapterError('FILE_TOO_LARGE');
        await staged.write(buffer, 0, bytesRead);
      }
    } finally {
      await staged.close().catch(() => undefined);
    }

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
