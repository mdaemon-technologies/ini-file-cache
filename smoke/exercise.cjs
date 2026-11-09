'use strict';
/**
 * Smoke checks for the built bundles, shared by smoke.test.cjs and smoke.test.mjs.
 *
 * The full suite runs under Vitest, which needs Node 22.12 or later, but the package
 * supports older Node versions. These checks use nothing but node:test and node:assert, so
 * they need no toolchain and no TypeScript — only the runtime dependencies the bundle
 * imports, as a consumer would have — and CI runs them on the versions Vitest cannot.
 * They load the package by its own name, which also exercises the "exports" map a
 * consumer resolves through.
 *
 * Plain JavaScript on purpose: keep it to syntax and APIs the oldest supported Node has.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Polls rather than sleeping a fixed time: watch latency varies a lot with load. */
function waitFor(condition, what, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  return new Promise((resolve, reject) => {
    (function poll() {
      if (condition()) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error('timed out waiting for ' + what));
      } else {
        setTimeout(poll, 20);
      }
    })();
  });
}

/**
 * Runs the checks against one loaded IniFileCache class: reading, a locked save announced
 * through the emitter, the injection guard, and following another writer's change.
 *
 * @param {Function} IniFileCache - The default export, as a consumer receives it.
 */
async function exercise(IniFileCache) {
  assert.equal(typeof IniFileCache, 'function', 'the default export is the IniFileCache class');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ini-file-cache-smoke-'));
  const file = path.join(dir, 'smoke.ini');
  fs.writeFileSync(file, '[Server]\nHost=mail.example.com\nPort=25\nEnabled=Yes\n');

  const cache = new IniFileCache(dir, 'smoke.ini', { debounceDelay: 20 });
  try {
    const errors = [];
    let saves = 0;
    let changes = 0;
    cache.listener.on('error', (error) => errors.push(error));
    cache.listener.on('save', () => {
      saves += 1;
    });
    cache.listener.on('change', () => {
      changes += 1;
    });

    // The constructor parses synchronously and starts watching.
    assert.equal(cache.getSetting('Server', 'Host'), 'mail.example.com');
    assert.equal(cache.getInt('Server', 'Port'), 25);
    assert.equal(cache.getBool('Server', 'Enabled'), true);
    assert.deepEqual(cache.getSections(), ['Server']);
    assert.equal(cache.isWatching(), true);

    // A save takes the lock, writes atomically, releases the lock and emits once.
    cache.setSetting('Server', 'Port', '587');
    cache.setSetting('Client', 'Name', 'smoke');
    assert.equal(await cache.save(), true);
    await waitFor(() => saves === 1, 'the save event');
    const saved = fs.readFileSync(file, 'utf8');
    assert.match(saved, /^Port=587$/m);
    assert.match(saved, /^\[Client\]$/m);
    assert.equal(fs.existsSync(file + '.lck'), false, 'the lock is released');

    // A value that would forge a section on the next read is refused.
    assert.throws(() => cache.setSetting('Server', 'Host', 'x\n[Forged]'), TypeError);

    // Another writer's change reaches the cache through the directory watcher.
    fs.writeFileSync(file, '[Server]\nHost=other.example.com\n');
    // At least one: a single write can surface as more than one watch event on some
    // platforms, and debouncing is not what this checks.
    await waitFor(() => changes >= 1, 'the change event');
    assert.equal(cache.getSetting('Server', 'Host'), 'other.example.com');
    assert.equal(cache.hasSection('Client'), false);

    assert.deepEqual(errors, []);
  } finally {
    cache.unwatch();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(cache.isWatching(), false);
}

module.exports = { exercise };
