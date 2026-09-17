import type { Page } from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import {
  aggregateMetadata, driverAllOptions, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  pageMetadata, pageRequestDefaults, parseContinuation,
} from '../src/contracts/pagination.js';

function envelope(over: Partial<Extract<Page<unknown>, { kind: 'envelope' }>> = {}): Page<unknown> {
  return {
    kind: 'envelope', items: [1, 2, 3], offset: 0, limit: 50, size: 3,
    _links: { next: null, prev: null }, ...over,
  };
}

const at = (offset: number, returned: number) => ({ offset, returned });

describe('page request defaults', () => {
  it('returns one page of fifty from the start when the caller says nothing', () => {
    expect(pageRequestDefaults(undefined)).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(DEFAULT_PAGE_SIZE).toBe(50);
    expect(MAX_PAGE_SIZE).toBe(250);
  });

  it('honours caller values, including a deliberate zero offset', () => {
    expect(pageRequestDefaults({ limit: 250, offset: 0 })).toEqual({ limit: 250, offset: 0 });
    expect(pageRequestDefaults({ offset: 100 })).toEqual({ limit: 50, offset: 100 });
  });
});

describe('continuation parsing', () => {
  it('reads a conventional query link', () => {
    expect(parseContinuation('https://x.testrail.io/list?offset=50&limit=25', at(0, 50)))
      .toEqual({ offset: 50, limit: 25 });
  });

  it('reads the real TestRail path-style link, which carries no question mark', () => {
    // This is the shape TestRail actually emits in _links.next. A URL parse puts the
    // whole thing in pathname and leaves search empty, so reading only search finds
    // nothing and every real continuation would be discarded.
    expect(parseContinuation('/api/v2/get_cases/1&limit=250&offset=250', at(0, 250)))
      .toEqual({ offset: 250, limit: 250 });
    expect(parseContinuation('/api/v2/get_cases/1&offset=50', at(0, 50))).toEqual({ offset: 50 });
  });

  it('reads controls that trail a path after a question mark as well', () => {
    expect(parseContinuation('/index.php?/api/v2/get_cases/1&limit=50&offset=50', at(0, 50)))
      .toEqual({ offset: 50, limit: 50 });
  });

  it('rejects a control repeated across the path and the query', () => {
    expect(parseContinuation('/api/v2/get_cases/1&offset=50?offset=60', at(0, 50))).toBeNull();
    expect(parseContinuation('/api/v2/get_cases/1&limit=25&offset=50?limit=25', at(0, 50))).toBeNull();
  });

  it('rejects a control that appears in both forms rather than preferring one', () => {
    expect(parseContinuation('/index.php?offset=50&/api/v2/get_cases/1&offset=50', at(0, 50))).toBeNull();
    expect(parseContinuation('/index.php?limit=25&/api/v2/get_cases/1&limit=25&offset=50', at(0, 50))).toBeNull();
  });

  it('requires exactly one canonical offset', () => {
    expect(parseContinuation('https://x.testrail.io/list?limit=25', at(0, 50))).toBeNull();
    expect(parseContinuation('https://x.testrail.io/list?offset=50&offset=100', at(0, 50))).toBeNull();
    for (const raw of ['-1', '1.5', '0x10', '1e2', ' 50', '', 'abc', '05 0']) {
      expect(parseContinuation(`https://x.testrail.io/list?offset=${encodeURIComponent(raw)}`, at(0, 50)), raw)
        .toBeNull();
    }
  });

  it('rejects a limit outside the supported range', () => {
    expect(parseContinuation(`https://x/l?offset=50&limit=${MAX_PAGE_SIZE}`, at(0, 50))?.limit).toBe(MAX_PAGE_SIZE);
    expect(parseContinuation(`https://x/l?offset=50&limit=${MAX_PAGE_SIZE + 1}`, at(0, 50))).toBeNull();
    expect(parseContinuation('https://x/l?offset=50&limit=0', at(0, 50))).toBeNull();
  });

  it('requires the continuation to advance past what this page returned', () => {
    // Replaying or overlapping would silently duplicate items.
    expect(parseContinuation('https://x/l?offset=0', at(0, 50))).toBeNull();
    expect(parseContinuation('https://x/l?offset=25', at(0, 50))).toBeNull();
    expect(parseContinuation('https://x/l?offset=49', at(0, 50))).toBeNull();
    expect(parseContinuation('https://x/l?offset=50', at(0, 50))).toEqual({ offset: 50 });
    expect(parseContinuation('https://x/l?offset=90', at(0, 50))).toEqual({ offset: 90 });
  });

  it('exposes only validated numbers, never the link as a request target', () => {
    const parsed = parseContinuation('https://attacker.example/evil/path?offset=50&limit=10', at(0, 50));
    expect(parsed).toEqual({ offset: 50, limit: 10 });
    expect(JSON.stringify(parsed)).not.toMatch(/attacker|evil|http/u);
  });

  it('returns nothing for an absent or unparseable link', () => {
    expect(parseContinuation(null, at(0, 50))).toBeNull();
    expect(parseContinuation('http://[', at(0, 50))).toBeNull();
    expect(parseContinuation('%', at(0, 50))).toBeNull();
  });
});

describe('page metadata', () => {
  it('derives returned from the items and keeps the driver size separately', () => {
    const meta = pageMetadata(envelope({ items: [1, 2], size: 987 }), { responseDriven: false });
    expect(meta.returned).toBe(2);
    expect(meta.driver).toMatchObject({ size: 987 });
  });

  it('passes the driver page limit and offset through unchanged', () => {
    const meta = pageMetadata(envelope({ offset: 100, limit: 25, items: [1] }), { responseDriven: false });
    expect(meta.limit).toBe(25);
    expect(meta.offset).toBe(100);
  });

  it('describes a terminal envelope page as finished', () => {
    const meta = pageMetadata(envelope({ _links: { next: null, prev: null } }), { responseDriven: false });
    expect(meta).toMatchObject({
      mode: 'page', source: 'envelope', has_more: false, manual_continuation: false, next_action: 'none',
      limit: 50, offset: 0,
    });
    expect(meta.next_offset).toBeUndefined();
  });

  it('offers manual paging when the next link yields a validated continuation', () => {
    const meta = pageMetadata(
      envelope({ items: [1, 2, 3], offset: 0, _links: { next: '/i.php?/api/v2/get_cases/1&limit=3&offset=3', prev: null } }),
      { responseDriven: false },
    );
    expect(meta).toMatchObject({ has_more: true, manual_continuation: true, next_action: 'page', next_offset: 3 });
  });

  it('falls back to the bounded aggregate when the link cannot be validated', () => {
    // The driver says more exists, but nothing controllable was proven, so advertising
    // a manual page would be inventing a cursor.
    const meta = pageMetadata(
      envelope({ _links: { next: 'https://x.testrail.io/list?cursor=opaque', prev: null } }),
      { responseDriven: false },
    );
    expect(meta).toMatchObject({ has_more: true, manual_continuation: false, next_action: 'all' });
    expect(meta.next_offset).toBeUndefined();
  });

  it('never offers manual paging on a response-driven list', () => {
    const meta = pageMetadata(
      envelope({ _links: { next: '/i.php?/api/v2/get_variables/1&limit=3&offset=3', prev: null } }),
      { responseDriven: true },
    );
    expect(meta).toMatchObject({ has_more: true, manual_continuation: false, next_action: 'all' });
    expect(meta.next_offset).toBeUndefined();
  });

  it('maps a legacy array to a terminal page without inventing pagination', () => {
    const meta = pageMetadata({ kind: 'legacy-array', items: [1, 2], size: 2 }, { responseDriven: false });
    expect(meta).toEqual({
      mode: 'page', source: 'legacy_array', returned: 2, has_more: false,
      manual_continuation: false, next_action: 'none', driver: { size: 2 },
    });
    // No limit/offset are invented for a shape that never had them.
    expect(Object.hasOwn(meta, 'limit')).toBe(false);
  });

  it('preserves driver links as data rather than fetch authority', () => {
    const links = { next: 'https://x.testrail.io/n?offset=3&limit=3', prev: 'https://x.testrail.io/p?offset=0' };
    const meta = pageMetadata(envelope({ _links: links }), { responseDriven: false });
    expect(meta.driver).toMatchObject({ links });
  });
});

describe('aggregate metadata', () => {
  it('reports the effective start offset, not always zero', () => {
    expect(aggregateMetadata([1, 2, 3], { startOffset: 120 }))
      .toEqual({ mode: 'all', returned: 3, complete: true, start_offset: 120 });
    expect(aggregateMetadata([], { startOffset: 0 }))
      .toEqual({ mode: 'all', returned: 0, complete: true, start_offset: 0 });
  });

  it('omits the start offset on a response-driven list that has no caller-controlled start', () => {
    expect(aggregateMetadata([1])).toEqual({ mode: 'all', returned: 1, complete: true });
  });
});

describe('aggregate control mapping', () => {
  it('defaults every bound to the configured maximum', () => {
    expect(driverAllOptions({}, DEFAULT_LIMITS)).toEqual({
      maxItems: DEFAULT_LIMITS.max_all_items,
      maxPages: DEFAULT_LIMITS.max_all_pages,
      maxBytes: DEFAULT_LIMITS.max_all_bytes,
      maxDurationMs: DEFAULT_LIMITS.max_all_duration_ms,
    });
  });

  it('maps every adapter control to its public helper name', () => {
    expect(driverAllOptions({
      page_size: 25, start_offset: 100, max_items: 10, max_pages: 2, max_bytes: 1_024, max_duration_ms: 5_000,
    }, DEFAULT_LIMITS)).toEqual({
      pageSize: 25, startOffset: 100, maxItems: 10, maxPages: 2, maxBytes: 1_024, maxDurationMs: 5_000,
    });
  });

  it('omits paging controls a response-driven list cannot accept', () => {
    expect(Object.keys(driverAllOptions({ max_items: 5 }, DEFAULT_LIMITS)).sort())
      .toEqual(['maxBytes', 'maxDurationMs', 'maxItems', 'maxPages']);
  });
});
