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

/** One `name="value"` attribute of a part header, decoded as the encoder wrote it. */
function attribute(header: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`, 'u').exec(header);
  return match?.[1];
}

/**
 * Describe a request body the way a fixture writes it.
 *
 * A multipart upload is encoded before it is sent, and the encoding is where a name or
 * a media type can still change: a part with no declared type is written as
 * application/octet-stream, and a filename is escaped. Reading back the form data
 * object would show what was handed to the encoder instead, so this serializes the body
 * and reads the parts out of it. The generated boundary is used to split them and is
 * never compared, since it differs on every request and says nothing about the content.
 */
export async function describeBody(body: unknown): Promise<unknown> {
  if (!(body instanceof FormData)) return typeof body === 'string' ? JSON.parse(body) : body;

  const encoded = new Response(body);
  const boundary = /boundary=(?<value>[^;]+)/u.exec(encoded.headers.get('content-type') ?? '')?.groups?.value;
  if (boundary === undefined) throw new Error('Multipart body carries no boundary');
  const text = await encoded.text();

  return text
    .split(`--${boundary}`)
    .map((section) => section.replace(/^\r\n/u, '').replace(/\r\n$/u, ''))
    .filter((section) => section.length > 0 && section !== '--')
    .map((section): MultipartPart => {
      const separator = section.indexOf('\r\n\r\n');
      if (separator === -1) throw new Error('Multipart part carries no header');
      const headers = section.slice(0, separator);
      return {
        name: attribute(headers, 'name') ?? '',
        filename: attribute(headers, 'filename') ?? '',
        content_type: /content-type: *(?<value>[^\r\n]+)/iu.exec(headers)?.groups?.value ?? '',
        utf8: section.slice(separator + 4),
      };
    });
}
