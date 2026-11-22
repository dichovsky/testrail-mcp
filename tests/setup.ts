import { afterAll } from 'vitest';

// Production diagnostics use stderr directly, bypassing Vitest's console capture.
// Capture only those complete JSON lines so `silent: 'passed-only'` can retain
// failing-test diagnostics. Tests can still spy on the real logger's stderr writes.
// Keep its identity for restoration; Reflect.apply below supplies the receiver.
// oxlint-disable-next-line typescript/unbound-method
const write = process.stderr.write;
let forwarding = false;
type Callback = (error?: Error | null) => void;

process.stderr.write = function (
  this: typeof process.stderr,
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | Callback,
  callback?: Callback,
): boolean {
  if (!forwarding && typeof chunk === 'string' && chunk.startsWith('{"event":') && chunk.endsWith('\n')) {
    // If console interception is explicitly disabled, the console writes back to
    // stderr. The guard lets that write through instead of recursively capturing it.
    forwarding = true;
    try {
      console.error(chunk.slice(0, -1));
    } finally {
      forwarding = false;
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done !== undefined) queueMicrotask(() => { done(); });
    return true;
  }
  return Reflect.apply(write, this, [chunk, encoding, callback]) as boolean;
};

afterAll(() => { process.stderr.write = write; });
