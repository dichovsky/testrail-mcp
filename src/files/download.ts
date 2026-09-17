import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterError } from '../contracts/errors.js';
import { isWithin } from './containment.js';

export interface DownloadResult {
  readonly attachment_id: number;
  readonly file_path: string;
  readonly bytes: number;
}

/**
 * Write a downloaded attachment to a new file in the configured directory.
 *
 * The caller never chooses the destination: the name is generated, so a download
 * cannot be aimed at an existing file. Creation is exclusive, so two downloads that
 * somehow generate the same name fail rather than one overwriting the other.
 *
 * The result is returned only after the bytes are written and the handle is closed,
 * so a reported path always refers to a complete file. A failure part-way removes the
 * partial output; once committed the file is kept even if delivery later fails, since
 * the user now owns it and silently deleting their data would be worse than an orphan.
 *
 * The driver returns only bytes, so no original filename or media type is invented.
 */
export async function writeDownload(
  content: ArrayBuffer | Uint8Array,
  options: { readonly directory: string; readonly maxBytes: number; readonly attachmentId: number },
): Promise<DownloadResult> {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  if (bytes.byteLength > options.maxBytes) throw new AdapterError('FILE_TOO_LARGE');

  const target = join(options.directory, `${randomUUID()}.bin`);
  // A generated UUID cannot escape, but the check costs nothing and holds if the
  // naming ever changes.
  if (!isWithin(options.directory, target)) throw new AdapterError('FILE_ACCESS_DENIED');

  const handle = await open(target, 'wx', 0o600).catch(() => {
    throw new AdapterError('FILE_ACCESS_DENIED');
  });
  try {
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    // Close may itself fail after a partial write; either way nothing incomplete is
    // left behind, and the unlink failure must not mask the original error.
    await handle.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw error instanceof AdapterError ? error : new AdapterError('INTERNAL_ERROR');
  }
  return Object.freeze({
    attachment_id: options.attachmentId,
    file_path: target,
    bytes: bytes.byteLength,
  });
}
