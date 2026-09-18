import { mkdirSync } from 'node:fs';
import { assertCopies, assertSafeInput, readOnly } from './invoke.mjs';
const root = process.cwd();
assertCopies(root);
for (const path of readOnly) assertSafeInput(root, path);
for (const path of ['dist', 'test-results']) { mkdirSync(path, { recursive: true }); assertSafeInput(root, path); }
