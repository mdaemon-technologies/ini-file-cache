// The ES module entry, resolved through package.json's "exports" -> "import".
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import IniFileCache from '@mdaemon/ini-file-cache';
import smoke from './exercise.cjs';

test('import returns the IniFileCache class from dist/iniFileCache.mjs', async () => {
  // import.meta.resolve needs a flag before Node 20.6; the import above has
  // already resolved either way, so this only pins down which file it chose.
  if (typeof import.meta.resolve === 'function') {
    assert.equal(
      fileURLToPath(import.meta.resolve('@mdaemon/ini-file-cache')),
      fileURLToPath(new URL('../dist/iniFileCache.mjs', import.meta.url))
    );
  }
  await smoke.exercise(IniFileCache);
});
