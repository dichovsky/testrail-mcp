import { mkdtemp, mkdir, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ESM exports are not configurable, so the module is spied as a whole and the real
// implementation is imported separately for the wrappers below.
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:crypto', { spy: true });
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const run = promisify(execFile);
import { containedRealPath, isWithin } from '../src/files/containment.js';
import { writeDownload } from '../src/files/download.js';
import { createStagingArea, recoverAbandonedStaging, stageUpload } from '../src/files/staging.js';

let base: string;
let root: string;
let outside: string;
let staging: string;
let downloads: string;

beforeAll(async () => {
  // Disposable directories only; never a configured TestRail path.
  // Resolve the base immediately. On macOS the temporary directory is itself a
  // symlink, and an unresolved root would make containment tests pass because the
  // root and candidate disagree rather than because the rule under test works.
  base = await actual.realpath(await mkdtemp(join(tmpdir(), 'testrail-mcp-files-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  staging = join(base, 'staging');
  downloads = join(base, 'downloads');
  for (const directory of [root, outside, staging, downloads]) await mkdir(directory);
});

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks leaves a module spy's implementation in place, so a fake from one
  // test would otherwise leak into the next and change what that test exercises.
  // resetAllMocks returns every spied export of both mocked modules to the real one.
  vi.resetAllMocks();
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

async function source(name: string, content: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

describe('containment', () => {
  it('compares path components rather than string prefixes', () => {
    expect(isWithin('/data/root', '/data/root')).toBe(true);
    expect(isWithin('/data/root', '/data/root/file')).toBe(true);
    // The classic prefix bug: a sibling directory whose name merely starts the same.
    expect(isWithin('/data/root', '/data/rootsomething')).toBe(false);
    expect(isWithin('/data/root', '/data')).toBe(false);
    expect(isWithin('/data/root', '/data/root/../elsewhere')).toBe(false);
  });

  it('accepts a real file inside a root, at any depth, and returns its real path', async () => {
    const nested = join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'deep.txt'), 'x');
    // The resolved path is returned, not the one supplied: callers act on the real file.
    // On macOS the temporary root itself lives behind a symlink, so these differ.
    await expect(containedRealPath(join(nested, 'deep.txt'), [root]))
      .resolves.toBe(await actual.realpath(join(nested, 'deep.txt')));
  });

  it('rejects traversal out of a root', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await expect(containedRealPath(join(root, '..', 'outside', 'secret.txt'), [root])).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
  });

  it('rejects a symlink inside a root whose target escapes it', async () => {
    const secret = join(outside, 'target.txt');
    await writeFile(secret, 'secret');
    const link = join(root, 'escape-link');
    await symlink(secret, link);
    // Judged on the real destination, not the name used to reach it.
    await expect(containedRealPath(link, [root])).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
  });

  it('accepts a symlink whose target stays inside a root', async () => {
    const inside = await source('linked-target.txt', 'fine');
    const link = join(root, 'inside-link');
    await symlink(inside, link);
    await expect(containedRealPath(link, [root])).resolves.toBe(await actual.realpath(inside));
  });

  it('rejects relative, empty and missing paths without distinguishing them', async () => {
    for (const candidate of ['', 'relative/path.txt', join(root, 'does-not-exist.txt')]) {
      await expect(containedRealPath(candidate, [root])).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    }
  });

  it('rejects everything when no root is configured', async () => {
    const path = await source('no-roots.txt', 'x');
    await expect(containedRealPath(path, [])).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
  });
});

describe('upload staging', () => {
  it('copies the approved bytes into a private file the caller cannot name', async () => {
    const area = await createStagingArea(staging);
    const path = await source('upload.txt', 'approved content');
    const staged = await stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory });

    expect(staged.bytes).toBe(16);
    expect(await readFile(staged.path, 'utf8')).toBe('approved content');
    expect(staged.path.startsWith(area.directory)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
      expect((await stat(area.directory)).mode & 0o777).toBe(0o700);
    }
    await area.dispose();
  });

  it('keeps the approved bytes when the source is replaced after staging', async () => {
    const area = await createStagingArea(staging);
    const path = await source('swapped.txt', 'original');
    const staged = await stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory });

    // This is the reason staging copies rather than forwarding the path.
    await writeFile(path, 'substituted after approval');
    expect(await readFile(staged.path, 'utf8')).toBe('original');
    await area.dispose();
  });

  it('enforces the byte limit while copying, not only from the initial size', async () => {
    const area = await createStagingArea(staging);
    const path = await source('grower.txt', 'x'.repeat(100));

    // A file may grow between being measured and being read, so a stat-only check
    // can be beaten. Report a small size while the handle yields more.
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalStat = handle.stat.bind(handle);
      handle.stat = (async () => Object.assign(await originalStat(), { size: 10 })) as typeof handle.stat;
      return handle;
    });

    await expect(stageUpload(path, { roots: [root], maxBytes: 50, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await area.dispose();
  });

  it('rejects an oversized file by its measured size', async () => {
    const area = await createStagingArea(staging);
    const path = await source('big.txt', 'x'.repeat(500));
    vi.mocked(open).mockClear();
    await expect(stageUpload(path, { roots: [root], maxBytes: 100, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    // Refused before a staged copy is opened, not by the copy loop.
    expect(vi.mocked(open).mock.calls).toHaveLength(1);
    await area.dispose();
  });

  it('rejects a directory and other non-regular sources', async () => {
    const area = await createStagingArea(staging);
    const directory = join(root, 'a-directory');
    await mkdir(directory, { recursive: true });
    await expect(stageUpload(directory, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    await area.dispose();
  });

  it.skipIf(process.platform === 'win32')('rejects a pipe without waiting for a writer', async () => {
    const area = await createStagingArea(staging);
    const pipe = join(root, 'a-pipe');
    await run('mkfifo', [pipe]);

    // Opening a FIFO for reading blocks until a writer connects. Without a
    // non-blocking open this call never returns, the regular-file check below is
    // never reached, and the call holds a libuv worker forever.
    const started = Date.now();
    await expect(stageUpload(pipe, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await area.dispose();
  }, 10_000);

  it('rejects a source outside the roots before opening anything', async () => {
    const area = await createStagingArea(staging);
    const secret = join(outside, 'not-allowed.txt');
    await writeFile(secret, 'secret');
    await expect(stageUpload(secret, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it('leaves no staged file behind when staging fails', async () => {
    const area = await createStagingArea(staging);
    const path = await source('fails.txt', 'x'.repeat(500));
    await expect(stageUpload(path, { roots: [root], maxBytes: 100, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it('closes each adapter-owned source handle exactly once', async () => {
    const area = await createStagingArea(staging);
    const path = await source('handles.txt', 'content');
    const closes: number[] = [];
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const index = closes.push(0) - 1;
      const originalClose = handle.close.bind(handle);
      handle.close = async () => { closes[index] = (closes[index] ?? 0) + 1; return originalClose(); };
      return handle;
    });

    const staged = await stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory });
    expect(staged.bytes).toBe(7);
    // Both the source and the staged target are opened, and each is closed once.
    expect(closes).toEqual([1, 1]);
    await area.dispose();
  });

  it('disposes the staged file idempotently', async () => {
    const area = await createStagingArea(staging);
    const path = await source('dispose.txt', 'bye');
    const staged = await stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory });

    await staged.dispose();
    await expect(stat(staged.path)).rejects.toThrow();
    await expect(staged.dispose()).resolves.toBeUndefined();
    await area.dispose();
  });

  it('accepts a file of exactly the limit and refuses one byte more, before opening a staged copy', async () => {
    const area = await createStagingArea(staging);
    const exact = await stageUpload(await source('exact.txt', 'x'.repeat(64)), { roots: [root], maxBytes: 64, stagingDirectory: area.directory });
    expect(exact.bytes).toBe(64);
    vi.mocked(open).mockClear();
    await expect(stageUpload(await source('over.txt', 'x'.repeat(65)), { roots: [root], maxBytes: 64, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    // Refused by its measured size: only the source was opened, never a staged copy.
    expect(vi.mocked(open).mock.calls).toHaveLength(1);
    expect((await readdir(area.directory)).sort()).toEqual(['owner.json', exact.path.slice(area.directory.length + 1)].sort());
    await area.dispose();
  });

  it('accepts a root configured through a symlink', async () => {
    const area = await createStagingArea(staging);
    const linkedRoot = join(base, 'linked-root');
    await symlink(root, linkedRoot, 'dir');
    const staged = await stageUpload(await source('via-link.txt', 'linked'), { roots: [linkedRoot], maxBytes: 1_024, stagingDirectory: area.directory });
    expect(await readFile(staged.path, 'utf8')).toBe('linked');
    await area.dispose();
  });

  it('never removes an existing file its staged name happens to collide with', async () => {
    const area = await createStagingArea(staging);
    const taken = '00000000-0000-4000-8000-000000000000';
    await writeFile(join(area.directory, taken), 'someone else');
    vi.mocked(randomUUID).mockReturnValueOnce(taken);
    await expect(stageUpload(await source('collides.txt', 'mine'), { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readFile(join(area.directory, taken), 'utf8')).toBe('someone else');
    await area.dispose();
  });

  it('refuses a copy whose close fails, and leaves nothing staged', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 2) {
        // The staged copy: a deferred write error surfaces only at close.
        const originalClose = handle.close.bind(handle);
        handle.close = async () => { await originalClose(); throw new Error('EIO'); };
      }
      return handle;
    });
    await expect(stageUpload(await source('close-fails.txt', 'content'), { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it('removes a partly written copy when a write fails mid-copy', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 2) {
        const originalWrite = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        let writes = 0;
        handle.write = (async (...a: unknown[]) => {
          writes += 1;
          if (writes === 2) throw new Error('ENOSPC');
          return originalWrite(...a);
        }) as typeof handle.write;
      }
      return handle;
    });
    // Two chunks of 64 KiB, so the second write fails after the first reached the disk.
    const path = await source('two-chunks.bin', 'y'.repeat(100 * 1024));
    await expect(stageUpload(path, { roots: [root], maxBytes: 1_024 * 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it('writes the whole chunk when a write accepts only part of it', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 2) {
        const originalWrite = handle.write.bind(handle) as (b: Buffer, o: number, l: number) => Promise<{ bytesWritten: number }>;
        // A short write: at most three bytes per call.
        handle.write = ((buffer: Buffer, offset: number, length: number) => originalWrite(buffer, offset, Math.min(length, 3))) as unknown as typeof handle.write;
      }
      return handle;
    });
    const staged = await stageUpload(await source('short-writes.txt', 'abcdefghij'), { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory });
    expect(await readFile(staged.path, 'utf8')).toBe('abcdefghij');
    await area.dispose();
  });

  it('refuses a copy whose write makes no progress, rather than looping', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      // Resolves on a later turn, so a loop that never ends still lets the timeout fire.
      if (opens === 2) handle.write = (() => new Promise((resolve) => { setImmediate(() => { resolve({ bytesWritten: 0, buffer: Buffer.alloc(0) }); }); })) as unknown as typeof handle.write;
      return handle;
    });
    await expect(stageUpload(await source('stuck.txt', 'content'), { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  }, 5_000);

  it('closes the source exactly once on each failure path', async () => {
    const area = await createStagingArea(staging);
    const closes: number[] = [];
    const counting = (sizeLie?: number) => vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const index = closes.push(0) - 1;
      const originalClose = handle.close.bind(handle);
      handle.close = async () => { closes[index] = (closes[index] ?? 0) + 1; return originalClose(); };
      if (sizeLie !== undefined && index === 0) {
        const originalStat = handle.stat.bind(handle);
        handle.stat = (async () => Object.assign(await originalStat(), { size: sizeLie })) as typeof handle.stat;
      }
      return handle;
    });
    // Refused by its measured size: only the source is open, and it is closed once.
    counting();
    await expect(stageUpload(await source('closes-big.txt', 'x'.repeat(200)), { roots: [root], maxBytes: 100, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(closes).toEqual([1]);
    // Grows past the limit while copying: the source and the staged copy, once each.
    closes.length = 0;
    counting(10);
    await expect(stageUpload(await source('closes-grows.txt', 'x'.repeat(200)), { roots: [root], maxBytes: 100, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(closes).toEqual([1, 1]);
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  /*
   * Every failure leaves through one catch, which closes the source; a failure during
   * the copy also closes the staged copy first. Counted per handle, in open order: the
   * source, then the staged copy if one was opened.
   */
  it.each([
    ['a staged-name collision', 'collision', [1]],
    ['a failed write', 'write', [1, 1]],
    ['a failed close of the copy', 'close', [1, 1]],
    ['a path that names another file once open', 'inode', [1]],
  ] as const)('closes each handle exactly once on %s', async (_label, fault, expected) => {
    const area = await createStagingArea(staging);
    const path = await source(`closes-${fault}.txt`, 'content');
    const closes: number[] = [];
    let swapped = false;
    if (fault === 'collision') {
      const taken = '33333333-3333-4333-8333-333333333333';
      await writeFile(join(area.directory, taken), 'someone else');
      vi.mocked(randomUUID).mockReturnValueOnce(taken);
    }
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const index = closes.push(0) - 1;
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        closes[index] = (closes[index] ?? 0) + 1;
        await originalClose();
        if (fault === 'close' && index === 1) throw new Error('EIO');
      };
      if (fault === 'write' && index === 1) handle.write = () => Promise.reject(new Error('ENOSPC'));
      if (fault === 'inode' && index === 0) {
        await writeFile(`${path}.new`, 'replacement');
        await rename(`${path}.new`, path);
        swapped = true;
      }
      return handle;
    });
    await expect(stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(closes).toEqual(expected);
    if (fault === 'inode') expect(swapped).toBe(true);
    await area.dispose();
  });

  it('refuses a source whose path names another file once it is open', async () => {
    const area = await createStagingArea(staging);
    const path = await source('replaced.txt', 'opened');
    const replacement = await source('replacement.txt', 'replacement');
    let swapped = false;
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      // Replace the file after it is opened: the handle and the path now disagree.
      await rename(replacement, path);
      swapped = true;
      return handle;
    });
    await expect(stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    // A fixture failure inside open would also surface as FILE_ACCESS_DENIED.
    expect(swapped).toBe(true);
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it.skipIf(process.platform === 'win32')('refuses a final component swapped for a symlink before it is opened', async () => {
    const area = await createStagingArea(staging);
    const path = await source('swap-to-link.txt', 'inside');
    const secret = join(outside, 'swap-secret.txt');
    await writeFile(secret, 'OUTSIDE SECRET');
    let swapped = false;
    let refusedBy: string | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      // Between containment and open, the approved file becomes a link out of the root.
      await rm(path);
      await symlink(secret, path);
      swapped = true;
      return actual.open(...args).catch((error: unknown) => {
        refusedBy = (error as NodeJS.ErrnoException).code;
        throw error;
      });
    });
    await expect(stageUpload(path, { roots: [root], maxBytes: 1_024, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(swapped).toBe(true);
    // O_NOFOLLOW itself refused the link, before the inode check could.
    expect(refusedBy).toBe('ELOOP');
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });
});

const DEAD_PID = 2_147_483_647;

describe('abandoned staging recovery', () => {
  async function abandoned(parent: string, pid: number, name = `testrail-mcp-staging-${pid}-${Math.abs(pid)}`): Promise<string> {
    const directory = join(parent, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'owner.json'), JSON.stringify({ marker: 'testrail-mcp-staging', pid }));
    await writeFile(join(directory, 'leftover'), 'x');
    return directory;
  }

  it('removes only a directory whose recorded owner is provably gone', async () => {
    const parent = join(base, 'recovery-gone');
    await mkdir(parent);
    // 2^31 - 1: above any PID a supported platform hands out (Linux's pid_max tops out
    // at 2^22), so it cannot be running.
    const dead = await abandoned(parent, DEAD_PID);
    const alive = await abandoned(parent, process.pid, 'testrail-mcp-staging-self');

    expect(await recoverAbandonedStaging(parent)).toBe(1);
    await expect(stat(dead)).rejects.toThrow();
    await expect(stat(alive)).resolves.toBeDefined();
  });

  it('leaves anything it cannot prove is ours', async () => {
    const parent = join(base, 'recovery-foreign');
    await mkdir(parent);
    const unmarked = join(parent, 'testrail-mcp-staging-nomarker');
    await mkdir(unmarked);
    const wrongMarker = join(parent, 'testrail-mcp-staging-wrong');
    await mkdir(wrongMarker);
    await writeFile(join(wrongMarker, 'owner.json'), JSON.stringify({ marker: 'something-else', pid: DEAD_PID }));
    const corrupt = join(parent, 'testrail-mcp-staging-corrupt');
    await mkdir(corrupt);
    await writeFile(join(corrupt, 'owner.json'), 'not json');
    const unrelated = join(parent, 'someone-elses-directory');
    await mkdir(unrelated);

    expect(await recoverAbandonedStaging(parent)).toBe(0);
    for (const directory of [unmarked, wrongMarker, corrupt, unrelated]) {
      await expect(stat(directory)).resolves.toBeDefined();
    }
  });

  it('never removes staging owned by another live process, and removes it once that process is gone', async () => {
    const parent = join(base, 'recovery-live');
    await mkdir(parent);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => { child.once('exit', resolve); });
    try {
      if (child.pid === undefined) throw new Error('child did not start');
      const owned = await abandoned(parent, child.pid);
      expect(await recoverAbandonedStaging(parent)).toBe(0);
      await expect(stat(owned)).resolves.toBeDefined();
      child.kill();
      await exited;
      expect(await recoverAbandonedStaging(parent)).toBe(1);
      await expect(stat(owned)).rejects.toThrow();
    } finally {
      child.kill();
    }
  });

  it.each(['EPERM', 'EINVAL'])('counts an owner whose liveness check fails with %s as alive', async (code) => {
    const parent = join(base, `recovery-${code}`);
    await mkdir(parent);
    const directory = await abandoned(parent, DEAD_PID);
    // Only ESRCH proves absence; EPERM means it exists under another user, and anything
    // else is unknown.
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(await recoverAbandonedStaging(parent)).toBe(0);
    await expect(stat(directory)).resolves.toBeDefined();
  });

  it('ignores a directory without the staging prefix, even with a valid marker and a dead owner', async () => {
    const parent = join(base, 'recovery-prefix');
    await mkdir(parent);
    const lookalike = await abandoned(parent, DEAD_PID, 'user-project');
    expect(await recoverAbandonedStaging(parent)).toBe(0);
    await expect(stat(lookalike)).resolves.toBeDefined();
  });

  it('gives each process its own directory, created exclusively', async () => {
    const parent = join(base, 'staging-unique');
    await mkdir(parent);
    const [one, two] = await Promise.all([createStagingArea(parent), createStagingArea(parent)]);
    expect(one.directory).not.toBe(two.directory);
    // The same name twice must fail rather than share a directory.
    vi.mocked(randomUUID).mockReturnValue('11111111-1111-4111-8111-111111111111');
    const first = await createStagingArea(parent);
    await expect(createStagingArea(parent)).rejects.toThrow();
    for (const area of [one, two, first]) await area.dispose();
  });

  it('never inspects or removes completed downloads', async () => {
    const parent = join(base, 'recovery-downloads');
    await mkdir(parent);
    const completed = join(parent, 'completed.bin');
    await writeFile(completed, 'user data');
    await abandoned(parent, DEAD_PID);

    expect(await recoverAbandonedStaging(parent)).toBe(1);
    expect(await readFile(completed, 'utf8')).toBe('user data');
  });
});

describe('attachment downloads', () => {
  it('returns an absolute path only after the file is complete', async () => {
    const result = await writeDownload(new TextEncoder().encode('payload'), {
      directory: downloads, maxBytes: 1_024, attachmentId: 42,
    });
    expect(result.attachment_id).toBe(42);
    expect(result.bytes).toBe(7);
    expect(isAbsolute(result.file_path)).toBe(true);
    expect(await readFile(result.file_path, 'utf8')).toBe('payload');
    expect(result.file_path.endsWith('.bin')).toBe(true);
    // No original name or media type is invented: the driver returns only bytes.
    expect(Object.keys(result).sort()).toEqual(['attachment_id', 'bytes', 'file_path']);
  });

  it('creates a distinct retained file on every call', async () => {
    const first = await writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 });
    const second = await writeDownload(new Uint8Array([2]), { directory: downloads, maxBytes: 16, attachmentId: 1 });
    expect(first.file_path).not.toBe(second.file_path);
    await expect(stat(first.file_path)).resolves.toBeDefined();
  });

  it('creates exclusively so a download can never overwrite an existing file', async () => {
    vi.mocked(open).mockClear();
    await writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 });
    expect(vi.mocked(open).mock.calls.map((call) => call[1])).toEqual(['wx']);
  });

  it('never overwrites a file its generated name collides with', async () => {
    const directory = join(base, 'download-collision');
    await mkdir(directory);
    const taken = '22222222-2222-4222-8222-222222222222';
    await writeFile(join(directory, `${taken}.bin`), 'original');
    vi.mocked(randomUUID).mockReturnValueOnce(taken);
    await expect(writeDownload(new Uint8Array([1, 2]), { directory, maxBytes: 16, attachmentId: 1 }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readFile(join(directory, `${taken}.bin`), 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual([`${taken}.bin`]);
  });

  it('writes concurrent downloads to distinct, intact files', async () => {
    const directory = join(base, 'download-concurrent');
    await mkdir(directory);
    const results = await Promise.all(Array.from({ length: 25 }, (_value, index) =>
      writeDownload(new TextEncoder().encode(`content-${index}`), { directory, maxBytes: 64, attachmentId: index })));
    expect(new Set(results.map(({ file_path: path }) => path)).size).toBe(25);
    for (const [index, result] of results.entries()) expect(await readFile(result.file_path, 'utf8')).toBe(`content-${index}`);
  });

  it('reports the exact byte count, for multi-byte text and large binary content', async () => {
    const text = await writeDownload(new TextEncoder().encode('é✓'), { directory: downloads, maxBytes: 16, attachmentId: 1 });
    expect(text.bytes).toBe(5);
    const binary = new Uint8Array(200_003).map((_value, index) => (index * 7919) % 256);
    const large = await writeDownload(binary, { directory: downloads, maxBytes: 1_000_000, attachmentId: 2 });
    expect(large.bytes).toBe(200_003);
    expect((await stat(large.file_path)).size).toBe(200_003);
    expect(Buffer.compare(await readFile(large.file_path), Buffer.from(binary))).toBe(0);
  });

  it('accepts content of exactly the limit and refuses one byte more', async () => {
    await expect(writeDownload(new Uint8Array(100), { directory: downloads, maxBytes: 100, attachmentId: 1 })).resolves.toMatchObject({ bytes: 100 });
    await expect(writeDownload(new Uint8Array(101), { directory: downloads, maxBytes: 100, attachmentId: 1 }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rejects content over the configured file limit', async () => {
    await expect(writeDownload(new Uint8Array(200), { directory: downloads, maxBytes: 100, attachmentId: 1 }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('removes incomplete output when the write fails', async () => {
    const before = await readdir(downloads);
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      handle.writeFile = (() => Promise.reject(new Error('disk full'))) as typeof handle.writeFile;
      return handle;
    });
    await expect(writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 }))
      .rejects.toThrow();
    vi.restoreAllMocks();
    expect(await readdir(downloads)).toEqual(before);
  });

  it('removes incomplete output when the close fails', async () => {
    const before = await readdir(downloads);
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalClose = handle.close.bind(handle);
      let first = true;
      handle.close = async () => {
        if (first) { first = false; await originalClose(); throw new Error('close failed'); }
      };
      return handle;
    });
    await expect(writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 }))
      .rejects.toThrow();
    vi.restoreAllMocks();
    expect(await readdir(downloads)).toEqual(before);
  });
});
