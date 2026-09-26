import { t01 } from './families/t01.js';
import { t02 } from './families/t02.js';
import { t03 } from './families/t03.js';
import { t04 } from './families/t04.js';
import { t05 } from './families/t05.js';
import { t06 } from './families/t06.js';
import { t07 } from './families/t07.js';
import { t08 } from './families/t08.js';
import { t09 } from './families/t09.js';
import { t10 } from './families/t10.js';
import { t11 } from './families/t11.js';
import { createRegistry } from './registry.js';

// One entry per family, spread in order. T12 adds its own alongside; keeping a
// file per family means parallel work edits disjoint files rather than this one.
export const operationRegistry = createRegistry(
  ...t01, ...t02, ...t03, ...t04, ...t05, ...t06, ...t07, ...t08, ...t09, ...t10, ...t11,
);
