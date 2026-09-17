import { mkdtemp, mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ESM exports are not configurable, so the module is spied as a whole and the real
// implementation is imported separately for the wrappers below.
vi.mock('node:fs/promises', { spy: true });
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
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

afterEach(() => { vi.restoreAllMocks(); });
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
    await expect(stageUpload(path, { roots: [root], maxBytes: 100, stagingDirectory: area.directory }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
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
});

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
    // PID 2^22 is above every platform maximum, so it cannot be running.
    const dead = await abandoned(parent, 4_194_303);
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
    await writeFile(join(wrongMarker, 'owner.json'), JSON.stringify({ marker: 'something-else', pid: 4_194_303 }));
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

  it('never inspects or removes completed downloads', async () => {
    const parent = join(base, 'recovery-downloads');
    await mkdir(parent);
    const completed = join(parent, 'completed.bin');
    await writeFile(completed, 'user data');
    await abandoned(parent, 4_194_303);

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
    expect(typeof result.file_path).toBe('string');
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
