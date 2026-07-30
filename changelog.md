# Changelog

All notable changes to `@mdaemon/ini-file-cache` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-07-28

A correctness and hardening release. Every issue below was reproduced against 2.0.5
before being fixed, and each has a regression test.

Several entries under **Changed** and **Security** tighten input handling and will
reject or reinterpret input that 2.0.5 silently accepted. Review those sections
before upgrading.

### Security

- **Prevented ini injection through `setSetting`.** Values, keys and section names were
  written to disk verbatim, so a value containing a line break could forge additional
  keys and entire sections. Storing the untrusted string
  `"bob\nAdmin=true\n[Security]\nAdmin=true"` produced a real `Admin=true` setting and a
  second `[Security]` block on the next read — a privilege-escalation path wherever the
  ini file backs authentication or permission settings. `setSetting` now throws a
  `TypeError` for line breaks and null characters in values, and for `]`, `=`, line breaks
  and null characters in section names and keys.
- **Optional containment of `fileName` within `cachePath`,** via the new
  `restrictToCachePath` option. It is **off by default**: both constructor arguments come
  from the consuming application, which can point anywhere through `cachePath` regardless,
  so `..` in `fileName` is a legitimate way to reach a sibling directory and continues to
  work exactly as before. Turn the option on when `fileName` comes from somewhere
  untrusted.
- **Bounded reads.** The whole file was read with no size limit. A very large or hostile
  file could exhaust memory or stall the process. Reads are now capped at 10 MB by default,
  configurable with the `maxFileSize` option; oversized files emit an `error` and leave the
  cached settings untouched.
- **Made the lock file an actual lock.** The previous implementation checked
  `fs.existsSync` and then wrote the lock in a separate step, so two processes could both
  believe they held it. After 20 attempts it also wrote the file anyway and deleted a lock
  it did not own. Locks are now taken with an exclusive `open(..., "wx")` and stamped with a
  token, so a lock is only ever removed by the writer that took it — including when a writer
  has had its own lock broken as stale by someone else. `save()` refuses to write when the
  lock cannot be acquired. Locks older than 10 seconds are treated as abandoned and broken.
- **Scoped the lock to the file.** The lock lived at `<directory>/.lck`, so two instances on
  different files in the same directory contended with each other, and each one's unlock
  deleted the other's lock. The lock is now `<file>.lck`.

### Fixed

- **`cacheFileSettings()` no longer hangs forever.** On a terminal read failure the internal
  promise was never resolved, so `reload()` never settled and the file-watch callback that
  awaited it stalled permanently. A single unreadable read — file deleted, replaced
  mid-write, `EMFILE` — wedged the instance for the life of the process.
- **Retries now actually wait.** The retry delay constructed a `setTimeout` promise and
  discarded it, turning "20 attempts, 100 ms apart" into 20 synchronous reads in a tight
  loop that blocked the event loop.
- **An empty or comment-only file is valid.** Both emitted `Invalid ini file format`,
  including the empty file the constructor creates for a new cache.
- **Malformed content no longer clears the cache.** A parse failure reset `settings` to `[]`,
  and the next `save()` wrote that emptiness back — truncating the user's config file. The
  previous settings are now retained and an `error` is emitted.
- **Values may contain `=`.** `split("=")` kept only the first two parts, so
  `Password=p@ss=word==` parsed as `p@ss` and `Url=http://x/?a=1&b=2` as `http://x/?a`.
  The truncated value was then written back on save. Only the first `=` is now treated as
  the separator.
- **`key = value` is now readable.** Whitespace around `=` was preserved, so the key was
  stored as `"key "` and every lookup for `key` missed. Keys, values and the text inside
  `[ ]` are now trimmed.
- **A line with no `=` no longer yields `undefined`.** `getSetting` returned `undefined`
  despite declaring `string | null`, the `getBool`/`getInt` default-value guards missed it,
  and `save()` wrote the line back as the literal `straykey=undefined`. Such a line now
  parses as a key with an empty value.
- **`unwatch()` now stops the watcher.** It called `fs.unwatchFile`, which pairs with
  `fs.watchFile` rather than the `fs.watch` watcher actually in use, so the watcher stayed
  live and kept firing `change` events and re-reading the file after `unwatch()`. It now
  closes the watcher.
- **`watch()` is idempotent.** The constructor already calls it, so a second call replaced
  `this.watching` and orphaned the first watcher permanently.
- **`watch()` reports failure instead of throwing.** `fs.watch` throws when the target is
  missing; it never returns a falsy value, which made the `Failed to watch file` branch
  unreachable and let the exception escape the constructor. Failures are now caught and
  emitted as `error`.
- **`getSetting(section, key, "")` returns `""`.** `defaultValue || null` converted an
  explicitly supplied empty-string default to `null`.
- **The constructor no longer leaves a floating promise.** It called the async
  `cacheFileSettings()` without awaiting it, working only because the body happened to be
  synchronous. Initial load is now an explicit synchronous read, so settings remain
  available immediately after construction.
- **A save no longer discards settings written just after it.** The watcher treated the
  library's own write like any other change and reloaded the file, silently reverting any
  `setSetting` made since the save and writing the stale values back on the next save. A
  save now records what it wrote and the watcher ignores that change.
- **A throwing event listener can no longer crash the process or corrupt a result.** The
  file-change handler ran detached, so an exception from a `change` listener became an
  unhandled rejection — fatal on Node 15 and later. A `save` listener that threw was also
  caught by the write's own error handler, making a successful save report failure.
  Listener exceptions are now caught and re-emitted as `error`.
- **Errors raised during construction are observable.** They were emitted synchronously
  from the constructor, before any caller could subscribe, so an unreadable, oversized or
  malformed file at startup was reported to nobody. They are now emitted asynchronously.
- **Keys may not begin with `;`, `#` or `[`.** `setSetting` accepted them and wrote them
  out, but the parser correctly read the line back as something else, so the setting
  silently vanished on the next reload. A `;` or `#` key became a comment; a key such as
  `[a] ;x` satisfies the section header pattern, so it came back as a *section* named `a`
  and took its value with it — adding a spurious section in the process. Such keys are now
  rejected with a `TypeError`. Brackets and comment characters elsewhere in a key (`a[0]`,
  `a;b`), and anywhere in a section name, are still valid.
- **Line endings and the byte order mark survive a save.** Every save rewrote the file with
  LF endings and dropped any UTF-8 BOM, silently reformatting CRLF files — the norm on
  Windows — and breaking tools that require the mark. Both are now preserved from the file
  that was read; a new or empty file still gets LF and no BOM.
- **A legacy single-byte file is no longer corrupted on save.** The file was always read
  as UTF-8, so every high byte in a windows-1252 or ISO-8859-1 file decoded to `U+FFFD`
  and was written back as `EF BF BD` — silent byte-level destruction of any non-UTF-8 ini
  file on the first save. The decode is now verified by re-encoding and comparing bytes;
  a mismatch emits `error` and makes `save()` refuse to write. Pass
  `{ encoding: "latin1" }` for such files and they round-trip exactly. The byte order mark
  is recognised and rewritten as its three bytes rather than as a character, so it survives
  under any encoding.
- **A save writes the settings the cache holds when the write actually happens.** The ini
  text was rendered before waiting for the write lock, a wait that can last two seconds. If
  the watcher adopted an external change during it, the save wrote settings the cache no
  longer held — and because the resulting change event was then suppressed as the library's
  own write, the cache and the file stayed permanently divergent with `save()` having
  returned `true`. Rendering now happens under the lock.
- **Creating the file no longer truncates one that appeared first.** The constructor tested
  for the file and then wrote it, so a file created and populated by another process in
  between was blanked. It is now created with an exclusive open and an existing file is
  adopted.
- **A file that has never parsed is no longer truncated by a save.** When the initial read
  failed — malformed content, or a decode that produced no sections — the cache stayed
  empty, and because there were no previous settings to fall back on, the next `save()`
  wrote that emptiness over the file and destroyed it. `save()` now refuses, with an error,
  until the file has parsed successfully at least once. A genuinely empty file still parses
  and saves normally.
- **Settings before the first section header are no longer discarded.** They were dropped
  on read and then erased from the file by the next save. They are now kept in a nameless
  section, addressed as `""` (`getSetting("", "Key")`, `setSetting("", "Key", "v")`) and
  written back at the top of the file without a header, so such a file round-trips
  unchanged. A file containing settings but no header at all is still reported as
  `Invalid ini file format`, since that is far more likely a truncated read; `getSections()`
  now includes `""` for files that have leading settings.
- **A save no longer replaces a symbolic link with a regular file.** The atomic rename
  introduced in this release replaced the link itself rather than writing through it to
  the target. Saves now detect a link and write in place.
- **`change` is no longer emitted when the reload failed.** Deleting the watched file, or
  replacing it with content that does not parse, produced an `error` and then a `change`
  event announcing a refresh that had not happened, leaving listeners to act on stale
  settings.
- **Constructor options are validated.** `maxFileSize: NaN` silently disabled the size
  limit, because `size > NaN` is never true, and a negative value rejected every read while
  reporting nothing. Both now throw a `TypeError`.

### Packaging and types

- **`require()` is typed correctly.** The `exports` map listed `types` after `import` and
  `require`, and conditions are matched in order, so TypeScript never reached it. A
  CommonJS consumer under `node16` resolution got
  `TS1471: ... only resolves to an ES module, which cannot be imported with 'require'` and
  `TS2351: This expression is not constructable` — for the `require()` call the README
  documents. `types` is now first in each condition.
- **A CommonJS declaration that matches the CommonJS bundle.** That bundle is built with
  `exports: "default"`, so `require()` returns the class itself, while the only declaration
  said `export default`. A generated `dist/iniFileCache.d.cts` now describes the real shape
  with `export =`, and the build emits it so it cannot drift.
- **Removed `dist/iniFileCache.cjs.d.ts` and `dist/iniFileCache.mjs.d.ts`.** They declared
  ambient modules for deep paths the `exports` map does not expose, were never referenced,
  and typed anything that did reach them as `any`.
- **`listener` is typed.** It was `any`, so the entire event API was unchecked. It now
  returns `IIniFileCacheListener`, which declares `on`, `once`, `off` and `emit` along with
  the handler signature of each event.
- `./package.json` is exported, which some tooling reads.
- Verified by type-checking real consumer projects installed from `npm pack`, under
  `node16`, `nodenext`, `bundler` and `node` resolution, for both `import` and
  `import x = require(...)`.

### Added

- Optional third constructor argument, `IIniFileCacheOptions`:
  - `maxFileSize` (default `10485760`) — largest file that will be read, in bytes.
  - `caseInsensitive` (default `false`) — match section names and keys case-insensitively.
  - `debounceDelay` (default `50`) — window used to coalesce file-change events.
  - `restrictToCachePath` (default `false`) — require the resolved file to stay inside
    `cachePath`.
  - `encoding` (default `"utf8"`) — character encoding of the file.
- `save()` returns `Promise<boolean>` — `true` when the file was written, `false` when the
  lock could not be acquired or the write failed. The `save` and `error` events are
  unchanged.
- `cacheFileSettings()` returns `Promise<boolean>` — `true` when the file was read and
  parsed, `false` when it could not be and an `error` was emitted. It previously returned
  `Promise<void>`.
- `parseContents()` returns `boolean` — `true` when the content was accepted, `false` when
  it was rejected. It previously returned `void`.
- `reload()` returns `Promise<boolean>` — `true` when the cache was refreshed, `false` when
  the read or the parse failed. It previously returned `Promise<void>`, and emitted `reload`
  even when nothing had been reloaded.
- Atomic saves: contents are written to `<file>.tmp` and renamed into place, so a concurrent
  reader can never observe a half-written file. Windows cannot rename over a file another
  process holds open, so the write falls back to an in-place write there after a few short
  retries — not atomic, but preferable to a save that fails outright.
- Change events are debounced, collapsing the multiple events most platforms emit for a
  single write into one.

### Changed

- **Duplicate sections are merged and the last duplicate key wins.** Previously a repeated
  `[Section]` header created a second entry: reads returned the first, `setSetting` and
  `getKeys` only saw the first, and both were written on save. Which duplicate won was
  therefore inconsistent between reading and writing.
- **`getInt` rejects malformed values instead of salvaging a prefix.** `parseInt` stopped at
  the first invalid character, so `123abc` became `123`, `12.34` became `12`, `0x10` became
  `0`, and `99999999999999999999` was returned as an unsafe float. Values must now match
  `[+-]?\d+` and be a safe integer; anything else returns `defaultValue`.
- **`getBool` returns `defaultValue` for unrecognized values.** The old test matched any
  value starting with `t`, `1` or `y`, so `123` was `true` and every other unrecognized
  value was silently `false`. Recognized true values are now `t`, `true`, `y`, `yes`, `on`,
  `1`; false values are `f`, `false`, `n`, `no`, `off`, `0`.
- **`setSetting` trims section names, keys and values,** so the in-memory value always
  matches what a save-and-reload cycle produces.
- **`getSetting`'s `defaultValue` parameter is typed `string | null` and defaults to `null`**
  rather than `""`. Callers passing a string are unaffected.
- The file watcher watches the containing directory and filters by filename, instead of
  watching the file directly. A watcher bound to a file stops working when the file is
  replaced, which is how most editors — and now `save()` itself — write.
- An inline comment after a section header (`[Server] ; comment`) is ignored rather than
  parsed as a key.
- The constructor throws a `TypeError` for an empty `cachePath` or `fileName`.
- The file path is built with `path.resolve(cachePath, fileName)` rather than
  `path.join`, so an absolute `fileName` now works instead of producing a nonsensical
  path such as `C:\a\C:\b\x.ini`. For an absolute `cachePath` — the usual case — the
  result is identical to before, `..` included. Only a **relative** `cachePath` differs:
  the same file is used, but the path carried by the `save` and `reload` events is now
  absolute rather than relative.
- The `change` event payload is the file's base name. It was previously the raw `filename`
  from `fs.watch`, which is platform-dependent and can be `null`.
- **An exception thrown by a listener no longer propagates to the caller.** It is caught and
  re-emitted as `error`. Previously a throwing `reload` or `save` listener surfaced out of the
  awaited call; code relying on that must listen for `error` instead.
- Filenames are compared case-insensitively on macOS as well as Windows, matching the default
  behavior of both filesystems.
- Parsing a section is linear in the number of keys. The duplicate-key merging added in this
  release originally rescanned the section for every line, which took about 21 seconds for
  40,000 keys and would have made a file near the 10 MB limit unusable. The same input now
  parses in about 35 ms.
- **Lookups are O(1) rather than a linear scan.** `getSetting`, `getKeys`, `hasSection`,
  `hasKey`, `setSetting`, `removeKey` and `removeSection` all searched the whole file, so
  the most ordinary consumer loop — walk the sections, read each one's keys — was quadratic:
  about 900 ms for 4,000 sections and 1,100 ms for 8,000 keys in one section. The index the
  parser already builds is now kept, taking both to a couple of milliseconds.

### Tests

- The suite now runs against a real temporary directory. It previously mocked `fs` and
  `path` wholesale, which is why none of the issues above were caught — one test even
  asserted the broken `fs.unwatchFile` behavior. 157 tests cover parsing, locking, atomic
  writes, injection rejection, path containment, watching, listener isolation,
  line-ending and encoding fidelity, lookup and parse performance, two caches sharing one
  file, concurrent saves, write atomicity under concurrent readers, and a deterministic
  round-trip fuzz over 150 generated files plus a mutation fuzz asserting the ordered and
  indexed views of the settings never disagree, and guards on the published declarations
  and package entry points.

## [2.0.5] - 2026-05-19

### Changed

- Import `@mdaemon/emitter` from the package root and update the build.

## [2.0.0] - 2026-01-08

### Added

- `getBool` and `getInt` for reading typed settings.

## [1.1.2] - 2025-04-24

### Changed

- Updated dependencies.

## [1.1.1] - 2025-03-14

### Changed

- Updated dependencies.

## [1.1.0] - 2024-12-15

### Changed

- `save`, `cacheFileSettings` and the internal lock helper became async.

## [1.0.1] - 2024-10-08

### Fixed

- Added missing TypeScript declarations.

## [1.0.0] - 2024-10-08

- Initial release of `@mdaemon/ini-file-cache`.
