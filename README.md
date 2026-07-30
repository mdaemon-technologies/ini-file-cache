[![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fini-file-cache%2Fmain%2Fpackage.json&query=%24.version&prefix=v&label=npm&color=blue)](https://www.npmjs.com/package/@mdaemon/ini-file-cache) [![Static Badge](https://img.shields.io/badge/node-v16%2B-blue?style=flat&label=node&color=blue)](https://nodejs.org) [![install size](https://packagephobia.com/badge?p=@mdaemon/ini-file-cache)](https://packagephobia.com/result?p=@mdaemon/ini-file-cache) [![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmdaemon-technologies%2Fini-file-cache%2Fmain%2Fpackage.json&query=%24.license&prefix=v&label=license&color=green)](https://github.com/mdaemon-technologies/ini-file-cache/blob/main/LICENSE) [![Node.js CI](https://github.com/mdaemon-technologies/ini-file-cache/actions/workflows/node.js.yml/badge.svg)](https://github.com/mdaemon-technologies/ini-file-cache/actions/workflows/node.js.yml)

# @mdaemon/ini-file-cache, A library for reading, writing, and watching ini files for changes

 Not applicable to a browser context.

# Install #

    $ npm install @mdaemon/ini-file-cache --save

# Node CommonJS #
```javascript
   const IniFileCache = require("@mdaemon/ini-file-cache");
```
# Node Modules #
```javascript
   import IniFileCache from "@mdaemon/ini-file-cache";
```
# TypeScript #

Types ship with the package and are resolved for both entry points, so `import` and
`require` are each typed correctly under `node16`, `nodenext`, `bundler` and classic
`node` module resolution. `require()` returns the class itself, not a module namespace.

```typescript
   import IniFileCache, { IIniFileCacheOptions, IIniFileCacheListener } from "@mdaemon/ini-file-cache";
```
### IniFileCache ###

```javascript
// Create a new IniFileCache instance
const iniCache = new IniFileCache("/path/to/file/", "config.ini");

// Read a value from the ini file
const value = iniCache.getSetting("section", "key", "defaultValue");
console.log(value);

// Read typed values
const enabled = iniCache.getBool("section", "enabled", false);
const port = iniCache.getInt("section", "port", 8080);

// Write a value to the ini file
iniCache.setSetting("section", "key", "new value");

// Save changes to the file (resolves false if the file could not be written)
const saved = await iniCache.save();

// Watching starts automatically; watch() is a no-op while already watching
iniCache.watch();

// Stop watching the file
iniCache.unwatch();

// Get all sections
const sections = iniCache.getSections();
console.log(sections);

// Get all keys in a section
const keys = iniCache.getKeys("section");
console.log(keys);

// Check if a section exists
const sectionExists = iniCache.hasSection("section");
console.log(sectionExists);

// Check if a key exists in a section
const keyExists = iniCache.hasKey("section", "key");
console.log(keyExists);

// Remove a key from a section
iniCache.removeKey("section", "key");

// Remove an entire section
iniCache.removeSection("section");

// Reload the file from disk
await iniCache.reload();

iniCache.listener.on("change", (filename) => { });

iniCache.listener.on("error", (error) => { });

iniCache.listener.on("reload", (filePath) => { });

iniCache.listener.on("save", (filePath) => { });

```

## API ##

### Constructor ###

#### `new IniFileCache(cachePath: string, fileName: string, options?: IIniFileCacheOptions)` ####

Creates a new instance for the ini file located at `cachePath` / `fileName`. The
directory is created recursively if it does not exist, and an empty file is created
if the ini file is missing. The file contents are read and cached synchronously, so
settings are available as soon as the constructor returns, and the file is watched
for changes automatically.

`fileName` may name a file in a subdirectory, reach a sibling directory with `..`, or
be an absolute path — the two arguments are simply joined and resolved. An empty
`cachePath` or `fileName` throws a `TypeError`.

If `fileName` comes from somewhere untrusted, set `restrictToCachePath: true` to
require the resolved path to stay inside `cachePath`.

```javascript
const iniCache = new IniFileCache("/etc/myapp/", "config.ini");

const caseInsensitiveCache = new IniFileCache("/etc/myapp/", "config.ini", {
  caseInsensitive: true,
  maxFileSize: 1024 * 1024,
  debounceDelay: 100
});
```

#### `IIniFileCacheOptions` ####

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxFileSize` | `number` | `10485760` (10 MB) | Largest file that will be read. A larger file emits `error` and leaves the cached settings untouched. |
| `caseInsensitive` | `boolean` | `false` | Match section names and keys without regard to case. |
| `debounceDelay` | `number` | `50` | Milliseconds used to coalesce the multiple change events most platforms emit for a single write. |
| `restrictToCachePath` | `boolean` | `false` | Require the resolved file to stay inside `cachePath`, rejecting `..` and absolute paths that leave it. Off by default, since both arguments normally come from the application. |
| `encoding` | `BufferEncoding` | `"utf8"` | Character encoding of the file. Use `"latin1"` for a legacy single-byte file. |

Each option is validated: `maxFileSize` must be a finite number of at least 1 and
`debounceDelay` a finite number of at least 0, so a computed `NaN` cannot silently
disable the size limit. `Infinity` is rejected for the same reason — pass an explicit
large number to effectively remove the cap.

### Properties ###

#### `listener: IIniFileCacheListener` ####

Read-only accessor that returns the internal [`@mdaemon/emitter`](https://www.npmjs.com/package/@mdaemon/emitter)
instance used to emit `change`, `error`, `reload`, `save`, and `close` events. It is typed
as `IIniFileCacheListener`, which declares the `on`, `once`, `off` and `emit` methods this
library supports, with the handler signature of each event:

```typescript
import IniFileCache, { IIniFileCacheListener, IIniFileCacheOptions } from "@mdaemon/ini-file-cache";

const listener: IIniFileCacheListener = iniCache.listener;
listener.on("change", (filename) => { });  // filename: string
listener.on("error", (error) => { });      // error: Error
listener.off("change");
```

### Reading Settings ###

#### `getSetting(section: string, key: string, defaultValue?: string | null): string | null` ####

Returns the cached string value for `key` in `section`. If the section or the key
does not exist, `defaultValue` is returned, which defaults to `null`.

```javascript
const host = iniCache.getSetting("Server", "Host", "localhost");
const missing = iniCache.getSetting("Server", "NotThere"); // null
const empty = iniCache.getSetting("Server", "NotThere", ""); // ""
```

#### `getBool(section: string, key: string, defaultValue?: boolean): boolean` ####

Returns the value for `key` interpreted as a boolean. `t`, `true`, `y`, `yes`, `on`
and `1` are `true`; `f`, `false`, `n`, `no`, `off` and `0` are `false`. Matching is
case-insensitive. If the setting is missing, empty, or is not one of those values,
`defaultValue` is returned (defaults to `false`).

```javascript
// [Server]
// Enabled=Yes
const enabled = iniCache.getBool("Server", "Enabled"); // true
const debug = iniCache.getBool("Server", "Debug", true); // true (not set)
```

#### `getInt(section: string, key: string, defaultValue?: number): number` ####

Returns the value for `key` parsed as a base-10 integer. The value must be digits
with an optional leading sign, and must be a safe integer. Anything else — a missing
or empty setting, a decimal, a hex literal, trailing characters, or a magnitude
beyond `Number.MAX_SAFE_INTEGER` — returns `defaultValue` (defaults to `0`) rather
than a partially parsed number.

```javascript
// [Server]
// Port=8080
const port = iniCache.getInt("Server", "Port", 25); // 8080
const timeout = iniCache.getInt("Server", "Timeout", 30); // 30 (not set)

// "123abc", "12.34" and "0x10" all return the default, not 123, 12 or 0.
```

#### `getSections(): string[]` ####

Returns the names of all cached sections.

```javascript
const sections = iniCache.getSections(); // ["Server", "Logging"]
```

#### `getKeys(section: string): string[]` ####

Returns the keys within `section`, or an empty array if the section does not exist.

```javascript
const keys = iniCache.getKeys("Server"); // ["Host", "Port"]
```

#### `hasSection(section: string): boolean` ####

Returns `true` if the section exists in the cache.

```javascript
if (iniCache.hasSection("Logging")) { }
```

#### `hasKey(section: string, key: string): boolean` ####

Returns `true` if `key` exists within `section`.

```javascript
if (iniCache.hasKey("Server", "Port")) { }
```

### Writing Settings ###

#### `setSetting(section: string, key: string, value: string): void` ####

Sets `key` to `value` in the cache, creating the section and/or key if needed.
This only updates the in-memory cache — call `save()` to persist the change.
The section name, key and value are trimmed, so the cached value always matches
what a save-and-reload cycle produces. An empty `section` addresses the nameless
section holding any settings that precede the first header.

Throws a `TypeError` if any argument would produce an ini file that does not
round-trip:

- a value containing a line break or null character;
- a section name or key containing `]`, `=`, a line break or a null character;
- a key starting with `;` or `#`, which would be read back as a comment;
- a key starting with `[`, which could be read back as a section header — `[a] ;x=v`
  matches the header pattern, so such a key would return as a section and take its
  value with it.

Brackets and comment characters elsewhere in a key (`a[0]`, `a;b`) are unambiguous and
allowed, as are comment characters anywhere in a section name. Without this validation
a value such as `"bob\nAdmin=true"` would forge an extra setting on the next read, so
validate or catch when storing untrusted input.

```javascript
iniCache.setSetting("Server", "Port", "8080");
await iniCache.save();

try {
  iniCache.setSetting("Profile", "DisplayName", untrustedInput);
} catch (error) {
  // untrustedInput contained characters that are not valid in an ini file
}
```

#### `removeKey(section: string, key: string): void` ####

Removes `key` from `section` in the cache. Does nothing if either does not exist.
Call `save()` to persist the change.

```javascript
iniCache.removeKey("Server", "Port");
```

#### `removeSection(section: string): void` ####

Removes the entire section, including all of its keys, from the cache. Call
`save()` to persist the change.

```javascript
iniCache.removeSection("Logging");
```

#### `save(): Promise<boolean>` ####

Serializes the cached sections back to ini format and writes them to the file.
Resolves `true` when the file was written and `false` otherwise, and emits `save`
with the file path on success or `error` on failure.

The write is guarded by a `<file>.lck` lock file, created with an exclusive open so
two processes can never hold it at once and stamped with a token so it is only ever
removed by the writer that took it. If the lock cannot be acquired within about two
seconds, `save()` emits `error` and resolves `false` rather than writing over another
writer; locks older than ten seconds are treated as abandoned and broken.

Contents are written to `<file>.tmp` and renamed into place, so a concurrent reader
never sees a half-written file. Windows refuses to rename over a file another process
holds open, so after a few short retries the write falls back to an in-place write,
which that platform does allow. The fallback is not atomic — a reader can briefly
observe a partial file — but a save that fails outright is worse.

A save does not emit `change` and does not trigger a reload of the file it just
wrote, so a `setSetting` made immediately afterwards is not reverted.

The file's existing line endings and UTF-8 byte order mark are preserved: a file read
as CRLF is written back as CRLF, and a BOM is restored. A file that has neither — a
new or empty one — is written with LF and no BOM. Saving is idempotent, so
save → reload → save produces byte-identical output.

If the file is a symbolic link, the save writes through it rather than replacing the
link with a regular file.

If the file could not be decoded losslessly with the configured `encoding`, `save()`
emits `error` and resolves `false` instead of writing — see **Encoding** below.

```javascript
if (!await iniCache.save()) {
  // the file was not written
}
```

### Loading and Parsing ###

#### `cacheFileSettings(): Promise<boolean>` ####

Reads the file from disk and refreshes the in-memory cache, retrying up to 20 times
at 100 ms intervals on read failure. Resolves `true` when the file was both read and
parsed. Emits `error` and resolves `false` if the file cannot be read, is larger than
`maxFileSize`, or does not parse — leaving the cached settings untouched in every case.
Always resolves; it never rejects. Called automatically by `reload()` and the watcher.

```javascript
await iniCache.cacheFileSettings();
```

#### `reload(): Promise<boolean>` ####

Re-reads the file from disk (via `cacheFileSettings()`). Resolves `true` and emits
`reload` with the file path when the cache was refreshed; resolves `false` without
emitting `reload` when the file could not be read or did not parse, in which case the
cached settings are unchanged and an `error` has already been emitted.

```javascript
if (!await iniCache.reload()) {
  // the cache still holds the previous settings
}
```

#### `parseContents(contents: string): boolean` ####

Parses raw ini text into the in-memory cache, resolving `true` when the content was
accepted and `false` when it was rejected and an `error` emitted:

- A leading UTF-8 byte order mark is stripped, and remembered so `save()` restores it.
- `[name]` lines start a section. Whitespace inside the brackets is trimmed, and a
  trailing `;` or `#` comment on the same line is ignored.
- Settings that appear **before any header** are kept in a nameless section addressed as
  `""` — `getSetting("", "Key")` — and written back at the top of the file without a
  header. If that section is not first, or is the only section, it is written with a
  literal `[]` header instead, since bare keys would otherwise be read back as part of
  the section above them or leave the file with no header at all.
- A file containing settings but no header at all is treated as malformed, since that is
  far more likely a truncated read than an ini file. The cached settings are left alone,
  and until the file parses successfully at least once `save()` refuses to write — an
  empty cache there means "nothing was understood", not "there are no settings", and
  writing it would destroy the file.
- Lines beginning with `;` or `#`, and blank lines, are ignored. A `;` or `#` inside a
  value is **not** treated as an inline comment, so passwords and URLs keep them.
- Every other line is split on its **first** `=`, so values may contain `=`. The key
  and value are trimmed. A line with no `=` becomes a key with an empty value, and a
  line with no key (`=value`) is ignored.
- CRLF, LF and lone CR line endings are all accepted; the first one seen is what
  `save()` writes back.
- A repeated `[name]` header continues the existing section rather than creating a
  second one, and a repeated key overwrites the earlier value.

If the text contains settings but no section header at all, the cached settings are
left untouched and an `error` event is emitted with `Invalid ini file format` — a
truncated read must not be allowed to empty the cache, since the next `save()` would
write that emptiness to disk.

An empty file, or one containing only comments, is valid and yields no sections.

```javascript
iniCache.parseContents("[Server]\nPort=8080\n");
```

### Watching ###

#### `watch(): void` ####

Begins watching for changes to the file. Called automatically by the constructor, and
a no-op while already watching. When the file changes the cache is refreshed and a
`change` event is emitted; events are debounced by `debounceDelay` so the several
notifications most platforms emit for a single write collapse into one. Watcher
errors are forwarded as `error` events, and closing the watcher emits `close`. If the
watcher cannot be created, an `error` event with `Failed to watch file` is emitted.

The containing directory is watched rather than the file itself, with events filtered
by filename. A watcher bound directly to a file stops working once that file is
replaced, which is how most editors — and `save()` — write.

```javascript
iniCache.watch();
```

#### `unwatch(): void` ####

Closes the watcher and cancels any pending change. Safe to call more than once. No
further `change` events are emitted and the file is no longer re-read.

```javascript
iniCache.unwatch();
```

### Encoding ###

Files are read and written as UTF-8 by default. A legacy single-byte file — windows-1252
or ISO-8859-1 — is **not** valid UTF-8: every high byte decodes to the replacement
character `U+FFFD`, and writing that back would replace bytes the library never touched.
`k=été` stored as `65 74 65` with high bytes would come back as `EF BF BD`, corrupting
the file.

The library detects this by re-encoding what it decoded and comparing the bytes. When
they differ it emits `error` on read, and `save()` refuses to write, so a mis-configured
encoding costs you a failed save rather than a mangled file. Pass the right encoding to
resolve it:

```javascript
const iniCache = new IniFileCache("/etc/myapp/", "legacy.ini", { encoding: "latin1" });
```

`latin1` maps every byte one-to-one, so such a file round-trips exactly. Any encoding
accepted by `Buffer` is valid; an unsupported name throws a `TypeError`.

### Concurrency ###

The cache follows the file. When the watched file changes on disk, the new contents
replace what is in memory — including any `setSetting` you have not saved yet. Code that
does read-modify-write should `save()` promptly rather than holding unsaved changes
across an interval where another process might write.

### Events ###

Subscribe through the `listener` property.

| Event | Payload | Emitted when |
| --- | --- | --- |
| `change` | `filename: string` | The watched file changed on disk and the cache was successfully refreshed. Not emitted for the library's own saves, nor when the reload failed |
| `reload` | `filePath: string` | `reload()` refreshed the cache. Not emitted when the read or the parse failed |
| `save` | `filePath: string` | `save()` successfully wrote the file |
| `error` | `error: Error` | A read, write, parse, lock, or watch failure occurred |
| `close` | none | The file watcher closed |

```javascript
iniCache.listener.on("change", (filename) => { });
iniCache.listener.on("reload", (filePath) => { });
iniCache.listener.on("save", (filePath) => { });
iniCache.listener.on("error", (error) => { });
iniCache.listener.on("close", () => { });
```

An exception thrown by one of your listeners is caught and re-emitted as `error`
rather than propagating. A listener cannot, for example, make a successful `save()`
report failure, and a listener on a file-change event cannot terminate the process
with an unhandled rejection. An exception thrown by an `error` listener is discarded,
since reporting it would loop.

Errors raised while the constructor runs — an unreadable or malformed file, or one
over `maxFileSize` — are emitted asynchronously, so a listener attached immediately
after `new IniFileCache(...)` still receives them.

# Changelog #

See [changelog.md](https://github.com/mdaemon-technologies/ini-file-cache/blob/main/changelog.md).
Version 2.1.0 tightens input handling in ways that reject or reinterpret input earlier
versions accepted — read its notes before upgrading.

# License #

Published under the [LGPL-2.1 license](https://github.com/mdaemon-technologies/ini-file-cache/blob/main/LICENSE "LGPL-2.1 License").

Published by<br/> 
<b>MDaemon Technologies, Ltd.<br/>
Simple Secure Email</b><br/>
[https://www.mdaemon.com](https://www.mdaemon.com)