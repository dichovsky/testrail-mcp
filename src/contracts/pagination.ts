import type { Page } from '@dichovsky/testrail-api-client';
import type { Limits } from '../config/limits.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 250;

export type NextAction = 'page' | 'all' | 'none';

export interface PageMetadata {
  readonly mode: 'page';
  readonly source: 'envelope' | 'legacy_array';
  readonly returned: number;
  readonly has_more: boolean;
  readonly manual_continuation: boolean;
  readonly next_action: NextAction;
  readonly limit?: number;
  readonly offset?: number;
  readonly next_offset?: number;
  readonly driver?: Readonly<Record<string, unknown>>;
}

export interface AggregateMetadata {
  readonly mode: 'all';
  readonly returned: number;
  readonly complete: true;
  readonly start_offset?: number;
}

export interface Continuation {
  readonly offset: number;
  readonly limit?: number;
}

/**
 * Collect limit/offset from a page link.
 *
 * TestRail's real next link carries no `?` at all: the controls trail the resource path,
 * as in `/api/v2/get_cases/1&limit=250&offset=250`, so a URL parse puts the whole thing
 * in `pathname` and leaves `search` empty. Conventional links put them in `search`
 * instead. Both locations are read and the combined values validated together, so a
 * control repeated across the two forms is seen twice and rejected rather than silently
 * preferred. This mirrors how the driver reads its own continuations.
 *
 * A value that is not a canonical decimal integer becomes NaN so validation rejects the
 * whole link, instead of being coerced into a request target.
 */
function collectControls(url: URL): { offsets: number[]; limits: number[] } {
  const pathControls = url.pathname.indexOf('&');
  const fromPath = new URLSearchParams(pathControls === -1 ? '' : url.pathname.slice(pathControls + 1));
  const read = (key: 'offset' | 'limit'): number[] =>
    [...url.searchParams.getAll(key), ...fromPath.getAll(key)]
      .map((raw) => (/^\d+$/u.test(raw) ? Number(raw) : Number.NaN));
  return { offsets: read('offset'), limits: read('limit') };
}

/**
 * Validate a driver-supplied next link into caller-controllable page arguments.
 *
 * The link is metadata, never fetch authority: host and path are discarded and only
 * validated numbers are exposed, so the caller's original filters are reused rather
 * than whatever the link happens to encode. A continuation that does not strictly
 * advance past what this page already returned is rejected, because replaying or
 * overlapping it would silently duplicate items.
 */
export function parseContinuation(
  next: string | null,
  current: { readonly offset: number; readonly returned: number },
): Continuation | null {
  if (next === null) return null;
  let url: URL;
  try {
    url = new URL(next, 'https://testrail.invalid');
  } catch {
    return null;
  }
  const { offsets, limits } = collectControls(url);
  if (offsets.length !== 1 || limits.length > 1) return null;

  const offset = offsets[0] ?? Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0) return null;

  const limit = limits[0];
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE)) {
    return null;
  }
  if (offset <= current.offset || offset - current.offset < current.returned) return null;

  return Object.freeze(limit === undefined ? { offset } : { offset, limit });
}

/**
 * Describe one returned page. `data` carries the items; this describes only how much
 * of the dataset they represent, and never implies completeness that was not observed.
 */
export function pageMetadata(
  page: Page<unknown>,
  options: { readonly responseDriven: boolean },
): PageMetadata {
  const returned = page.items.length;
  if (page.kind === 'legacy-array') {
    // A terminal legacy array describes the observed response. It is not independent
    // proof that the upstream dataset held nothing more.
    return Object.freeze({
      mode: 'page' as const, source: 'legacy_array' as const, returned,
      has_more: false, manual_continuation: false, next_action: 'none' as const,
      driver: Object.freeze({ size: page.size }),
    });
  }

  const hasMore = page._links.next !== null;
  const continuation = options.responseDriven
    ? null
    : parseContinuation(page._links.next, { offset: page.offset, returned });
  const manual = continuation !== null;

  return Object.freeze({
    mode: 'page' as const,
    source: 'envelope' as const,
    returned,
    has_more: hasMore,
    manual_continuation: manual,
    // Without a validated continuation the only honest way forward is the bounded
    // aggregate, even though the driver said more exists.
    next_action: !hasMore ? 'none' : manual ? 'page' : 'all',
    limit: page.limit,
    offset: page.offset,
    ...(manual ? { next_offset: continuation.offset } : {}),
    driver: Object.freeze({ size: page.size, links: Object.freeze({ ...page._links }) }),
  });
}

export function aggregateMetadata(
  items: readonly unknown[],
  options: { readonly startOffset?: number } = {},
): AggregateMetadata {
  return Object.freeze({
    mode: 'all' as const,
    returned: items.length,
    complete: true as const,
    // Omitted on response-driven lists, which have no caller-controlled start.
    ...(options.startOffset === undefined ? {} : { start_offset: options.startOffset }),
  });
}

// Values may be explicitly undefined for the same reason as pageRequestDefaults: a
// list input is a union of branches, and reading the all branch's controls totally
// yields undefined for each one the caller left out.
export interface AllControls {
  readonly page_size?: number | undefined;
  readonly start_offset?: number | undefined;
  readonly max_items?: number | undefined;
  readonly max_pages?: number | undefined;
  readonly max_bytes?: number | undefined;
  readonly max_duration_ms?: number | undefined;
}

/** Map adapter controls to the public aggregate helper. Configured maxima are the defaults. */
export function driverAllOptions(controls: AllControls, limits: Limits): Readonly<Record<string, number>> {
  return Object.freeze({
    ...(controls.page_size === undefined ? {} : { pageSize: controls.page_size }),
    ...(controls.start_offset === undefined ? {} : { startOffset: controls.start_offset }),
    maxItems: controls.max_items ?? limits.max_all_items,
    maxPages: controls.max_pages ?? limits.max_all_pages,
    maxBytes: controls.max_bytes ?? limits.max_all_bytes,
    maxDurationMs: controls.max_duration_ms ?? limits.max_all_duration_ms,
  });
}

/** Page mode defaults: one page of 50 from the start unless the caller says otherwise. */
export function pageRequestDefaults(
  // Values may be explicitly undefined: a list input is a union of the page and all
  // branches, so a caller reading one branch's controls gets undefined for the other's.
  query: { readonly limit?: number | undefined; readonly offset?: number | undefined } | undefined,
): { readonly limit: number; readonly offset: number } {
  return Object.freeze({ limit: query?.limit ?? DEFAULT_PAGE_SIZE, offset: query?.offset ?? 0 });
}
