import { createRegistry } from './registry.js';

// T01–T12 add independently verified endpoint implementations here. The CLI
// continues to reject serving until F08 provides the real MCP runtime.
export const operationRegistry = createRegistry();
