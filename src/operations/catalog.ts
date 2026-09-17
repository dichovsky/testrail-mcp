import { t01 } from './families/t01.js';
import { createRegistry } from './registry.js';

// One entry per family, spread in order. T02–T12 add theirs alongside; keeping a
// file per family means parallel work edits disjoint files rather than this one.
export const operationRegistry = createRegistry(...t01);
