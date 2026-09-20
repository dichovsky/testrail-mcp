import { t01 } from './families/t01.js';
import { t02 } from './families/t02.js';
import { t03 } from './families/t03.js';
import { t04 } from './families/t04.js';
import { t05 } from './families/t05.js';
import { t06 } from './families/t06.js';
import { createRegistry } from './registry.js';

// One entry per family, spread in order. T07–T12 add theirs alongside; keeping a
// file per family means parallel work edits disjoint files rather than this one.
export const operationRegistry = createRegistry(...t01, ...t02, ...t03, ...t04, ...t05, ...t06);
