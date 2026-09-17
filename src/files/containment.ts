import { isAbsolute, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { AdapterError } from '../contracts/errors.js';

/**
 * Is `candidate` the root itself or genuinely beneath it?
 *
 * Compared by path components rather than string prefix: `/data/rootsomething`
 * starts with `/data/root` as a string but is a different directory. `relative`
 * answers this on both platforms, including drive letters and case rules.
 */
export function isWithin(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  if (offset === '') return true;
  if (isAbsolute(offset)) return false;
  return offset !== '..' && !offset.startsWith(`..${sep}`);
}

/**
 * Resolve a caller-supplied path and prove it lies inside an allowed root.
 *
 * `realpath` resolves every symlink in the chain, so containment is judged on the
 * real destination rather than the name used to reach it. A link inside a root that
 * points outside one is therefore rejected.
 *
 * This bounds what the server will read on behalf of a caller. It is not isolation
 * from a malicious process running as the same OS user, and must not be described
 * as such: anything that user can do to the filesystem, it can still do.
 */
export async function containedRealPath(
  candidate: string,
  roots: readonly string[],
): Promise<string> {
  if (typeof candidate !== 'string' || candidate.length === 0 || !isAbsolute(candidate)) {
    throw new AdapterError('FILE_ACCESS_DENIED');
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    // Missing, unreadable or a broken link: all equally "not a file we may read",
    // and distinguishing them here would leak filesystem layout.
    throw new AdapterError('FILE_ACCESS_DENIED');
  }
  // Roots are resolved too. A configured root may itself sit behind a symlink -
  // macOS's own temporary directory does - and comparing a resolved candidate against
  // an unresolved root would then deny every legitimate file. A root that cannot be
  // resolved right now simply does not match.
  for (const root of roots) {
    const resolvedRoot = await realpath(root).catch(() => null);
    if (resolvedRoot !== null && isWithin(resolvedRoot, resolved)) return resolved;
  }
  throw new AdapterError('FILE_ACCESS_DENIED');
}
