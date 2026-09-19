import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParameterManifest } from './parameter-manifest.js';

/**
 * A file an upload fixture needs on disk.
 *
 * A manifest cannot name an absolute path: it is authored by hand and read on every
 * machine that runs the suite. It declares the file's contents instead and refers to it
 * by a token, which this materializes into a real file under a temporary directory the
 * caller owns. The substitution is textual and total, so the same token stands for the
 * same file in the fixture's input and in its expected driver arguments.
 */
export async function materializeFiles(
  manifest: ParameterManifest,
  directory: string,
): Promise<Readonly<Record<string, string>>> {
  const paths: Record<string, string> = {};
  for (const file of manifest.files ?? []) {
    const path = join(directory, file.filename);
    await writeFile(path, file.utf8, 'utf8');
    paths[file.token] = path;
  }
  return Object.freeze(paths);
}

/** Replace every {{token}} with the materialized path, at any depth. */
export function substituteTokens<T>(value: T, paths: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') {
    const match = /^\{\{([^}]+)\}\}$/u.exec(value);
    if (match === null) return value;
    const token = match[1] ?? '';
    const path = paths[token];
    if (path === undefined) throw new Error(`Fixture references an undeclared file token: ${token}`);
    return path as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => substituteTokens(item, paths)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteTokens(item, paths)]),
    ) as T;
  }
  return value;
}

export interface MultipartPart {
  readonly name: string;
  readonly filename: string;
  readonly content_type: string;
  readonly utf8: string;
}

/**
 * Describe a request body the way a fixture writes it.
 *
 * A multipart upload reaches fetch as form data whose parts carry their own filename and
 * media type, so it is decoded into those fields rather than compared as an opaque
 * object. Reading the parts is the only way to see what was actually uploaded: the
 * generated boundary differs on every request and says nothing about the content.
 */
export async function describeBody(body: unknown): Promise<unknown> {
  if (body instanceof FormData) {
    return Promise.all([...body.entries()].map(async ([name, value]): Promise<MultipartPart | { name: string; value: File | string }> => (
      value instanceof File
        ? { name, filename: value.name, content_type: value.type, utf8: await value.text() }
        : { name, value }
    )));
  }
  return typeof body === 'string' ? JSON.parse(body) : body;
}
