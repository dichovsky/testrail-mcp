import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/*
 * The authoring audit is the first guard and the compiled validator the second. A
 * published document the validator cannot fully enforce must fail registration, not be
 * accepted with a constraint silently ignored. The audit refuses such documents first, so
 * the validator's own strictness is reached only by replacing the document it is given.
 */
afterEach(() => {
  vi.doUnmock('../src/contracts/inputs.js');
  vi.resetModules();
});

async function registerPublished(published: object): Promise<void> {
  vi.resetModules();
  vi.doMock('../src/contracts/inputs.js', () => ({ inputJsonSchema: () => published }));
  const { createInputContract } = await import('../src/contracts/input-contract.js');
  createInputContract(z.strictObject({}));
}

describe('registration of a published document the validator cannot fully enforce', () => {
  it.each([
    ['a misspelled keyword', { type: 'object', properties: { a: { type: 'string', minLenght: 2 } } }, 'unknown keyword'],
    ['an unknown format', { type: 'object', properties: { a: { type: 'string', format: 'no-such-format' } } }, 'unknown format'],
  ])('refuses %s', async (_name, published, message) => {
    await expect(registerPublished(published)).rejects.toThrow(message);
  });

  it('accepts the same document without them', async () => {
    await expect(registerPublished({ type: 'object', properties: { a: { type: 'string', minLength: 2 } } }))
      .resolves.toBeUndefined();
  });
});
