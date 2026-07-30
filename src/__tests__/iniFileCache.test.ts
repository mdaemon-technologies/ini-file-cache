import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import IniFileCache, { IIniFileCacheOptions } from '../iniFileCache';

// These tests run against a real temporary directory. Mocking fs hides exactly the
// behaviour that matters here: parsing, locking, atomic writes and file watching.

let dir: string;
const instances: IniFileCache[] = [];

function create(name: string, contents?: string, options?: IIniFileCacheOptions): IniFileCache {
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  const cache = new IniFileCache(dir, name, options);
  instances.push(cache);
  return cache;
}

function collectErrors(cache: IniFileCache): Error[] {
  const errors: Error[] = [];
  cache.listener.on('error', (error: Error) => errors.push(error));
  return errors;
}

function read(name: string): string {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a condition instead of for a fixed duration. File watching latency varies a
 * lot with load, so a sleep long enough to be reliable on a busy machine makes the suite
 * slow, and a shorter one makes it flaky.
 */
async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await wait(20);
  }
}

/** Lets any further events land, so "exactly one" assertions are meaningful. */
const settle = () => wait(250);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ini-file-cache-'));
});

afterEach(() => {
  while (instances.length) {
    instances.pop()!.unwatch();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('constructor', () => {
  test('does not truncate a file that already has contents', () => {
    // The file is created with an exclusive open, so a file that appears between the
    // existence check and the write is adopted rather than blanked.
    fs.writeFileSync(path.join(dir, 'existing.ini'), '[S]\nk=v\n');
    const cache = new IniFileCache(dir, 'existing.ini');
    instances.push(cache);
    expect(cache.getSetting('S', 'k')).toBe('v');
    expect(read('existing.ini')).toBe('[S]\nk=v\n');
  });

  test('creates the cache directory and the file when missing', () => {
    const nested = path.join(dir, 'nested', 'deeper');
    const cache = new IniFileCache(nested, 'created.ini');
    instances.push(cache);
    expect(fs.existsSync(path.join(nested, 'created.ini'))).toBe(true);
  });

  test('allows a fileName that reaches a sibling directory with ".."', async () => {
    const sibling = path.join(dir, 'sibling');
    const from = path.join(dir, 'start');
    fs.mkdirSync(sibling);
    fs.mkdirSync(from);

    const cache = new IniFileCache(from, path.join('..', 'sibling', 'shared.ini'));
    instances.push(cache);

    expect(fs.existsSync(path.join(sibling, 'shared.ini'))).toBe(true);
    cache.setSetting('S', 'k', 'v');
    expect(await cache.save()).toBe(true);
    expect(fs.readFileSync(path.join(sibling, 'shared.ini'), 'utf8')).toBe('[S]\nk=v\n\n');
  });

  test('allows an absolute fileName', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ini-outside-'));
    try {
      const target = path.join(outside, 'absolute.ini');
      const cache = new IniFileCache(dir, target);
      instances.push(cache);
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('allows a fileName in a subdirectory of the cache path', () => {
    const cache = new IniFileCache(dir, path.join('sub', 'nested.ini'));
    instances.push(cache);
    expect(fs.existsSync(path.join(dir, 'sub', 'nested.ini'))).toBe(true);
  });

  test('restrictToCachePath rejects a fileName that escapes the cache path', () => {
    expect(() => new IniFileCache(dir, '../escaped.ini', { restrictToCachePath: true }))
      .toThrow(/outside of the cache path/);
    expect(() => new IniFileCache(dir, path.join('..', '..', 'escaped.ini'), { restrictToCachePath: true }))
      .toThrow(/outside of the cache path/);
    expect(() => new IniFileCache(dir, path.join(os.tmpdir(), 'absolute.ini'), { restrictToCachePath: true }))
      .toThrow(/outside of the cache path/);
    expect(fs.existsSync(path.join(dir, '..', 'escaped.ini'))).toBe(false);
  });

  test('restrictToCachePath accepts a path differing only in case on Windows', () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return;
    }
    const swapped = dir.toUpperCase();
    const cache = new IniFileCache(dir, path.join(swapped, 'cased.ini'), { restrictToCachePath: true });
    instances.push(cache);
    expect(fs.existsSync(path.join(dir, 'cased.ini'))).toBe(true);
  });

  test('restrictToCachePath still allows a subdirectory', () => {
    const cache = new IniFileCache(dir, path.join('sub', 'nested.ini'), { restrictToCachePath: true });
    instances.push(cache);
    expect(fs.existsSync(path.join(dir, 'sub', 'nested.ini'))).toBe(true);
  });

  test('rejects empty arguments', () => {
    expect(() => new IniFileCache('', 'test.ini')).toThrow(TypeError);
    expect(() => new IniFileCache(dir, '')).toThrow(TypeError);
  });

  test('settings are available synchronously after construction', () => {
    const cache = create('sync.ini', '[Server]\nPort=8080\n');
    expect(cache.getSetting('Server', 'Port')).toBe('8080');
  });

  test('rejects invalid options', () => {
    expect(() => new IniFileCache(dir, 'opts.ini', { maxFileSize: NaN })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', { maxFileSize: -1 })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', { maxFileSize: 0 })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', { maxFileSize: Infinity })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', { debounceDelay: -1 })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', { caseInsensitive: 'yes' as any })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', { restrictToCachePath: 'yes' as any })).toThrow(TypeError);
    expect(() => new IniFileCache(dir, 'opts.ini', null as any)).toThrow(TypeError);
    // Validation happens before anything is created on disk.
    expect(fs.existsSync(path.join(dir, 'opts.ini'))).toBe(false);
  });

  test('accepts a zero debounce delay', () => {
    const cache = create('zero-debounce.ini', '[S]\nk=1\n', { debounceDelay: 0 });
    expect(cache.getSetting('S', 'k')).toBe('1');
  });

  test('errors raised during construction reach a listener attached right after', async () => {
    fs.writeFileSync(path.join(dir, 'ctor-error.ini'), 'content with no section header\n');
    const cache = new IniFileCache(dir, 'ctor-error.ini');
    instances.push(cache);
    const errors = collectErrors(cache);

    await wait(50);

    expect(errors.map((e) => e.message)).toContain('Invalid ini file format');
  });
});

describe('parseContents', () => {
  test('parses sections and keys', () => {
    const cache = create('parse.ini', '');
    cache.parseContents(`
      [Section1]
      key1=value1
      key2=value2

      [Section2]
      key3=value3
    `);
    expect(cache.getSections()).toEqual(['Section1', 'Section2']);
    expect(cache.getKeys('Section1')).toEqual(['key1', 'key2']);
    expect(cache.getSetting('Section2', 'key3')).toBe('value3');
  });

  test('an empty file is valid and produces no error', () => {
    const cache = create('empty.ini', '');
    const errors = collectErrors(cache);
    cache.parseContents('');
    expect(errors).toEqual([]);
    expect(cache.getSections()).toEqual([]);
  });

  test('a comment-only file is valid and produces no error', () => {
    const cache = create('comments.ini', '; a comment\n# another comment\n');
    const errors = collectErrors(cache);
    cache.parseContents('; a comment\n# another comment\n');
    expect(errors).toEqual([]);
    expect(cache.getSections()).toEqual([]);
  });

  test('keeps settings that appear before the first section header', async () => {
    const cache = create('globals.ini', 'Global1=a\nGlobal2=b\n[S]\nk=v\n');
    const errors = collectErrors(cache);

    expect(cache.getSections()).toEqual(['', 'S']);
    expect(cache.getSetting('', 'Global1')).toBe('a');
    expect(cache.getKeys('')).toEqual(['Global1', 'Global2']);
    expect(errors).toEqual([]);

    await cache.save();
    // Written back with no header, exactly as they were read.
    expect(read('globals.ini')).toBe('Global1=a\nGlobal2=b\n\n[S]\nk=v\n\n');
    await cache.reload();
    expect(cache.getSetting('', 'Global2')).toBe('b');
    expect(cache.getSetting('S', 'k')).toBe('v');
  });

  test('a file with no section header at all is still treated as malformed', () => {
    const cache = create('headerless.ini', '[S]\nk=v\n');
    const errors = collectErrors(cache);
    // A truncated read that lost every header must not replace the cache.
    cache.parseContents('Global1=a\nGlobal2=b\n');
    expect(errors.map((e) => e.message)).toEqual(['Invalid ini file format']);
    expect(cache.getSetting('S', 'k')).toBe('v');
  });

  test('preserves a literal "[]" header rather than dropping it', async () => {
    const cache = create('empty-header.ini', '[]\nk=v\n[S]\nx=1\n');
    expect(cache.getSections()).toEqual(['', 'S']);
    expect(cache.getSetting('', 'k')).toBe('v');
    await cache.save();
    expect(read('empty-header.ini')).toBe('[]\nk=v\n\n[S]\nx=1\n\n');
  });

  test('writes a "[]" header when the nameless section is not first', async () => {
    const cache = create('nameless-late.ini', '[S]\nx=1\n');
    cache.setSetting('', 'global', 'g');
    await cache.save();
    // Without the header these keys would be read back as part of [S].
    expect(read('nameless-late.ini')).toBe('[S]\nx=1\n\n[]\nglobal=g\n\n');
    await cache.reload();
    expect(cache.getSetting('', 'global')).toBe('g');
    expect(cache.getKeys('S')).toEqual(['x']);
  });

  test('a nameless-only cache is written with a "[]" header so it can be read back', async () => {
    const cache = create('only-global.ini', '');
    cache.setSetting('', 'k', 'v');
    expect(await cache.save()).toBe(true);
    // Without the header the file would have no section at all and would not parse.
    expect(read('only-global.ini')).toBe('[]\nk=v\n\n');

    await cache.reload();
    expect(cache.getSetting('', 'k')).toBe('v');

    const reopened = new IniFileCache(dir, 'only-global.ini');
    instances.push(reopened);
    const errors = collectErrors(reopened);
    await wait(30);
    expect(errors).toEqual([]);
    expect(reopened.getSetting('', 'k')).toBe('v');
  });

  test('emptying the nameless section keeps save and reload byte-identical', async () => {
    const cache = create('emptied-global.ini', 'g=1\n[S]\nk=v\n');
    cache.removeKey('', 'g');
    await cache.save();
    const first = read('emptied-global.ini');
    await cache.reload();
    await cache.save();

    expect(first).toBe('[S]\nk=v\n\n');
    expect(read('emptied-global.ini')).toBe(first);
  });

  test('a non-string section does not resolve to the nameless section', () => {
    const cache = create('nonstring-section.ini', 'g=1\n[S]\nk=v\n');
    expect(cache.getSetting(undefined as any, 'g')).toBeNull();
    expect(cache.getSetting(null as any, 'g')).toBeNull();
    expect(cache.hasSection(undefined as any)).toBe(false);
    expect(cache.getKeys(null as any)).toEqual([]);
    // The nameless section itself is still reachable by its real name.
    expect(cache.getSetting('', 'g')).toBe('1');
  });

  test('setSetting("") addresses the nameless section', () => {
    const cache = create('set-global.ini', 'Global1=a\n[S]\nk=v\n');
    cache.setSetting('', 'Global1', 'changed');
    cache.setSetting('  ', 'Global2', 'added');
    expect(cache.getSetting('', 'Global1')).toBe('changed');
    expect(cache.getSetting('', 'Global2')).toBe('added');
    expect(cache.getSections()).toEqual(['', 'S']);
  });

  test('reports whether the content was accepted', () => {
    const cache = create('parse-result.ini', '[S]\nk=v\n');
    collectErrors(cache);
    expect(cache.parseContents('[T]\nx=1\n')).toBe(true);
    expect(cache.parseContents('no header here\n')).toBe(false);
    expect(cache.parseContents(42 as any)).toBe(false);
    expect(cache.getSections()).toEqual(['T']);
  });

  test('malformed content emits an error and leaves the cache intact', () => {
    const cache = create('malformed.ini', '[Server]\nPort=8080\n');
    const errors = collectErrors(cache);
    cache.parseContents('this file lost its section header\n');
    expect(errors.map((e) => e.message)).toEqual(['Invalid ini file format']);
    expect(cache.getSetting('Server', 'Port')).toBe('8080');
  });

  test('keeps everything after the first "=" as the value', () => {
    const cache = create('equals.ini', '[Auth]\nPassword=p@ss=word==\nUrl=http://x/?a=1&b=2\n');
    expect(cache.getSetting('Auth', 'Password')).toBe('p@ss=word==');
    expect(cache.getSetting('Auth', 'Url')).toBe('http://x/?a=1&b=2');
  });

  test('trims whitespace around keys, values and section names', () => {
    const cache = create('spaces.ini', '[ Server ]\n  Host  =  localhost  \n');
    expect(cache.getSections()).toEqual(['Server']);
    expect(cache.getKeys('Server')).toEqual(['Host']);
    expect(cache.getSetting('Server', 'Host')).toBe('localhost');
  });

  test('a key with no "=" yields an empty value, never undefined', async () => {
    const cache = create('bare.ini', '[Server]\nstraykey\n');
    expect(cache.getSetting('Server', 'straykey')).toBe('');
    expect(cache.getBool('Server', 'straykey', true)).toBe(true);
    expect(await cache.save()).toBe(true);
    expect(read('bare.ini')).toBe('[Server]\nstraykey=\n\n');
  });

  test('ignores an inline comment after a section header', () => {
    const cache = create('inline.ini', '[Server] ; the server section\nPort=25\n');
    expect(cache.getSections()).toEqual(['Server']);
    expect(cache.getSetting('Server', 'Port')).toBe('25');
  });

  test('merges duplicate sections and lets the last duplicate key win', () => {
    const cache = create('dupe.ini', '[S]\nk=first\nother=1\n[S]\nk=second\n');
    expect(cache.getSections()).toEqual(['S']);
    expect(cache.getSetting('S', 'k')).toBe('second');
    expect(cache.getKeys('S')).toEqual(['k', 'other']);
  });

  test('parses a large section in linear time', () => {
    const count = 40000;
    const lines = ['[S]'];
    for (let i = 0; i < count; i++) {
      lines.push(`key${i}=value${i}`);
    }
    const cache = create('large.ini', '');

    const started = Date.now();
    cache.parseContents(lines.join('\n'));
    const elapsed = Date.now() - started;

    expect(cache.getKeys('S')).toHaveLength(count);
    // Quadratic duplicate detection took ~21s for this input; linear takes well under a second.
    expect(elapsed).toBeLessThan(5000);
  }, 30000);

  test('strips a UTF-8 byte order mark and restores it on save', async () => {
    const cache = create('bom.ini', '﻿[Server]\nPort=25\n');
    expect(cache.getSections()).toEqual(['Server']);
    expect(cache.getSetting('Server', 'Port')).toBe('25');

    await cache.save();
    const bytes = fs.readFileSync(path.join(dir, 'bom.ini'));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    await cache.reload();
    expect(cache.getSetting('Server', 'Port')).toBe('25');
  });

  test('does not add a byte order mark to a file that had none', async () => {
    const cache = create('no-bom.ini', '[Server]\nPort=25\n');
    await cache.save();
    expect(fs.readFileSync(path.join(dir, 'no-bom.ini'))[0]).not.toBe(0xef);
  });

  test('preserves CRLF line endings on save', async () => {
    const cache = create('crlf.ini', '[S]\r\nk=v\r\n');
    expect(cache.getSetting('S', 'k')).toBe('v');

    cache.setSetting('S', 'k2', 'v2');
    await cache.save();

    const raw = read('crlf.ini');
    expect(raw).toBe('[S]\r\nk=v\r\nk2=v2\r\n\r\n');
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  test('preserves LF line endings on save', async () => {
    const cache = create('lf.ini', '[S]\nk=v\n');
    cache.setSetting('S', 'k2', 'v2');
    await cache.save();
    expect(read('lf.ini')).toBe('[S]\nk=v\nk2=v2\n\n');
  });

  test('normalizes a hand-edited file with mixed line endings', async () => {
    const cache = create('mixed-eol.ini', '[A]\r\nx=1\r\n[B]\ny=2\n[C]\r\nz=3\r\n');
    expect(cache.getSections()).toEqual(['A', 'B', 'C']);
    expect([cache.getSetting('A', 'x'), cache.getSetting('B', 'y'), cache.getSetting('C', 'z')])
      .toEqual(['1', '2', '3']);

    await cache.save();
    // The first ending seen wins, so the file comes out uniform rather than still mixed.
    const written = read('mixed-eol.ini');
    expect(written).not.toMatch(/[^\r]\n/);
    await cache.reload();
    expect(cache.getSections()).toEqual(['A', 'B', 'C']);
  });

  test('parses lone CR line endings', () => {
    const cache = create('cr.ini', '[S]\rk=v\r');
    expect(cache.getSetting('S', 'k')).toBe('v');
  });

  test('a new file defaults to LF', async () => {
    const cache = create('brand-new.ini', '');
    cache.setSetting('S', 'k', 'v');
    await cache.save();
    expect(read('brand-new.ini')).toBe('[S]\nk=v\n\n');
  });

  test('save, reload and save again is byte-identical', async () => {
    const cache = create('idempotent.ini', '[A]\nx=1\n\n[B]\ny=2\n');
    await cache.save();
    const first = read('idempotent.ini');
    await cache.reload();
    await cache.save();
    const second = read('idempotent.ini');
    await cache.reload();
    await cache.save();
    expect(second).toBe(first);
    expect(read('idempotent.ini')).toBe(first);
  });

  test('keeps a section that has no keys', async () => {
    const cache = create('empty-section.ini', '[Empty]\n[Full]\nk=v\n');
    expect(cache.getSections()).toEqual(['Empty', 'Full']);
    expect(cache.getKeys('Empty')).toEqual([]);

    await cache.save();
    await cache.reload();
    expect(cache.getSections()).toEqual(['Empty', 'Full']);
  });

  test('does not treat ";" or "#" inside a value as an inline comment', async () => {
    const cache = create('inline-value.ini', '[S]\npass=a;b#c\n');
    expect(cache.getSetting('S', 'pass')).toBe('a;b#c');
    await cache.save();
    await cache.reload();
    expect(cache.getSetting('S', 'pass')).toBe('a;b#c');
  });

  test('round-trips non-ASCII section names, keys and values', async () => {
    const cache = create('unicode.ini', '');
    cache.setSetting('Café', 'naïve', '日本語 — ok');
    await cache.save();
    await cache.reload();
    expect(cache.getSections()).toEqual(['Café']);
    expect(cache.getSetting('Café', 'naïve')).toBe('日本語 — ok');
  });

  test('ignores a line whose key is empty', () => {
    const cache = create('empty-key.ini', '[S]\n=orphan\nk=v\n');
    expect(cache.getKeys('S')).toEqual(['k']);
  });

  test('accepts content with no trailing newline', () => {
    const cache = create('no-trailing.ini', '[S]\nk=v');
    expect(cache.getSetting('S', 'k')).toBe('v');
  });

  test('does not treat "__proto__" as a special key', () => {
    const cache = create('proto.ini', '[S]\n__proto__=polluted\n');
    expect(cache.getSetting('S', '__proto__')).toBe('polluted');
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });
});

describe('encoding', () => {
  // "[S]\nk=<E9>t<E9>\n" — "été" in windows-1252, which is not valid UTF-8.
  const latin1Bytes = Buffer.from([0x5b, 0x53, 0x5d, 0x0a, 0x6b, 0x3d, 0xe9, 0x74, 0xe9, 0x0a]);

  test('reads a legacy single-byte file with encoding: latin1', async () => {
    fs.writeFileSync(path.join(dir, 'latin1.ini'), latin1Bytes);
    const cache = new IniFileCache(dir, 'latin1.ini', { encoding: 'latin1' });
    instances.push(cache);
    const errors = collectErrors(cache);
    await wait(30);

    expect(cache.getSetting('S', 'k')).toBe('été');
    expect(errors).toEqual([]);
  });

  test('a latin1 file survives a save byte for byte', async () => {
    fs.writeFileSync(path.join(dir, 'latin1-save.ini'), latin1Bytes);
    const cache = new IniFileCache(dir, 'latin1-save.ini', { encoding: 'latin1' });
    instances.push(cache);

    expect(await cache.save()).toBe(true);
    const after = fs.readFileSync(path.join(dir, 'latin1-save.ini'));
    expect(after.toString('hex')).toBe('5b535d0a6b3de974e90a0a');
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  test('refuses to save a file that could not be decoded losslessly', async () => {
    fs.writeFileSync(path.join(dir, 'mojibake.ini'), latin1Bytes);
    const cache = new IniFileCache(dir, 'mojibake.ini');
    instances.push(cache);
    const errors = collectErrors(cache);
    await wait(30);

    // The decode is reported rather than passing silently.
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('is not valid utf8')]);

    cache.setSetting('S', 'other', 'v');
    expect(await cache.save()).toBe(false);
    expect(errors.map((e) => e.message)).toContainEqual(expect.stringContaining('Refusing to save'));
    // The original bytes are untouched.
    expect(fs.readFileSync(path.join(dir, 'mojibake.ini')).equals(latin1Bytes)).toBe(true);
  });

  test('a valid UTF-8 file is never treated as lossy', async () => {
    const cache = create('valid-utf8.ini', '[S]\nk=été 日本語\n');
    const errors = collectErrors(cache);
    await wait(30);
    expect(errors).toEqual([]);
    expect(await cache.save()).toBe(true);
    expect(cache.getSetting('S', 'k')).toBe('été 日本語');
  });

  test('a genuine U+FFFD in a UTF-8 file is not mistaken for a bad decode', async () => {
    const cache = create('replacement.ini', '[S]\nk=a�b\n');
    const errors = collectErrors(cache);
    await wait(30);
    expect(errors).toEqual([]);
    expect(await cache.save()).toBe(true);
    expect(cache.getSetting('S', 'k')).toBe('a�b');
  });

  test('strips a byte order mark before decoding, so latin1 keeps its first section', async () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('[S]\nk=\xe9\n', 'latin1'),
    ]);
    fs.writeFileSync(path.join(dir, 'bom-latin1.ini'), original);
    const cache = new IniFileCache(dir, 'bom-latin1.ini', { encoding: 'latin1' });
    instances.push(cache);

    // Decoded after the mark is removed, so the header is a header and not three stray
    // characters glued to it.
    expect(cache.getSections()).toEqual(['S']);
    expect(cache.getSetting('S', 'k')).toBe('é');

    expect(await cache.save()).toBe(true);
    const after = fs.readFileSync(path.join(dir, 'bom-latin1.ini'));
    // The mark is written as its three bytes, not as latin1 0xFF.
    expect(after.subarray(0, 3).toString('hex')).toBe('efbbbf');
    expect(after.toString('hex')).toBe('efbbbf5b535d0a6b3de90a0a');
  });

  test('keeps a UTF-16 byte order mark as UTF-16, not UTF-8', async () => {
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[S]\nk=v\n', 'utf16le')]);
    fs.writeFileSync(path.join(dir, 'utf16.ini'), original);
    const cache = new IniFileCache(dir, 'utf16.ini', { encoding: 'utf16le' });
    instances.push(cache);
    const errors = collectErrors(cache);
    await wait(30);

    expect(cache.getSections()).toEqual(['S']);
    expect(cache.getSetting('S', 'k')).toBe('v');
    expect(errors).toEqual([]);

    expect(await cache.save()).toBe(true);
    const after = fs.readFileSync(path.join(dir, 'utf16.ini'));
    // Re-encoding U+FEFF per file would be right here but wrong for latin1, and the
    // fixed UTF-8 bytes would be wrong here; only the original bytes satisfy both.
    expect(after.subarray(0, 2).toString('hex')).toBe('fffe');
    expect(after.toString('utf16le')).toBe('﻿[S]\nk=v\n\n');
  });

  test('a byte-order-mark-only file round-trips', async () => {
    fs.writeFileSync(path.join(dir, 'bom-only.ini'), Buffer.from([0xef, 0xbb, 0xbf]));
    const cache = new IniFileCache(dir, 'bom-only.ini');
    instances.push(cache);
    const errors = collectErrors(cache);
    await wait(30);

    expect(errors).toEqual([]);
    expect(cache.getSections()).toEqual([]);
    expect(await cache.save()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'bom-only.ini')).toString('hex')).toBe('efbbbf');
  });

  test('parseContents given a leading U+FEFF adopts it as the mark', async () => {
    const cache = create('direct-bom.ini', '[S]\nk=v\n');
    cache.parseContents('﻿[T]\nx=1\n');
    expect(cache.getSections()).toEqual(['T']);
    expect(await cache.save()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'direct-bom.ini')).subarray(0, 3).toString('hex')).toBe('efbbbf');
  });

  test('a mark that disappears from the file is not re-added', async () => {
    fs.writeFileSync(path.join(dir, 'bom-gone.ini'), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('[S]\nk=v\n'),
    ]));
    const cache = new IniFileCache(dir, 'bom-gone.ini');
    instances.push(cache);
    cache.unwatch();

    fs.writeFileSync(path.join(dir, 'bom-gone.ini'), '[S]\nk=v\n');
    await cache.reload();
    expect(await cache.save()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'bom-gone.ini'))[0]).not.toBe(0xef);
  });

  test('rejects an unsupported encoding', () => {
    expect(() => new IniFileCache(dir, 'enc.ini', { encoding: 'klingon' as any })).toThrow(TypeError);
    expect(fs.existsSync(path.join(dir, 'enc.ini'))).toBe(false);
  });
});

describe('published declarations', () => {
  // These guard the shipped .d.ts against drifting from the class, and the package
  // entry points against the mistakes that make a correct .d.ts unreachable.
  const root = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declarationPath = path.join(root, pkg.types);
  const hasBuild = fs.existsSync(declarationPath);

  const declaration = hasBuild ? fs.readFileSync(declarationPath, 'utf8') : '';

  test('the declaration exists and is what package.json points at', () => {
    expect(pkg.types).toBe(pkg.typings);
    expect(hasBuild).toBe(true);
  });

  // The intended public surface. TypeScript's `private` is compile-time only, so the
  // runtime prototype cannot tell us this — it has to be stated.
  const PUBLIC_API = [
    'listener',
    'parseContents',
    'cacheFileSettings',
    'getSetting',
    'getBool',
    'getInt',
    'setSetting',
    'getSections',
    'getKeys',
    'hasSection',
    'hasKey',
    'removeSection',
    'removeKey',
    'reload',
    'save',
    'watch',
    'unwatch',
  ];

  /**
   * Members the class declaration gives a signature to. Private ones are emitted as
   * `private x;` with no parentheses, so they do not match. Scoped to the class body so
   * the exported interfaces' own members are not mistaken for class members.
   */
  function declaredMembers(): string[] {
    const lines = declaration.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith('export default class IniFileCache'));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && line === '}');
    expect(end).toBeGreaterThan(start);

    return lines
      .slice(start + 1, end)
      .map((line) => /^ {4}(?:get )?([A-Za-z_]\w*)\(/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1])
      .filter((name) => name !== 'constructor');
  }

  test('every public member is declared with a signature', () => {
    if (!hasBuild) return;
    const declared = declaredMembers();
    for (const member of PUBLIC_API) {
      expect(declared.includes(member) ? member : `${member} (missing from ${pkg.types})`).toBe(member);
      // It must also actually exist at runtime.
      const onPrototype = Object.getOwnPropertyNames(IniFileCache.prototype).includes(member);
      expect(onPrototype ? member : `${member} (missing from the class)`).toBe(member);
    }
  });

  test('the declaration exposes nothing beyond the public surface', () => {
    if (!hasBuild) return;
    // Catches a private helper accidentally losing its `private` keyword, which would
    // publish an internal as part of the supported API.
    for (const member of declaredMembers()) {
      expect(PUBLIC_API.includes(member) ? member : `${member} (unexpectedly public)`).toBe(member);
    }
  });

  test('the declaration exports the option and listener interfaces', () => {
    if (!hasBuild) return;
    expect(declaration).toContain('export interface IIniFileCacheOptions');
    expect(declaration).toContain('export interface IIniFileCacheListener');
    expect(declaration).toContain('export default class IniFileCache');
  });

  test('the declared signatures match what the methods actually return', async () => {
    // A declaration can be syntactically present and still lie. Spot-check the ones that
    // changed during development, where the .d.ts is most likely to be stale.
    const cache = create('declared.ini', '[S]\nk=v\n');
    cache.unwatch();
    expect(typeof cache.parseContents('[S]\nk=v\n')).toBe('boolean');
    expect(typeof (await cache.cacheFileSettings())).toBe('boolean');
    expect(typeof (await cache.reload())).toBe('boolean');
    expect(typeof (await cache.save())).toBe('boolean');
    expect(cache.getSetting('S', 'missing')).toBeNull();
    expect(typeof cache.listener.on).toBe('function');
    expect(typeof cache.listener.off).toBe('function');

    expect(declaration).toContain('parseContents(contents: string): boolean');
    expect(declaration).toContain('cacheFileSettings(): Promise<boolean>');
    expect(declaration).toContain('reload(): Promise<boolean>');
    expect(declaration).toContain('save(): Promise<boolean>');
    expect(declaration).toContain('get listener(): IIniFileCacheListener');
  });

  test('the exports map lists types before the runtime condition', () => {
    // Conditions are matched in order, so "types" after "import"/"require" is ignored and
    // consumers silently fall back to `any`.
    for (const condition of ['import', 'require'] as const) {
      const entry = pkg.exports['.'][condition];
      expect(typeof entry).toBe('object');
      expect(Object.keys(entry)[0]).toBe('types');
    }
  });

  test('CommonJS gets a declaration describing module.exports = the class', () => {
    // The bundle is built with `exports: "default"`, so `require()` returns the class.
    // `export default` would claim otherwise and break `require()` under node16.
    const cjsTypes = path.join(root, pkg.exports['.'].require.types);
    expect(fs.existsSync(cjsTypes)).toBe(true);
    expect(fs.readFileSync(cjsTypes, 'utf8')).toContain('export = IniFileCache');
  });

  test('every path the package points at is actually published', () => {
    const referenced = [
      pkg.main,
      pkg.module,
      pkg.types,
      pkg.exports['.'].import.types,
      pkg.exports['.'].import.default,
      pkg.exports['.'].require.types,
      pkg.exports['.'].require.default,
    ];
    for (const target of referenced) {
      expect(fs.existsSync(path.join(root, target))).toBe(true);
      // "files" ships only dist and the changelog, so everything above must live in dist.
      expect(target.replace('./', '').startsWith('dist/')).toBe(true);
    }
  });
});

describe('lookup performance', () => {
  // The parse was made linear early on, but every lookup stayed a linear scan, and the
  // only performance test covered parsing. Walking a file's own contents — the most
  // ordinary thing a consumer does — was quadratic: about 900ms for 4,000 sections.
  test('walking many sections is linear', () => {
    const count = 4000;
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(`[Domain${i}]`, `Host=h${i}`, `Port=${1000 + i}`);
    const cache = create('many-sections.ini', lines.join('\n'));

    const started = Date.now();
    let reads = 0;
    for (const section of cache.getSections()) {
      for (const key of cache.getKeys(section)) {
        cache.getSetting(section, key);
        reads++;
      }
    }
    const elapsed = Date.now() - started;

    expect(reads).toBe(count * 2);
    expect(elapsed).toBeLessThan(300);
  }, 30000);

  test('walking many keys in one section is linear', () => {
    const count = 8000;
    const lines = ['[S]'];
    for (let i = 0; i < count; i++) lines.push(`key${i}=v${i}`);
    const cache = create('many-keys.ini', lines.join('\n'));

    const started = Date.now();
    for (const key of cache.getKeys('S')) cache.getSetting('S', key);
    const elapsed = Date.now() - started;

    expect(cache.getKeys('S')).toHaveLength(count);
    expect(elapsed).toBeLessThan(300);
  }, 30000);

  test('lookups stay correct as sections and keys are removed and re-added', async () => {
    // The index that makes lookups fast is a second view of the same data, so every
    // mutation has to update both or reads start disagreeing with what a save writes.
    const cache = create('index-sync.ini', '[A]\nx=1\n[B]\ny=2\n');

    cache.removeSection('A');
    expect(cache.hasSection('A')).toBe(false);
    expect(cache.getSetting('A', 'x')).toBeNull();
    expect(cache.getSections()).toEqual(['B']);

    cache.setSetting('A', 'x', 'restored');
    expect(cache.hasSection('A')).toBe(true);
    expect(cache.getSetting('A', 'x')).toBe('restored');
    expect(cache.getSections()).toEqual(['B', 'A']);

    cache.removeKey('B', 'y');
    expect(cache.hasKey('B', 'y')).toBe(false);
    expect(cache.getKeys('B')).toEqual([]);
    cache.setSetting('B', 'y', 'again');
    expect(cache.getSetting('B', 'y')).toBe('again');
    expect(cache.getKeys('B')).toEqual(['y']);

    // What a save writes must match what the lookups report.
    expect(await cache.save()).toBe(true);
    expect(read('index-sync.ini')).toBe('[B]\ny=again\n\n[A]\nx=restored\n\n');
    await cache.reload();
    expect(cache.getSetting('A', 'x')).toBe('restored');
    expect(cache.getSetting('B', 'y')).toBe('again');
  });

  test('the array view and the index agree after any sequence of mutations', async () => {
    // The index is a second view of the same data. Rather than reasoning about each
    // mutation, drive random sequences and assert the two views never disagree: anything
    // getSections/getKeys reports must be reachable by lookup, with no duplicates.
    let seed = 0x51f3a7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const names = ['A', 'B', 'a', 'b', 'Server', 'SERVER', '', '  ', 'C'];
    const keys = ['x', 'X', 'y', 'port', 'PORT', 'z'];
    const values = ['1', '2', '', 'hello', '0'];

    for (let round = 0; round < 40; round++) {
      const name = `invariant${round}.ini`;
      const caseInsensitive = rnd() < 0.4;
      const cache = create(name, '[A]\nx=1\n[B]\ny=2\n', caseInsensitive ? { caseInsensitive: true } : {});
      cache.listener.on('error', () => undefined);
      cache.unwatch();

      for (let op = 0; op < 25; op++) {
        try {
          const choice = rnd();
          if (choice < 0.45) cache.setSetting(pick(names), pick(keys), pick(values));
          else if (choice < 0.7) cache.removeKey(pick(names), pick(keys));
          else if (choice < 0.85) cache.removeSection(pick(names));
          else cache.parseContents(`[${pick(names) || 'Z'}]\n${pick(keys)}=${pick(values)}\n`);
        } catch {
          // Validation rejections are expected for the invalid names in the pool.
        }

        const seenSections = new Set<string>();
        for (const section of cache.getSections()) {
          expect(cache.hasSection(section)).toBe(true);
          const normalized = caseInsensitive ? section.trim().toLowerCase() : section.trim();
          expect(seenSections.has(normalized)).toBe(false);
          seenSections.add(normalized);

          const seenKeys = new Set<string>();
          for (const key of cache.getKeys(section)) {
            expect(cache.hasKey(section, key)).toBe(true);
            expect(cache.getSetting(section, key)).not.toBeNull();
            const normalizedKey = caseInsensitive ? key.trim().toLowerCase() : key.trim();
            expect(seenKeys.has(normalizedKey)).toBe(false);
            seenKeys.add(normalizedKey);
          }
        }
      }

      // And what a save writes must reload into exactly what the lookups reported.
      const snapshot = () => {
        const out: Record<string, Record<string, string | null>> = {};
        for (const s of cache.getSections()) {
          out[s] = {};
          for (const k of cache.getKeys(s)) out[s][k] = cache.getSetting(s, k);
        }
        return JSON.stringify(out);
      };
      const before = snapshot();
      if (await cache.save()) {
        await cache.reload();
        expect(snapshot()).toBe(before);
      }
    }
  }, 60000);

  test('the index follows the caseInsensitive setting', () => {
    const cache = create('index-case.ini', '[Server]\nPort=1\n', { caseInsensitive: true });
    cache.removeSection('SERVER');
    expect(cache.getSections()).toEqual([]);
    cache.setSetting('server', 'port', '2');
    expect(cache.getSetting('SERVER', 'PORT')).toBe('2');
    cache.removeKey('Server', 'Port');
    expect(cache.getKeys('server')).toEqual([]);
  });
});

describe('real-world value shapes', () => {
  // Values that would break if anyone ever added quote stripping, escape handling or
  // inline comment parsing. Pinned because a config file full of Windows paths is the
  // normal case for this library.
  test.each([
    ['a Windows path', 'Path', 'C:\\Program Files\\MDaemon\\App'],
    ['a trailing backslash', 'Dir', 'C:\\MDaemon\\Logs\\'],
    ['a UNC path', 'Share', '\\\\server\\share\\config'],
    ['a quoted value', 'Quoted', '"C:\\Program Files\\x"'],
    ['a percent sign', 'Template', '%USERPROFILE%\\app'],
    ['an equals sign', 'Query', 'a=b&c=d'],
    ['a semicolon', 'List', 'one;two;three'],
    ['a hash', 'Colour', '#ff8800'],
    ['a colon and slashes', 'Url', 'https://mail.example.com:443/path'],
    ['an email address', 'Postmaster', 'postmaster@example.com'],
    ['a base64 value', 'Secret', 'YWJjZGVmZw=='],
    ['a lone bracket', 'Range', '[1..10'],
  ])('round-trips %s', async (_label, key, value) => {
    const cache = create('shapes.ini', '[S]\n');
    cache.setSetting('S', key, value);
    expect(await cache.save()).toBe(true);
    await cache.reload();
    expect(cache.getSetting('S', key)).toBe(value);
  });

  test('a realistic config file survives a read-modify-write cycle unchanged', async () => {
    const original = [
      '; MDaemon-style configuration',
      '[Server]',
      'Host=mail.example.com',
      'Port=25',
      'EnableTLS=Yes',
      'Timeout=30',
      '',
      '[Paths]',
      'Root=C:\\MDaemon\\',
      'Queue=C:\\MDaemon\\Queues\\Remote',
      '',
      '# logging',
      '[Logging]',
      'Level=3',
      'File=C:\\MDaemon\\Logs\\smtp.log',
      '',
    ].join('\r\n');
    const cache = create('realistic.ini', original);

    expect(cache.getSetting('Server', 'Host')).toBe('mail.example.com');
    expect(cache.getInt('Server', 'Port', 0)).toBe(25);
    expect(cache.getBool('Server', 'EnableTLS')).toBe(true);
    expect(cache.getSetting('Paths', 'Root')).toBe('C:\\MDaemon\\');

    cache.setSetting('Server', 'Port', '587');
    expect(await cache.save()).toBe(true);

    // Comments and blank lines are not preserved — settings are. Everything else about
    // the file, including its CRLF endings, is.
    const written = read('realistic.ini');
    expect(written).toContain('Port=587\r\n');
    expect(written).not.toMatch(/[^\r]\n/);

    await cache.reload();
    expect(cache.getInt('Server', 'Port', 0)).toBe(587);
    expect(cache.getSetting('Logging', 'File')).toBe('C:\\MDaemon\\Logs\\smtp.log');
    expect(cache.getSections()).toEqual(['Server', 'Paths', 'Logging']);
  });
});

describe('two instances on one file', () => {
  // The library's actual purpose: separate parts of an application each hold a cache of
  // the same file, and a write by one has to reach the others.
  test('a save by one instance reaches the other', async () => {
    const writer = create('shared.ini', '[S]\nk=original\n');
    const reader = create('shared.ini');

    writer.setSetting('S', 'k', 'updated');
    expect(await writer.save()).toBe(true);

    await waitFor(() => reader.getSetting('S', 'k') === 'updated');
    expect(reader.getSetting('S', 'k')).toBe('updated');
  }, 15000);

  test('the reader sees a series of writes, not just the first', async () => {
    // A watcher bound to the file rather than the directory stops firing once the file is
    // replaced, which an atomic save does every time.
    const writer = create('series.ini', '[S]\nn=0\n');
    const reader = create('series.ini');

    for (let n = 1; n <= 5; n++) {
      writer.setSetting('S', 'n', String(n));
      expect(await writer.save()).toBe(true);
      await waitFor(() => reader.getInt('S', 'n', -1) === n);
    }

    expect(reader.getInt('S', 'n', -1)).toBe(5);
  }, 30000);

  test('concurrent saves serialise and leave a well-formed file', async () => {
    const a = create('contended.ini', '[S]\nwho=none\n');
    const b = create('contended.ini');
    collectErrors(a);
    collectErrors(b);

    a.setSetting('S', 'who', 'a');
    b.setSetting('S', 'who', 'b');
    const results = await Promise.all([a.save(), b.save()]);

    expect(results).toEqual([true, true]);
    // One of them won, and neither interleaved with the other.
    expect(read('contended.ini')).toMatch(/^\[S\]\nwho=[ab]\n\n$/);
    expect(fs.existsSync(path.join(dir, 'contended.ini.lck'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'contended.ini.tmp'))).toBe(false);
  }, 20000);

  test('a reader never observes a half-written file', async () => {
    const before = '[S]\nsmall=1\n';
    const after = `[S]\nsmall=1\nbig=${'x'.repeat(200000)}\n\n`;
    const cache = create('atomicity.ini', before);
    cache.setSetting('S', 'big', 'x'.repeat(200000));

    // Read the file as fast as possible while a 200 KB save is in flight. Every read must
    // return either the old file or the new one, never a prefix of the new one.
    const saving = cache.save();
    let seenBefore = 0;
    let seenAfter = 0;
    let torn = 0;
    for (let i = 0; i < 400; i++) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, 'atomicity.ini'), 'utf8');
      } catch {
        continue; // the instant the rename swaps the file
      }
      if (text === before) seenBefore++;
      else if (text === after) seenAfter++;
      else torn++;
    }
    expect(await saving).toBe(true);

    expect(torn).toBe(0);
    expect(seenBefore + seenAfter).toBeGreaterThan(0);
    expect(read('atomicity.ini')).toBe(after);
  }, 20000);
});

describe('round-trip fuzz', () => {
  // A deterministic generator over the shapes real ini files take. Each file must load,
  // save, reload to the same logical model, save again to identical bytes, and be read
  // identically by a fresh instance.
  test('randomly generated files round-trip without drift', async () => {
    let seed = 0x2f6e2b1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const chance = (p: number) => rnd() < p;

    const names = ['S', 'Server', 'a b', 'Café', 'x;y', 'sec.tion', 'UPPER', 'lower', '1'];
    const keys = ['k', 'Port', 'my key', 'a;b', 'a[0]', 'naïve', 'K', 'x.y', 'Host'];
    const values = ['', 'v', 'a=b=c', 'p@ss=word==', '日本語', 'a;b#c', '0', 'true', '-12', 'x'.repeat(80)];
    const eols = ['\n', '\r\n', '\r'];

    const build = () => {
      const eol = pick(eols);
      let text = chance(0.15) ? '﻿' : '';
      if (chance(0.25)) {
        for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) text += `${pick(keys)}=${pick(values)}${eol}`;
      }
      for (let s = 0; s < 1 + Math.floor(rnd() * 4); s++) {
        if (chance(0.12)) text += `; comment${eol}`;
        if (chance(0.08)) text += eol;
        text += `[${pick(names)}]${chance(0.1) ? ' ; trailing' : ''}${eol}`;
        for (let k = 0; k < Math.floor(rnd() * 5); k++) {
          if (chance(0.1)) text += `# comment${eol}`;
          const key = pick(keys);
          text += chance(0.1) ? `${key}${eol}` : `${key}${chance(0.3) ? ' = ' : '='}${pick(values)}${eol}`;
        }
      }
      return text;
    };

    const snapshot = (cache: IniFileCache) => {
      const out: Record<string, Record<string, string | null>> = {};
      for (const section of cache.getSections()) {
        out[section] = {};
        for (const key of cache.getKeys(section)) out[section][key] = cache.getSetting(section, key);
      }
      return JSON.stringify(out);
    };

    for (let i = 0; i < 150; i++) {
      const name = `fuzz${i}.ini`;
      const text = build();
      fs.writeFileSync(path.join(dir, name), text);

      const options = chance(0.25) ? { caseInsensitive: true } : {};
      const cache = new IniFileCache(dir, name, options);
      instances.push(cache);
      cache.listener.on('error', () => undefined);
      cache.unwatch();

      const loaded = snapshot(cache);
      expect(await cache.save()).toBe(true);
      const firstBytes = fs.readFileSync(path.join(dir, name));

      await cache.reload();
      expect(snapshot(cache)).toBe(loaded);

      await cache.save();
      expect(fs.readFileSync(path.join(dir, name)).equals(firstBytes)).toBe(true);

      const fresh = new IniFileCache(dir, name, options);
      instances.push(fresh);
      const freshErrors = collectErrors(fresh);
      fresh.unwatch();
      expect(snapshot(fresh)).toBe(loaded);
      expect(freshErrors).toEqual([]);
    }
  }, 60000);
});

describe('getSetting', () => {
  test('returns the value when present', () => {
    const cache = create('get.ini', '[TestSection]\ntestKey=testValue\n');
    expect(cache.getSetting('TestSection', 'testKey')).toBe('testValue');
  });

  test('returns the default when the section or key is missing', () => {
    const cache = create('get-default.ini', '');
    expect(cache.getSetting('Nope', 'nope', 'defaultValue')).toBe('defaultValue');
    expect(cache.getSetting('Nope', 'nope')).toBeNull();
  });

  test('returns an explicitly supplied empty string default', () => {
    const cache = create('get-empty-default.ini', '');
    expect(cache.getSetting('Nope', 'nope', '')).toBe('');
  });
});

describe('getBool', () => {
  test('recognizes truthy values', () => {
    const cache = create('bool-true.ini', '[S]\na=t\nb=T\nc=1\nd=y\ne=Y\nf=true\ng=yes\nh=on\n');
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].forEach((key) => {
      expect(cache.getBool('S', key)).toBe(true);
    });
  });

  test('recognizes falsy values', () => {
    const cache = create('bool-false.ini', '[S]\na=f\nb=0\nc=n\nd=false\ne=no\nf=off\n');
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((key) => {
      expect(cache.getBool('S', key, true)).toBe(false);
    });
  });

  test('returns the default for missing, empty or unrecognized values', () => {
    const cache = create('bool-default.ini', '[S]\nempty=\ngarbage=maybe\nnumeric=123\n');
    expect(cache.getBool('Nope', 'nope', true)).toBe(true);
    expect(cache.getBool('Nope', 'nope')).toBe(false);
    expect(cache.getBool('S', 'empty', true)).toBe(true);
    expect(cache.getBool('S', 'garbage', true)).toBe(true);
    expect(cache.getBool('S', 'numeric', true)).toBe(true);
  });
});

describe('getInt', () => {
  test('parses integers', () => {
    const cache = create('int.ini', '[S]\na=42\nb=0\nc=-10\nd=+7\n');
    expect(cache.getInt('S', 'a')).toBe(42);
    expect(cache.getInt('S', 'b')).toBe(0);
    expect(cache.getInt('S', 'c')).toBe(-10);
    expect(cache.getInt('S', 'd')).toBe(7);
  });

  test('returns the default when the section or key is missing', () => {
    const cache = create('int-default.ini', '');
    expect(cache.getInt('Nope', 'nope', 100)).toBe(100);
    expect(cache.getInt('Nope', 'nope')).toBe(0);
  });

  test('handles the safe integer boundary', () => {
    const cache = create('int-boundary.ini', '[S]\na=9007199254740991\nb=9007199254740992\nc=-9007199254740991\n');
    expect(cache.getInt('S', 'a', -1)).toBe(9007199254740991);
    expect(cache.getInt('S', 'b', -1)).toBe(-1);
    expect(cache.getInt('S', 'c', -1)).toBe(-9007199254740991);
  });

  test('rejects trailing garbage, decimals and unsafe integers', () => {
    const cache = create('int-bad.ini', '[S]\na=123abc\nb=0x10\nc=12.34\nd=99999999999999999999\ne=\nf=abc\n');
    expect(cache.getInt('S', 'a', 25)).toBe(25);
    expect(cache.getInt('S', 'b', 25)).toBe(25);
    expect(cache.getInt('S', 'c', 25)).toBe(25);
    expect(cache.getInt('S', 'd', 25)).toBe(25);
    expect(cache.getInt('S', 'e', 25)).toBe(25);
    expect(cache.getInt('S', 'f', 25)).toBe(25);
  });
});

describe('setSetting', () => {
  test('adds a new section and key', () => {
    const cache = create('set.ini', '');
    cache.setSetting('NewSection', 'newKey', 'newValue');
    expect(cache.getSetting('NewSection', 'newKey')).toBe('newValue');
  });

  test('updates an existing key', () => {
    const cache = create('set-update.ini', '[S]\nk=old\n');
    cache.setSetting('S', 'k', 'new');
    expect(cache.getKeys('S')).toEqual(['k']);
    expect(cache.getSetting('S', 'k')).toBe('new');
  });

  test('rejects values that would forge extra lines', async () => {
    const cache = create('inject.ini', '[Security]\nAdmin=false\n');
    expect(() => cache.setSetting('Profile', 'Name', 'bob\nAdmin=true\n[Security]\nAdmin=true')).toThrow(TypeError);
    expect(() => cache.setSetting('Profile', 'Name', 'bob\rAdmin=true')).toThrow(TypeError);
    expect(() => cache.setSetting('Profile', 'Name', 'bob\0Admin=true')).toThrow(TypeError);

    await cache.save();
    expect(read('inject.ini')).toBe('[Security]\nAdmin=false\n\n');
  });

  test('rejects section names and keys containing ini delimiters', () => {
    const cache = create('inject-names.ini', '');
    expect(() => cache.setSetting('Profile]\n[Security', 'k', 'v')).toThrow(TypeError);
    expect(() => cache.setSetting('S', 'k=v\nother', 'v')).toThrow(TypeError);
    expect(() => cache.setSetting('S\n[Other]', 'k', 'v')).toThrow(TypeError);
    expect(cache.getSections()).toEqual([]);
  });

  test('rejects an empty key, but an empty section means the nameless section', () => {
    const cache = create('empty-names.ini', '');
    expect(() => cache.setSetting('S', '  ', 'v')).toThrow(TypeError);
    expect(() => cache.setSetting('S', '', 'v')).toThrow(TypeError);

    cache.setSetting('', 'k', 'v');
    expect(cache.getSetting('', 'k')).toBe('v');
  });

  test('rejects keys that would be read back as comments', async () => {
    const cache = create('comment-keys.ini', '');
    expect(() => cache.setSetting('S', ';leading', 'v')).toThrow(/read back as a comment/);
    expect(() => cache.setSetting('S', '#hash', 'v')).toThrow(/read back as a comment/);
    expect(() => cache.setSetting('S', '  ;padded', 'v')).toThrow(/read back as a comment/);

    // A comment character elsewhere in the key is fine and round-trips.
    cache.setSetting('S', 'a;b', 'v');
    await cache.save();
    await cache.reload();
    expect(cache.getKeys('S')).toEqual(['a;b']);
  });

  test('rejects keys that would be read back as a section header', async () => {
    const cache = create('header-keys.ini', '[S]\nreal=1\n');
    // "[a] ;x=v" satisfies the section header pattern, so this key would return as a
    // section named "a" and take its value with it.
    expect(() => cache.setSetting('S', '[a] ;x', 'v')).toThrow(/section header/);
    expect(() => cache.setSetting('S', '[a]', 'v')).toThrow(/section header/);
    expect(() => cache.setSetting('S', '[', 'v')).toThrow(/section header/);

    // A bracket elsewhere in the key is unambiguous and round-trips.
    cache.setSetting('S', 'a[0]', 'v');
    await cache.save();
    await cache.reload();
    expect(cache.getSections()).toEqual(['S']);
    expect(cache.getKeys('S')).toEqual(['real', 'a[0]']);
  });

  test('a section name may contain comment characters', async () => {
    const cache = create('comment-section.ini', '');
    cache.setSetting(';Section', 'k', 'v');
    await cache.save();
    await cache.reload();
    expect(cache.getSections()).toEqual([';Section']);
    expect(cache.getSetting(';Section', 'k')).toBe('v');
  });

  test('round-trips a written value through the file', async () => {
    const cache = create('roundtrip.ini', '');
    cache.setSetting('Auth', 'Password', 'p@ss=word==');
    expect(await cache.save()).toBe(true);
    await cache.reload();
    expect(cache.getSetting('Auth', 'Password')).toBe('p@ss=word==');
  });
});

describe('sections and keys', () => {
  test('getSections returns every section name', () => {
    const cache = create('sections.ini', '[Section1]\na=1\n[Section2]\nb=2\n');
    expect(cache.getSections()).toEqual(['Section1', 'Section2']);
  });

  test('getKeys returns the keys of a section and [] for an unknown section', () => {
    const cache = create('keys.ini', '[S]\nkey1=1\nkey2=2\n');
    expect(cache.getKeys('S')).toEqual(['key1', 'key2']);
    expect(cache.getKeys('Nope')).toEqual([]);
  });

  test('hasSection and hasKey', () => {
    const cache = create('has.ini', '[S]\nkey=value\n');
    expect(cache.hasSection('S')).toBe(true);
    expect(cache.hasSection('Nope')).toBe(false);
    expect(cache.hasKey('S', 'key')).toBe(true);
    expect(cache.hasKey('S', 'nope')).toBe(false);
    expect(cache.hasKey('Nope', 'key')).toBe(false);
  });

  test('removeSection and removeKey', () => {
    const cache = create('remove.ini', '[S1]\na=1\nb=2\n[S2]\nc=3\n');
    cache.removeKey('S1', 'a');
    expect(cache.getKeys('S1')).toEqual(['b']);
    cache.removeKey('S1', 'missing');
    cache.removeKey('Missing', 'b');
    expect(cache.getKeys('S1')).toEqual(['b']);
    cache.removeSection('S1');
    expect(cache.getSections()).toEqual(['S2']);
  });
});

describe('caseInsensitive option', () => {
  test('matches sections and keys regardless of case when enabled', () => {
    const cache = create('ci.ini', '[Server]\nPort=8080\n', { caseInsensitive: true });
    expect(cache.getSetting('server', 'port')).toBe('8080');
    expect(cache.hasSection('SERVER')).toBe(true);
    expect(cache.hasKey('server', 'PORT')).toBe(true);
    cache.setSetting('SERVER', 'port', '25');
    expect(cache.getKeys('Server')).toEqual(['Port']);
    expect(cache.getSetting('Server', 'Port')).toBe('25');
  });

  test('is case-sensitive by default', () => {
    const cache = create('cs.ini', '[Server]\nPort=8080\n');
    expect(cache.getSetting('server', 'port')).toBeNull();
  });

  test('removeKey and removeSection match case-insensitively', () => {
    const cache = create('ci-remove.ini', '[Server]\nPort=1\nHost=x\n', { caseInsensitive: true });
    cache.removeKey('SERVER', 'port');
    expect(cache.getKeys('Server')).toEqual(['Host']);
    cache.removeSection('server');
    expect(cache.getSections()).toEqual([]);
  });

  test('merges keys differing only by case when enabled', async () => {
    const cache = create('ci-merge.ini', '[S]\nPort=1\nPORT=2\nport=3\n', { caseInsensitive: true });
    expect(cache.getKeys('S')).toEqual(['Port']);
    expect(cache.getSetting('S', 'port')).toBe('3');
    await cache.save();
    expect(read('ci-merge.ini')).toBe('[S]\nPort=3\n\n');
  });

  test('keeps keys differing only by case when disabled', () => {
    const cache = create('cs-keep.ini', '[S]\nPort=1\nPORT=2\n');
    expect(cache.getKeys('S')).toEqual(['Port', 'PORT']);
    expect(cache.getSetting('S', 'PORT')).toBe('2');
  });
});

describe('save', () => {
  test('writes the settings and resolves true', async () => {
    const cache = create('save.ini', '');
    cache.setSetting('Section1', 'key1', 'value1');
    const saved = await cache.save();
    expect(saved).toBe(true);
    expect(read('save.ini')).toBe('[Section1]\nkey1=value1\n\n');
  });

  test('emits a save event with the file path', async () => {
    const cache = create('save-event.ini', '');
    const paths: string[] = [];
    cache.listener.on('save', (file: string) => paths.push(file));
    await cache.save();
    expect(paths).toEqual([path.join(dir, 'save-event.ini')]);
  });

  test('leaves no temporary file behind', async () => {
    const cache = create('save-temp.ini', '');
    cache.setSetting('S', 'k', 'v');
    await cache.save();
    expect(fs.existsSync(path.join(dir, 'save-temp.ini.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'save-temp.ini.lck'))).toBe(false);
  });

  test('refuses to write while another process holds the lock', async () => {
    const cache = create('locked.ini', '[S]\nk=original\n');
    const errors = collectErrors(cache);
    fs.writeFileSync(path.join(dir, 'locked.ini.lck'), '');

    cache.setSetting('S', 'k', 'changed');
    expect(await cache.save()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Failed to acquire the lock');
    expect(errors[0].message).toMatch(/timed out/);
    expect(read('locked.ini')).toBe('[S]\nk=original\n');

    fs.unlinkSync(path.join(dir, 'locked.ini.lck'));
  }, 15000);

  test('does not remove a lock held by someone else', async () => {
    const cache = create('foreign-lock.ini', '');
    const lock = path.join(dir, 'foreign-lock.ini.lck');
    fs.writeFileSync(lock, 'another-writers-token');

    cache.setSetting('S', 'k', 'v');
    expect(await cache.save()).toBe(false);

    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, 'utf8')).toBe('another-writers-token');

    fs.unlinkSync(lock);
  }, 15000);

  test('succeeds while another process holds the file open for reading', async () => {
    const cache = create('held-open.ini', '[S]\nk=1\n');
    const handle = fs.openSync(path.join(dir, 'held-open.ini'), 'r');

    cache.setSetting('S', 'k', '2');
    const saved = await cache.save();
    fs.closeSync(handle);

    expect(saved).toBe(true);
    expect(read('held-open.ini')).toBe('[S]\nk=2\n\n');
    expect(fs.existsSync(path.join(dir, 'held-open.ini.tmp'))).toBe(false);
  }, 15000);

  test('a setting written after a save is not reverted by our own watcher', async () => {
    const cache = create('self-write.ini', '[S]\nk=original\n');
    await cache.save();

    cache.setSetting('S', 'k', 'edited-after-save');
    await wait(500);

    expect(cache.getSetting('S', 'k')).toBe('edited-after-save');
    expect(await cache.save()).toBe(true);
    expect(read('self-write.ini')).toBe('[S]\nk=edited-after-save\n\n');
  }, 15000);

  test('a save does not emit a change event', async () => {
    const cache = create('save-change.ini', '[S]\nk=1\n');
    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));

    cache.setSetting('S', 'k', '2');
    await cache.save();
    await wait(500);

    expect(changes).toEqual([]);
  }, 15000);

  test('writes the settings the cache holds when the lock is finally acquired', async () => {
    const cache = create('late-serialize.ini', '[S]\nk=original\n');
    collectErrors(cache);
    const lock = path.join(dir, 'late-serialize.ini.lck');
    fs.writeFileSync(lock, 'another-writer');

    const saving = cache.save();
    // While the save waits for the lock, the file changes and the watcher adopts it.
    setTimeout(() => fs.writeFileSync(path.join(dir, 'late-serialize.ini'), '[S]\nk=external\n'), 100);
    setTimeout(() => fs.unlinkSync(lock), 700);

    expect(await saving).toBe(true);
    await wait(300);

    // Rendering before the wait would have written the stale "original" here, and the
    // resulting change event would have been suppressed as our own write, leaving the
    // cache and the file permanently disagreeing.
    expect(cache.getSetting('S', 'k')).toBe('external');
    expect(read('late-serialize.ini')).toBe('[S]\nk=external\n\n');
  }, 20000);

  test('a throwing save listener does not turn a successful write into a failure', async () => {
    const cache = create('throwing-save.ini', '');
    const errors = collectErrors(cache);
    cache.listener.on('save', () => {
      throw new Error('save listener blew up');
    });

    cache.setSetting('S', 'k', 'v');
    expect(await cache.save()).toBe(true);
    expect(read('throwing-save.ini')).toBe('[S]\nk=v\n\n');
    expect(errors.map((e) => e.message)).toEqual(['save listener blew up']);
  });

  test('breaks a stale lock', async () => {
    const cache = create('stale.ini', '');
    const lock = path.join(dir, 'stale.ini.lck');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);

    cache.setSetting('S', 'k', 'v');
    expect(await cache.save()).toBe(true);
    expect(read('stale.ini')).toBe('[S]\nk=v\n\n');
  }, 15000);

  test('reports failure when the containing directory is gone', async () => {
    const sub = path.join(dir, 'vanishing');
    const cache = new IniFileCache(sub, 'gone.ini');
    instances.push(cache);
    const errors = collectErrors(cache);
    cache.unwatch();

    cache.setSetting('S', 'k', 'v');
    fs.rmSync(sub, { recursive: true, force: true });

    expect(await cache.save()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Failed to acquire the lock');
    // The underlying cause is included rather than swallowed.
    expect(errors[0].message).toMatch(/ENOENT/);
  }, 15000);

  test('writes through a symbolic link instead of replacing it', async () => {
    const target = path.join(dir, 'target.ini');
    const link = path.join(dir, 'link.ini');
    fs.writeFileSync(target, '[S]\nk=1\n');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (error: any) {
      // Windows needs developer mode or elevation to create symlinks.
      if (error.code === 'EPERM' || error.code === 'ENOSYS') {
        return;
      }
      throw error;
    }

    const cache = new IniFileCache(dir, 'link.ini');
    instances.push(cache);
    cache.setSetting('S', 'k', '2');
    expect(await cache.save()).toBe(true);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('[S]\nk=2\n\n');
  }, 15000);

  test('refuses to save a file that has never parsed, instead of truncating it', async () => {
    // A file with settings but no header is treated as malformed, so the cache is empty
    // because nothing was understood — not because the file has no settings.
    fs.writeFileSync(path.join(dir, 'never-parsed.ini'), 'k=v\nj=w\n');
    const cache = new IniFileCache(dir, 'never-parsed.ini');
    instances.push(cache);
    const errors = collectErrors(cache);
    await wait(30);

    expect(errors.map((e) => e.message)).toEqual(['Invalid ini file format']);
    expect(await cache.save()).toBe(false);
    expect(errors.map((e) => e.message)).toContainEqual(expect.stringContaining('never been parsed successfully'));
    // The file is intact rather than blanked.
    expect(read('never-parsed.ini')).toBe('k=v\nj=w\n');
  });

  test('saving is allowed again once the file parses', async () => {
    fs.writeFileSync(path.join(dir, 'recovers.ini'), 'k=v\n');
    const cache = new IniFileCache(dir, 'recovers.ini');
    instances.push(cache);
    collectErrors(cache);
    cache.unwatch();
    expect(await cache.save()).toBe(false);

    fs.writeFileSync(path.join(dir, 'recovers.ini'), '[S]\nk=v\n');
    await cache.reload();
    cache.setSetting('S', 'k', 'w');
    expect(await cache.save()).toBe(true);
    expect(read('recovers.ini')).toBe('[S]\nk=w\n\n');
  });

  test('an empty file is still saveable', async () => {
    const cache = create('blank.ini', '');
    cache.setSetting('S', 'k', 'v');
    expect(await cache.save()).toBe(true);
    expect(read('blank.ini')).toBe('[S]\nk=v\n\n');
  });

  test('saves an empty cache as an empty file', async () => {
    const cache = create('emptied.ini', '[S]\nk=v\n');
    cache.removeSection('S');
    expect(await cache.save()).toBe(true);
    expect(read('emptied.ini')).toBe('');
    await cache.reload();
    expect(cache.getSections()).toEqual([]);
  });

  test('many saves in a row leave no lock or temporary files behind', async () => {
    // A busy service writing settings repeatedly: the lock is taken and released 50 times,
    // and any leaked lock would stall every later writer for ten seconds.
    const cache = create('busy.ini', '[S]\nn=0\n');
    const errors = collectErrors(cache);

    for (let n = 1; n <= 50; n++) {
      cache.setSetting('S', 'n', String(n));
      expect(await cache.save()).toBe(true);
    }
    await settle();

    expect(errors).toEqual([]);
    expect(read('busy.ini')).toBe('[S]\nn=50\n\n');
    expect(cache.getSetting('S', 'n')).toBe('50');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.lck') || f.endsWith('.tmp'))).toEqual([]);
  }, 30000);

  test('survives the containing directory being deleted', async () => {
    // Uninstallers and cleanup jobs do this. It must report the failure and keep what it
    // has rather than throwing out of a timer or writing to a directory that is gone.
    const sub = path.join(dir, 'removable');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'gone.ini'), '[S]\nk=1\n');
    const cache = new IniFileCache(sub, 'gone.ini');
    instances.push(cache);
    const errors = collectErrors(cache);

    fs.rmSync(sub, { recursive: true, force: true });
    await waitFor(() => errors.length > 0, 10000);

    expect(cache.getSetting('S', 'k')).toBe('1');
    expect(await cache.save()).toBe(false);
  }, 20000);

  test('the lock is per file, not per directory', async () => {
    const other = create('other.ini', '');
    fs.writeFileSync(path.join(dir, 'unrelated.ini.lck'), '');
    other.setSetting('S', 'k', 'v');
    expect(await other.save()).toBe(true);
  });
});

describe('reload and cacheFileSettings', () => {
  test('reload resolves true on success', async () => {
    const cache = create('reload-true.ini', '[S]\nk=1\n');
    cache.unwatch();
    expect(await cache.reload()).toBe(true);
  });

  test('reload re-reads the file and emits reload', async () => {
    const cache = create('reload.ini', '[S]\nk=1\n');
    cache.unwatch();
    const reloads: string[] = [];
    cache.listener.on('reload', (file: string) => reloads.push(file));

    fs.writeFileSync(path.join(dir, 'reload.ini'), '[S]\nk=2\n');
    await cache.reload();

    expect(cache.getSetting('S', 'k')).toBe('2');
    expect(reloads).toEqual([path.join(dir, 'reload.ini')]);
  });

  test('reload resolves and reports an error when the file cannot be read', async () => {
    const cache = create('missing.ini', '[S]\nk=1\n');
    cache.unwatch();
    const errors = collectErrors(cache);
    fs.unlinkSync(path.join(dir, 'missing.ini'));

    await expect(cache.reload()).resolves.toBe(false);
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('Failed to read file after 20 attempts')]);
  }, 15000);

  test('reload resolves false and emits no reload event when the content is rejected', async () => {
    const cache = create('reload-bad.ini', '[S]\nk=1\n');
    cache.unwatch();
    const errors = collectErrors(cache);
    const reloads: string[] = [];
    cache.listener.on('reload', (file: string) => reloads.push(file));

    fs.writeFileSync(path.join(dir, 'reload-bad.ini'), 'k=2\n');
    expect(await cache.reload()).toBe(false);

    expect(errors.map((e) => e.message)).toEqual(['Invalid ini file format']);
    expect(reloads).toEqual([]);
    expect(cache.getSetting('S', 'k')).toBe('1');
  });

  test('allows a file whose size is exactly maxFileSize', () => {
    const contents = '[S]\nk=v\n';
    const cache = create('at-limit.ini', contents, { maxFileSize: Buffer.byteLength(contents) });
    const errors = collectErrors(cache);
    expect(cache.getSetting('S', 'k')).toBe('v');
    expect(errors).toEqual([]);
  });

  test('refuses to read a file one byte over maxFileSize', async () => {
    const contents = '[S]\nk=v\n';
    fs.writeFileSync(path.join(dir, 'over-limit.ini'), contents);
    const cache = new IniFileCache(dir, 'over-limit.ini', { maxFileSize: Buffer.byteLength(contents) - 1 });
    instances.push(cache);
    const errors = collectErrors(cache);
    await wait(50);
    expect(cache.getSetting('S', 'k')).toBeNull();
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('exceeds the maximum')]);
  });

  test('reports failure when the file cannot be read', async () => {
    const cache = create('read-result.ini', '[S]\nk=1\n');
    cache.unwatch();
    collectErrors(cache);
    await expect(cache.cacheFileSettings()).resolves.toBe(true);

    fs.unlinkSync(path.join(dir, 'read-result.ini'));
    await expect(cache.cacheFileSettings()).resolves.toBe(false);
  }, 15000);

  test('refuses to read a file larger than maxFileSize', async () => {
    const cache = create('big.ini', '[S]\nk=1\n', { maxFileSize: 16 });
    cache.unwatch();
    const errors = collectErrors(cache);

    fs.writeFileSync(path.join(dir, 'big.ini'), `[S]\nk=${'x'.repeat(1000)}\n`);
    await cache.reload();

    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('exceeds the maximum')]);
    expect(cache.getSetting('S', 'k')).toBe('1');
  });
});

describe('watch and unwatch', () => {
  test('emits a single change event for an external write', async () => {
    const cache = create('watch.ini', '[S]\nk=1\n');
    const changes: string[] = [];
    cache.listener.on('change', (name: string) => changes.push(name));

    fs.writeFileSync(path.join(dir, 'watch.ini'), '[S]\nk=2\n');
    await waitFor(() => changes.length > 0);
    await settle();

    // Exactly one: most platforms emit several raw events per write, and the debounce is
    // what collapses them.
    expect(changes.length).toBe(1);
    expect(cache.getSetting('S', 'k')).toBe('2');
  }, 15000);

  test('ignores writes to unrelated files in the same directory', async () => {
    const cache = create('watched.ini', '[S]\nk=1\n');
    const changes: string[] = [];
    cache.listener.on('change', (name: string) => changes.push(name));

    fs.writeFileSync(path.join(dir, 'unrelated.ini'), 'noise\n');
    await wait(400);

    expect(changes).toEqual([]);
  }, 15000);

  test('unwatch stops change events', async () => {
    const cache = create('unwatch.ini', '[S]\nk=1\n');
    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));

    cache.unwatch();
    fs.writeFileSync(path.join(dir, 'unwatch.ini'), '[S]\nk=2\n');
    await wait(400);

    expect(changes).toEqual([]);
    expect(cache.getSetting('S', 'k')).toBe('1');
  }, 15000);

  test('unwatch emits close and is safe to call twice', async () => {
    const cache = create('close.ini', '');
    let closed = 0;
    cache.listener.on('close', () => (closed += 1));

    cache.unwatch();
    cache.unwatch();
    await wait(100);

    expect(closed).toBe(1);
  });

  test('watch is idempotent', async () => {
    const cache = create('idempotent.ini', '[S]\nk=1\n');
    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));

    cache.watch();
    cache.watch();

    fs.writeFileSync(path.join(dir, 'idempotent.ini'), '[S]\nk=2\n');
    await waitFor(() => changes.length > 0);
    await settle();

    expect(changes.length).toBe(1);

    // A single unwatch is still enough to stop everything.
    cache.unwatch();
    fs.writeFileSync(path.join(dir, 'idempotent.ini'), '[S]\nk=3\n');
    await wait(400);
    expect(changes.length).toBe(1);
  }, 15000);

  test('a throwing change listener is reported instead of crashing the process', async () => {
    const cache = create('throwing-change.ini', '[S]\nk=1\n');
    const errors = collectErrors(cache);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    cache.listener.on('change', () => {
      throw new Error('change listener blew up');
    });

    fs.writeFileSync(path.join(dir, 'throwing-change.ini'), '[S]\nk=2\n');
    await waitFor(() => errors.length > 0);
    await settle();
    process.off('unhandledRejection', onRejection);

    expect(rejections).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual(['change listener blew up']);
    // The reload itself still happened.
    expect(cache.getSetting('S', 'k')).toBe('2');
  }, 15000);

  test('watch resumes after unwatch', async () => {
    const cache = create('rewatch.ini', '[S]\nk=1\n');
    cache.unwatch();
    cache.watch();

    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));
    fs.writeFileSync(path.join(dir, 'rewatch.ini'), '[S]\nk=2\n');
    await waitFor(() => changes.length > 0);
    await settle();

    expect(changes.length).toBe(1);
    expect(cache.getSetting('S', 'k')).toBe('2');
  }, 15000);

  test('an external change replaces unsaved in-memory edits', async () => {
    // The cache follows the file: a setSetting that has not been saved is not protected
    // from an external write. Callers doing read-modify-write must save promptly.
    const cache = create('external-wins.ini', '[S]\nk=original\n');

    cache.setSetting('S', 'k', 'local-edit');
    fs.writeFileSync(path.join(dir, 'external-wins.ini'), '[S]\nk=fromdisk\n');
    await waitFor(() => cache.getSetting('S', 'k') === 'fromdisk');

    expect(cache.getSetting('S', 'k')).toBe('fromdisk');
  }, 15000);

  test('a reload that has to retry still stops once the file becomes ours', async () => {
    const cache = create('retry-own.ini', '[S]\nk=original\n');
    collectErrors(cache);

    // Make the read fail so the watcher's reload enters its retry loop.
    fs.unlinkSync(path.join(dir, 'retry-own.ini'));
    await wait(150);

    // Saving during the retry window republishes the file; the pending reload must
    // recognise it as ours and stop rather than reading it back.
    cache.setSetting('S', 'k', 'saved-during-retry');
    expect(await cache.save()).toBe(true);
    await wait(2600);

    expect(cache.getSetting('S', 'k')).toBe('saved-during-retry');
    expect(read('retry-own.ini')).toBe('[S]\nk=saved-during-retry\n\n');
  }, 20000);

  test('a normal reload still replaces settings', async () => {
    const cache = create('normal-reload.ini', '[S]\nk=original\n');
    fs.writeFileSync(path.join(dir, 'normal-reload.ini'), '[S]\nk=fromdisk\n');
    await waitFor(() => cache.getSetting('S', 'k') === 'fromdisk');
  }, 15000);

  test('a malformed external write reports an error and emits no change', async () => {
    const cache = create('goes-bad.ini', '[S]\nk=1\n');
    const errors = collectErrors(cache);
    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));

    // No section header at all: rejected, so the cache still holds the old settings and
    // there is no change to announce.
    fs.writeFileSync(path.join(dir, 'goes-bad.ini'), 'k=2\n');
    await waitFor(() => errors.length > 0);
    await settle();

    expect(errors.map((e) => e.message)).toEqual(['Invalid ini file format']);
    expect(changes).toEqual([]);
    expect(cache.getSetting('S', 'k')).toBe('1');
  }, 15000);

  test('a deleted file reports an error, keeps the cache and emits no change', async () => {
    const cache = create('deleted.ini', '[S]\nk=1\n');
    const errors = collectErrors(cache);
    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));

    fs.unlinkSync(path.join(dir, 'deleted.ini'));
    await waitFor(() => errors.length > 0, 8000);
    await settle();

    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining('Failed to read file after 20 attempts')]);
    // A change event would claim the cache reflects the file, which it does not.
    expect(changes).toEqual([]);
    expect(cache.getSetting('S', 'k')).toBe('1');
  }, 20000);

  test('survives an atomic replacement of the watched file', async () => {
    const cache = create('atomic.ini', '[S]\nk=1\n');
    const changes: string[] = [];
    cache.listener.on('change', () => changes.push('change'));

    const temp = path.join(dir, 'atomic.staging');
    fs.writeFileSync(temp, '[S]\nk=2\n');
    fs.renameSync(temp, path.join(dir, 'atomic.ini'));
    await waitFor(() => changes.length > 0);

    expect(cache.getSetting('S', 'k')).toBe('2');
  }, 15000);
});
