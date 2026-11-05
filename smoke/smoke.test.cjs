'use strict';
// The CommonJS entry, resolved through package.json's "exports" -> "require".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { exercise } = require('./exercise.cjs');

test('require() returns the IniFileCache class from dist/iniFileCache.cjs', async () => {
  assert.equal(
    require.resolve('@mdaemon/ini-file-cache'),
    path.resolve(__dirname, '..', 'dist', 'iniFileCache.cjs')
  );
  await exercise(require('@mdaemon/ini-file-cache'));
});
