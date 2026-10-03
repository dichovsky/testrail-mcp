import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The failure paths below are filesystem errors that cannot be provoked reliably on a
// real disk, so the modules are spied as a whole (ESM exports are not configurable) and
// the real implementations are used for everything that is not being made to fail.
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:crypto', { spy: true });
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
import { AdapterError } from '../src/contracts/errors.js';
import { containedRealPath } from '../src/files/containment.js';
import { writeDownload } from '../src/files/download.js';
import { createStagingArea, recoverAbandonedStaging, stageUpload } from '../src/files/staging.js';

type Handle = Awaited<ReturnType<typeof actual.open>>;
type Uuid = ReturnType<typeof randomUUID>;

// 2^31 - 1: above any PID a supported platform hands out, so it cannot be running.
const DEAD_PID = 2_147_483_647;

let base: string;
let root: string;
let staging: string;
let downloads: string;

beforeAll(async () => {
  // Disposable directories only, resolved up front: on macOS the temporary directory is
  // itself a symlink, and containment is judged on real paths.
  base = await actual.realpath(await mkdtemp(join(tmpdir(), 'testrail-mcp-files-cov-')));
  root = join(base, 'root');
  staging = join(base, 'staging');
  downloads = join(base, 'downloads');
  for (const directory of [root, staging, downloads]) await mkdir(directory);
});

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks leaves a module spy's fake in place; resetAllMocks returns every
  // spied export to the real implementation so no fake leaks into the next test.
  vi.resetAllMocks();
});
afterAll(async () => { await actual.rm(base, { recursive: true, force: true }); });

async function source(name: string, content: string): Promise<string> {
  const path = join(root, name);
  await actual.writeFile(path, content);
  return path;
}

/** Replace a handle's close with one that really closes, then reports failure. */
function failingClose(handle: Handle, message: string): void {
  const originalClose = handle.close.bind(handle);
  handle.close = async () => { await originalClose(); throw new Error(message); };
}

describe('containment', () => {
  it('skips a root that cannot be resolved and still matches a later one', async () => {
    const path = await source('later-root.txt', 'x');
    const missing = join(base, 'no-such-root');
    await expect(containedRealPath(path, [missing, root])).resolves.toBe(path);
  });

  it('denies a file when the only root that would contain it cannot be resolved', async () => {
    const path = await source('unresolvable-root.txt', 'x');
    vi.mocked(realpath).mockImplementation((async (target: string) => {
      // The candidate resolves; the root has vanished.
      if (target === root) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return actual.realpath(target);
    }) as typeof realpath);
    await expect(containedRealPath(path, [root])).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
  });

  it('never treats a path on another drive as inside a root (Windows path semantics)', async () => {
    // On POSIX `relative` never yields an absolute path; on Windows it does whenever the
    // two paths sit on different drives. Load the module against win32 path rules.
    vi.resetModules();
    vi.doMock('node:path', async () => {
      const path = await vi.importActual<typeof import('node:path')>('node:path');
      return { ...path.win32, default: path.win32 };
    });
    try {
      const { isWithin } = await import('../src/files/containment.js');
      expect(isWithin('C:\\data\\root', 'D:\\data\\root\\file.txt')).toBe(false);
      expect(isWithin('C:\\data\\root', 'C:\\data\\root\\file.txt')).toBe(true);
      // Drive letters and case are compared the way Windows compares them.
      expect(isWithin('C:\\data\\root', 'c:\\DATA\\Root\\file.txt')).toBe(true);
      expect(isWithin('C:\\data\\root', 'C:\\data\\rootsomething')).toBe(false);
    } finally {
      vi.doUnmock('node:path');
      vi.resetModules();
    }
  });
});

describe('attachment downloads', () => {
  it('refuses a generated name that would escape the directory, before creating anything', async () => {
    vi.mocked(randomUUID).mockReturnValueOnce('../escaped' as Uuid);
    vi.mocked(open).mockClear();
    await expect(writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 }))
      .rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(vi.mocked(open)).not.toHaveBeenCalled();
    expect(await readdir(base)).not.toContain('escaped.bin');
  });

  it('reports the original failure when cleanup fails too, rather than the cleanup error', async () => {
    const before = await readdir(downloads);
    let created = '';
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      created = String(args[0]);
      handle.writeFile = (() => Promise.reject(new Error('disk full'))) as typeof handle.writeFile;
      failingClose(handle, 'close failed');
      return handle;
    });
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    const failure = writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 });
    // Neither the close nor the unlink failure masks the write failure, and no driver or
    // filesystem text escapes: the caller sees the fixed internal error.
    await expect(failure).rejects.toBeInstanceOf(AdapterError);
    await expect(failure).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(vi.mocked(unlink)).toHaveBeenCalledWith(created);

    // The removal genuinely failed, so the partial file is still there; clean it up here.
    expect(await readdir(downloads)).toEqual([...before, created.slice(downloads.length + 1)].sort());
    await actual.unlink(created);
  });

  it('passes an adapter error raised while writing through unchanged, and removes the partial file', async () => {
    const before = await readdir(downloads);
    const raised = new AdapterError('CANCELLED');
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      handle.writeFile = (() => Promise.reject(raised)) as typeof handle.writeFile;
      return handle;
    });
    await expect(writeDownload(new Uint8Array([1]), { directory: downloads, maxBytes: 16, attachmentId: 1 }))
      .rejects.toBe(raised);
    expect(await readdir(downloads)).toEqual(before);
  });
  it('accepts an ArrayBuffer as well as a Uint8Array and writes its exact bytes', async () => {
    const buffer = new Uint8Array([0, 1, 254, 255]).buffer;
    const result = await writeDownload(buffer, { directory: downloads, maxBytes: 16, attachmentId: 'uuid-id' });
    expect(result).toMatchObject({ attachment_id: 'uuid-id', bytes: 4 });
    expect([...await readFile(result.file_path)]).toEqual([0, 1, 254, 255]);
  });
});

describe('staging area disposal', () => {
  it('removes the area once, however many times it is disposed', async () => {
    const area = await createStagingArea(staging);
    vi.mocked(rm).mockClear();
    await area.dispose();
    await area.dispose();
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    await expect(stat(area.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles quietly when removal fails, so cleanup never throws on the way out', async () => {
    const area = await createStagingArea(staging);
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(area.dispose()).resolves.toBeUndefined();
    // The failed removal left the directory in place.
    await expect(stat(area.directory)).resolves.toBeDefined();
    await actual.rm(area.directory, { recursive: true, force: true });
  });

  it('still removes a staged copy when emptying it first fails', async () => {
    const area = await createStagingArea(staging);
    const staged = await stageUpload(await source('truncate-fails.txt', 'content'), {
      roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
    });
    vi.mocked(truncate).mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(staged.dispose()).resolves.toBeUndefined();
    expect(vi.mocked(truncate)).toHaveBeenCalledWith(staged.path, 0);
    await expect(stat(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await area.dispose();
  });
});

describe('upload staging failure paths', () => {
  it('still returns a complete copy when closing the source fails', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    let sourceCloses = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 1) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => { sourceCloses += 1; await originalClose(); throw new Error('EIO'); };
      }
      return handle;
    });
    // The copy is complete and closed before the source is released, so a failure to
    // release a read-only handle does not invalidate it.
    const staged = await stageUpload(await source('source-close-fails.txt', 'approved'), {
      roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
    });
    expect(await readFile(staged.path, 'utf8')).toBe('approved');
    expect(sourceCloses).toBe(1);
    await area.dispose();
  });

  it('closes the source once and discards the copy when closing the source throws synchronously', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    let sourceCloses = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 1) {
        const originalClose = handle.close.bind(handle);
        // Not a rejected promise: an exception before close returns one. Release the
        // descriptor for real so the test does not leak it.
        handle.close = (() => {
          sourceCloses += 1;
          void originalClose();
          throw new Error('EBADF');
        });
      }
      return handle;
    });
    await expect(stageUpload(await source('source-close-throws.txt', 'approved'), {
      roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
    })).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(sourceCloses).toBe(1);
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it('refuses a source whose path can no longer be inspected once it is open', async () => {
    const area = await createStagingArea(staging);
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(open).mockClear();
    await expect(stageUpload(await source('lstat-fails.txt', 'x'), {
      roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
    })).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    // Refused before a staged copy was opened.
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });

  it('skips the path identity check where the platform reports no inode', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 1) {
        const originalStat = handle.stat.bind(handle) as (options?: { bigint?: boolean }) => Promise<object>;
        handle.stat = (async (options?: { bigint?: boolean }) =>
          Object.assign(await originalStat(options), { ino: options?.bigint === true ? 0n : 0 })) as typeof handle.stat;
      }
      return handle;
    });
    vi.mocked(lstat).mockClear();
    const staged = await stageUpload(await source('no-inode.txt', 'content'), {
      roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
    });
    // An inode of zero carries no identity, so there is nothing to compare it with.
    expect(vi.mocked(lstat)).not.toHaveBeenCalled();
    expect(await readFile(staged.path, 'utf8')).toBe('content');
    await area.dispose();
  });

  it('reports the write failure and removes the copy when closing the failed copy fails too', async () => {
    const area = await createStagingArea(staging);
    let opens = 0;
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opens += 1;
      if (opens === 2) {
        handle.write = (() => Promise.reject(new Error('ENOSPC')));
        failingClose(handle, 'EIO');
      }
      return handle;
    });
    await expect(stageUpload(await source('staged-close-fails.txt', 'content'), {
      roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
    })).rejects.toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(await readdir(area.directory)).toEqual(['owner.json']);
    await area.dispose();
  });
});

describe('upload staging without O_NOFOLLOW or O_NONBLOCK (Windows)', () => {
  it('opens the source read-only and still copies through the handle', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const reduced = { ...fs.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined };
      return { ...fs, constants: reduced, default: { ...fs, constants: reduced } };
    });
    try {
      const fresh = await import('../src/files/staging.js');
      // The instance the freshly loaded module imports, so its calls can be inspected.
      const fsp = await import('node:fs/promises');
      const area = await fresh.createStagingArea(staging);
      vi.mocked(fsp.open).mockClear();
      const staged = await fresh.stageUpload(await source('no-nofollow.txt', 'portable'), {
        roots: [root], maxBytes: 1_024, stagingDirectory: area.directory,
      });
      expect(vi.mocked(fsp.open).mock.calls[0]?.[1]).toBe(constants.O_RDONLY);
      expect(await readFile(staged.path, 'utf8')).toBe('portable');
      await area.dispose();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('abandoned staging recovery edge cases', () => {
  async function abandoned(parent: string, name: string, pid: unknown): Promise<string> {
    const directory = join(parent, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'owner.json'), JSON.stringify({ marker: 'testrail-mcp-staging', pid }));
    return directory;
  }

  it('finds nothing to remove when the parent cannot be listed', async () => {
    await expect(recoverAbandonedStaging(join(base, 'no-such-parent'))).resolves.toBe(0);
  });

  it('treats an owner PID that is not a positive safe integer as alive, without probing it', async () => {
    const parent = join(base, 'recovery-bad-pid');
    await mkdir(parent);
    const kill = vi.spyOn(process, 'kill');
    const directories = await Promise.all([
      abandoned(parent, 'testrail-mcp-staging-zero', 0),
      abandoned(parent, 'testrail-mcp-staging-negative', -1),
      abandoned(parent, 'testrail-mcp-staging-fraction', 1.5),
      abandoned(parent, 'testrail-mcp-staging-unsafe', 2 ** 53),
    ]);
    expect(await recoverAbandonedStaging(parent)).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    for (const directory of directories) await expect(stat(directory)).resolves.toBeDefined();
  });

  it('counts only directories actually removed, and carries on past one it cannot remove', async () => {
    const parent = join(base, 'recovery-rm-fails');
    await mkdir(parent);
    const first = await abandoned(parent, 'testrail-mcp-staging-dead-a', DEAD_PID);
    const second = await abandoned(parent, 'testrail-mcp-staging-dead-b', DEAD_PID);
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    expect(await recoverAbandonedStaging(parent)).toBe(1);
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(2);
    const remaining = await readdir(parent);
    expect(remaining).toHaveLength(1);
    expect([first, second].map((directory) => directory.slice(parent.length + 1))).toContain(remaining[0]);
  });
});
