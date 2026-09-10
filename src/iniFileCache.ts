import * as fs from "fs";
import * as path from "path";
import Emitter from "@mdaemon/emitter";

interface ISetting {
  key: string;
  value: string;
}

interface ISection {
  name: string;
  /** Ordered, so a save reproduces the file's own order. */
  settings: ISetting[];
  /** Normalized key to the same ISetting objects held in `settings`, for O(1) lookup. */
  keys: Map<string, ISetting>;
}

interface ILockResult {
  token: string | null;
  error?: unknown;
}

/** Every event this library emits. Named so that a typo cannot compile into silence. */
type IniEvent = "change" | "reload" | "save" | "error" | "close";

interface IFileSignature {
  size: number;
  mtimeMs: number;
}

/**
 * What a read of the file established. Returned rather than stashed on the instance so
 * that the parse which consumes it takes it as an argument: a field would make every
 * caller's correctness depend on the two calls staying adjacent.
 */
interface IReadResult {
  contents: string;
  /** The exact bytes found, so a save reproduces them under any encoding. */
  byteOrderMark: Buffer | null;
  /** The decode did not round-trip, so writing it back would change untouched bytes. */
  lossy: boolean;
}

/**
 * The subscription surface of the `listener` property. Declared here rather than taken
 * from the emitter package so the published types describe exactly what this library
 * supports, and do not depend on how that package ships its own declarations.
 */
export interface IIniFileCacheListener {
  /** `change` carries the file's base name, not its path: see the `reload` overload. */
  on(event: "change", handler: (fileName: string) => void): void;
  on(event: "change", namespace: string, handler: (fileName: string) => void): void;
  on(event: "reload" | "save", handler: (filePath: string) => void): void;
  on(event: "reload" | "save", namespace: string, handler: (filePath: string) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "error", namespace: string, handler: (error: Error) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "close", namespace: string, handler: () => void): void;
  on(event: string, handler: (...args: any[]) => void): void;
  on(event: string, namespace: string, handler: (...args: any[]) => void): void;
  once(event: string, handler: (...args: any[]) => void): void;
  once(event: string, namespace: string, handler: (...args: any[]) => void): void;
  /**
   * Removes handlers for `event`. A handler registered without a namespace is filed under
   * a shared default one, and this removes every handler in the namespace it is given — so
   * `off("change")` unsubscribes every other part of the application that also subscribed
   * without a namespace. Pass the namespace used at registration to remove only your own.
   */
  off(event: string, namespace?: string): void;
  emit(event: string, payload?: unknown): void;
}

export interface IIniFileCacheOptions {
  /** Maximum size, in bytes, of an ini file that will be read. Defaults to 10485760 (10 MB). */
  maxFileSize?: number;
  /** Compare section names and keys case-insensitively. Defaults to false. */
  caseInsensitive?: boolean;
  /** Milliseconds used to coalesce rapid file change events. Defaults to 50. */
  debounceDelay?: number;
  /**
   * Require the resolved file to stay inside cachePath, rejecting a fileName such as
   * "../../elsewhere.ini". Defaults to false, because both arguments normally come from
   * the application itself and reaching a sibling directory with ".." is legitimate.
   * Enable it only when fileName comes from somewhere you do not trust.
   */
  restrictToCachePath?: boolean;
  /**
   * Character encoding of the file. Defaults to "utf8". Use "latin1" for a legacy
   * single-byte file: decoding one as UTF-8 replaces every high byte with U+FFFD, which
   * would be written back as the replacement character and corrupt the file.
   */
  encoding?: BufferEncoding;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_DEBOUNCE_DELAY = 50;

const READ_MAX_ATTEMPTS = 20;
const READ_RETRY_DELAY = 100;

const LOCK_MAX_ATTEMPTS = 20;
const LOCK_RETRY_DELAY = 100;
const LOCK_STALE_MS = 10000;

// Unmatched watch events tolerated before checking that the directory is still there.
// A deleted watch directory produces an unbounded stream of them on Windows.
const UNMATCHED_EVENTS_BEFORE_CHECK = 500;

// Multiple of debounceDelay after which a reload happens even though events are still
// arriving. Without a cap, a file written faster than the delay restarts the timer forever
// and is never adopted at all.
const DEBOUNCE_MAX_WAIT_FACTOR = 10;

// fs write options. `flush` was added in Node 20.10 and is silently ignored before that,
// so on the older runtimes this package still supports the write simply is not flushed.
const WRITE_OPTIONS: fs.WriteFileOptions = { flush: true } as fs.WriteFileOptions;

const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_DELAY = 50;
// Windows cannot rename over a file another process holds open; writing in place still works.
const RENAME_FALLBACK_CODES = ["EPERM", "EBUSY", "EACCES"];

// Filesystems that are case-insensitive by default, where a watch event may report the
// file name in a different case than the one the caller supplied.
const CASE_INSENSITIVE_PLATFORMS = ["win32", "darwin"];

// A section name is terminated by "]", so it may not contain one. Line breaks and null
// characters would let a crafted value forge additional lines on save.
const INVALID_SECTION = /[\r\n\0\]]/;
// A key is terminated by "=", so it may not contain one.
const INVALID_KEY = /[\r\n\0=]/;
// A key starting with a comment marker would be read back as a comment and disappear.
const COMMENT_START = /^[;#]/;
const INVALID_VALUE = /[\r\n\0]/;

// U+FEFF, written as the three-byte UTF-8 sequence EF BB BF. Derived from the code point
// rather than written as the literal character, which is invisible in an editor and is
// easily mangled by a re-save under another encoding.
const BYTE_ORDER_MARK_CODE = 0xfeff;
const BYTE_ORDER_MARK = String.fromCharCode(BYTE_ORDER_MARK_CODE);
const BYTE_ORDER_MARK_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

// Matches the line endings of any platform, and of a file that mixes them.
const LINE_BREAK = /\r\n|\n|\r/;
const SECTION_HEADER = /^\[([^\]]*)\]\s*(?:[;#].*)?$/;
const TRUE_VALUES = /^(?:t|true|y|yes|on|1)$/i;
const FALSE_VALUES = /^(?:f|false|n|no|off|0)$/i;
const INTEGER_VALUE = /^[+-]?\d+$/;

let lockCounter = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(file: string): string {
  return `${file}.lck`;
}

function tempPath(file: string): string {
  return `${file}.tmp`;
}

/**
 * Creates the lock file for `file` with an exclusive open, so two processes can never
 * believe they hold it at the same time. Locks older than LOCK_STALE_MS are treated as
 * abandoned and removed. Resolves with the token written into the lock, or a null token
 * and the underlying cause; callers must not write the file without a token.
 */
async function acquireLock(file: string): Promise<ILockResult> {
  const lock = lockPath(file);
  const token = `${process.pid}-${process.hrtime.bigint()}-${++lockCounter}`;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = fs.openSync(lock, "wx");
      // From here on the lock file is ours: an exclusive open is what makes it so.
      created = true;
      fs.writeFileSync(descriptor, token);
      fs.closeSync(descriptor);
      descriptor = null;
      return { token };
    } catch (error: any) {
      if (descriptor !== null) {
        // Close before touching the lock again: an open descriptor prevents the unlink
        // below from succeeding on Windows.
        try {
          fs.closeSync(descriptor);
        } catch {
          // Nothing useful to do if the descriptor is already gone.
        }
        descriptor = null;
      }
      if (error?.code !== "EEXIST") {
        if (created) {
          // Ours: created, but not stamped with our token, so it would block every writer
          // until it aged out. Take it back out. A failure to open says nothing about who
          // owns an existing lock — a descriptor limit or a permission error while another
          // writer legitimately holds it must not remove theirs.
          try {
            fs.unlinkSync(lock);
          } catch {
            // Nothing further to try.
          }
        }
        return { token: null, error };
      }
      try {
        const stats = fs.statSync(lock);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        // The lock disappeared between the open and the stat, so retry immediately.
        continue;
      }
      await delay(LOCK_RETRY_DELAY);
    }
  }
  return { token: null };
}

/**
 * Removes the lock only while it still holds our token. If another writer decided our
 * lock was stale and took its own, that lock belongs to them and must be left alone.
 */
function releaseLock(file: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath(file), "utf8") === token) {
      fs.unlinkSync(lockPath(file));
    }
  } catch {
    // Already gone, or unreadable; either way there is nothing of ours to remove.
  }
}

/**
 * Adds a section to both views at once: `sections` is the file's own order, `index` is the
 * normalized-name lookup, and they hold the same objects. Every mutation goes through here
 * so that neither can be updated without the other.
 */
function addSection(
  name: string,
  normalized: string,
  sections: ISection[],
  index: Map<string, ISection>,
  atFront = false
): ISection {
  const section: ISection = { name, settings: [], keys: new Map() };
  if (atFront) {
    sections.unshift(section);
  } else {
    sections.push(section);
  }
  index.set(normalized, section);
  return section;
}

/** Adds a setting to both views of its section, for the same reason as addSection. */
function addSetting(section: ISection, key: string, normalizedKey: string, value: string): ISetting {
  const setting: ISetting = { key, value };
  section.settings.push(setting);
  section.keys.set(normalizedKey, setting);
  return setting;
}

function sanitizeName(input: string, label: string, invalid: RegExp): string {
  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TypeError(`${label} must not be empty`);
  }
  if (invalid.test(trimmed)) {
    throw new TypeError(`${label} "${input}" contains characters that are not valid in an ini file`);
  }
  return trimmed;
}

function sanitizeKey(key: string): string {
  const trimmed = sanitizeName(key, "key", INVALID_KEY);
  if (COMMENT_START.test(trimmed)) {
    throw new TypeError(`key "${key}" must not start with ";" or "#", which would be read back as a comment`);
  }
  if (trimmed.startsWith("[")) {
    // "[a] ;x=v" satisfies the section header pattern, so such a key would come back as
    // a section and take its setting with it.
    throw new TypeError(`key "${key}" must not start with "[", which could be read back as a section header`);
  }
  return trimmed;
}

function sanitizeValue(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }
  if (INVALID_VALUE.test(value)) {
    throw new TypeError("value must not contain line breaks or null characters");
  }
  return value.trim();
}

/**
 * The `error` event is declared as carrying an Error, so anything thrown that is not one
 * is wrapped rather than passed through and quietly breaking that contract.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Resolves fileName against cachePath. A fileName may reach outside cachePath with "..":
 * both arguments come from the caller, who can point anywhere via cachePath regardless, so
 * there is no boundary here to enforce by default. Callers passing an untrusted fileName
 * opt in with restrictToCachePath.
 */
function resolveTarget(cachePath: string, fileName: string, restrict: boolean): string {
  const root = path.resolve(cachePath);
  const resolved = path.resolve(root, fileName);
  if (!restrict) {
    return resolved;
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  // Compare the way the filesystem does, so an absolute fileName that differs only in case
  // is not rejected as though it were outside.
  const insensitive = CASE_INSENSITIVE_PLATFORMS.includes(process.platform);
  const contained = insensitive
    ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
    : resolved.startsWith(prefix);
  if (!contained) {
    throw new Error(`fileName "${fileName}" resolves outside of the cache path`);
  }
  return resolved;
}

/** Creates the directory and an empty file, adopting either if it is already there. */
function ensureFile(file: string, directory: string): void {
  // A recursive mkdir is already a no-op for a directory that exists, so testing first
  // would only add a syscall and a window for the directory to appear in between.
  fs.mkdirSync(directory, { recursive: true });
  try {
    // "wx" rather than a bare write: between an existence check and a plain write, another
    // process could create and populate the file, and the write would truncate everything
    // it had just put there.
    fs.writeFileSync(file, "", { flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

function booleanOption(value: unknown, label: string): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value === true;
}

function numberOption(value: unknown, label: string, fallback: number, minimum: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite number no less than ${minimum}`);
  }
  return value;
}

export default class IniFileCache {
  private file: string;
  private baseName: string;
  /** The watched directory: dirname of the file, needed on every watch and every retry. */
  private directory: string;
  private settings: ISection[];
  /**
   * Normalized section name to the same ISection objects held in `settings`. Without it
   * every lookup is a linear scan, so walking a file's own sections costs O(n²) — about a
   * second for 4,000 sections.
   */
  private sectionIndex: Map<string, ISection>;
  private watching: fs.FSWatcher | null;
  // Consecutive watch events that named something other than the watched file.
  private unmatchedEvents: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null;
  // When the current burst of change events began, for the maximum-wait cap.
  private debounceStartedAt: number | null;
  private lastWrite: IFileSignature | null;
  private ready: boolean;
  // Preserved from the file that was read so a save does not silently rewrite the
  // encoding marker or the line endings of an existing file. The mark is kept as the
  // exact bytes that were found: re-encoding U+FEFF would emit the wrong ones for any
  // encoding other than the file's own.
  private byteOrderMarkBytes: Buffer | null;
  private endOfLine: string;
  private namelessHasHeader: boolean;
  private _listener: IIniFileCacheListener;
  // True when the last read could not be decoded losslessly, so writing it back would
  // change bytes the library never touched.
  private lossyRead: boolean;
  // False until the file has been parsed successfully at least once. Saving before that
  // would write an empty cache over a file whose contents were never understood.
  private loaded: boolean;
  private readonly maxFileSize: number;
  private readonly caseInsensitive: boolean;
  private readonly debounceDelay: number;
  private readonly encoding: BufferEncoding;

  constructor(cachePath: string, fileName: string, options: IIniFileCacheOptions = {}) {
    requiredString(cachePath, "cachePath");
    requiredString(fileName, "fileName");
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }
    if (options.encoding !== undefined && !Buffer.isEncoding(options.encoding)) {
      throw new TypeError(`encoding "${options.encoding}" is not a supported buffer encoding`);
    }

    this.settings = [];
    this.sectionIndex = new Map();
    // The emitter catches a handler's exception and reports it here rather than letting it
    // propagate out of emit(), so this hook — not a try/catch around emit — is what keeps a
    // throwing listener from escaping into library control flow. Supplying it also replaces
    // the emitter's default hook, which writes the exception to the console.
    this._listener = new Emitter({
      onError: (error: unknown, event: string) => this.reportListenerError(error, event),
    });
    this.watching = null;
    this.unmatchedEvents = 0;
    this.debounceTimer = null;
    this.debounceStartedAt = null;
    this.lastWrite = null;
    this.byteOrderMarkBytes = null;
    this.endOfLine = "\n";
    this.namelessHasHeader = false;
    this.lossyRead = false;
    this.loaded = false;
    // Errors raised while the constructor runs are deferred, so a listener attached
    // immediately after construction still sees them.
    this.ready = false;
    this.maxFileSize = numberOption(options.maxFileSize, "maxFileSize", DEFAULT_MAX_FILE_SIZE, 1);
    this.caseInsensitive = booleanOption(options.caseInsensitive, "caseInsensitive");
    this.debounceDelay = numberOption(options.debounceDelay, "debounceDelay", DEFAULT_DEBOUNCE_DELAY, 0);
    const restrictToCachePath = booleanOption(options.restrictToCachePath, "restrictToCachePath");
    this.encoding = options.encoding ?? "utf8";

    this.file = resolveTarget(cachePath, fileName, restrictToCachePath);
    this.baseName = path.basename(this.file);
    this.directory = path.dirname(this.file);
    ensureFile(this.file, this.directory);

    this.loadSync();
    this.watch();
    this.ready = true;
  }

  get listener(): IIniFileCacheListener {
    return this._listener;
  }

  /**
   * Emits without letting a listener's exception escape into library control flow, and
   * defers events raised during construction until a listener can exist.
   */
  private emitEvent(event: IniEvent, payload?: unknown): void {
    if (!this.ready) {
      // Dispatched directly rather than re-entering this check: if the constructor threw
      // before setting `ready`, re-checking would reschedule itself forever.
      setImmediate(() => this.dispatchEvent(event, payload));
      return;
    }
    this.dispatchEvent(event, payload);
  }

  private dispatchEvent(event: IniEvent, payload?: unknown): void {
    try {
      this._listener.emit(event, payload);
    } catch (error) {
      // The emitter hands a handler's exception to the onError hook installed in the
      // constructor rather than letting it escape, so this catches only a failure of
      // emit itself.
      this.reportListenerError(error, event);
    }
  }

  /**
   * A listener threw. It is reported as an `error` event so that it cannot escape into
   * library control flow, unless the listener that threw was an `error` listener itself:
   * routing that back through the same event would loop.
   */
  private reportListenerError(error: unknown, event: string): void {
    if (event === "error") {
      return;
    }
    try {
      this._listener.emit("error", toError(error));
    } catch {
      // The error listener threw as well; there is nowhere left to report this.
    }
  }

  /** Normalizes a section name or key for comparison. Never throws, so lookups stay lenient. */
  private normalize(input: string): string {
    const trimmed = typeof input === "string" ? input.trim() : "";
    return this.caseInsensitive ? trimmed.toLowerCase() : trimmed;
  }

  private findSection(section: string): ISection | null {
    if (typeof section !== "string") {
      // "" is a real section name — the nameless leading one — so a non-string must not
      // normalize into it and hand back settings the caller never asked for.
      return null;
    }
    return this.sectionIndex.get(this.normalize(section)) ?? null;
  }

  private findSetting(section: ISection, key: string): ISetting | null {
    if (typeof key !== "string") {
      // Mirrors findSection: a non-string must not normalize to "" and match something.
      return null;
    }
    return section.keys.get(this.normalize(key)) ?? null;
  }

  /** Resolves to true when the content parsed; false when it was rejected and `error` was emitted. */
  parseContents(contents: string): boolean {
    return this.parse(contents, null);
  }

  /**
   * Replaces the cache with `contents`. `source` is the read it came from, or null when a
   * caller supplied it directly — which is what decides whether a lossy decode still
   * describes what the cache holds.
   */
  private parse(contents: string, source: IReadResult | null): boolean {
    if (typeof contents !== "string") {
      this.emitEvent("error", new TypeError("contents must be a string"));
      return false;
    }

    // A file read hands its mark over as bytes; a string passed in directly may still
    // carry U+FEFF, which is encoded with this file's encoding so UTF-16 keeps FF FE
    // rather than being handed UTF-8's EF BB BF.
    let byteOrderMark = source ? source.byteOrderMark : undefined;

    let body = contents;
    if (contents.charCodeAt(0) === BYTE_ORDER_MARK_CODE) {
      body = contents.slice(1);
      byteOrderMark = Buffer.from(BYTE_ORDER_MARK, this.encoding);
    }

    const firstLineBreak = LINE_BREAK.exec(body);

    const lines = body.split(LINE_BREAK);
    const sections: ISection[] = [];
    // Indexed by normalized name so that parsing stays linear in the number of lines
    // rather than scanning every section and key already seen.
    const sectionIndex = new Map<string, ISection>();
    let currentSection: ISection | null = null;
    let sawContentOutsideSection = false;
    let sawSectionHeader = false;
    // Whether the nameless leading section came from a literal "[]" header rather than
    // from bare keys, so that a save reproduces the file it read.
    let namelessHasHeader = false;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(";") || trimmedLine.startsWith("#")) {
        // Blank lines and comments carry no settings.
        continue;
      }

      const header = SECTION_HEADER.exec(trimmedLine);
      if (header) {
        const name = header[1].trim();
        const normalized = this.normalize(name);
        sawSectionHeader = true;
        if (name === "") {
          // Recorded for every "[]" header, not only one that creates the section: leading
          // bare keys may have created it already, and the header would then be dropped.
          namelessHasHeader = true;
        }
        let section = sectionIndex.get(normalized);
        if (!section) {
          section = addSection(name, normalized, sections, sectionIndex);
        }
        // A repeated header continues the existing section rather than shadowing it.
        currentSection = section;
        continue;
      }

      if (!currentSection) {
        // Settings before any header belong to a nameless leading section, kept so that
        // a save does not erase the part of the file this parser did not ask for.
        sawContentOutsideSection = true;
        currentSection = addSection("", "", sections, sectionIndex, true);
      }

      // Split on the first "=" only, so values may contain "=" themselves.
      const separator = trimmedLine.indexOf("=");
      const key = (separator === -1 ? trimmedLine : trimmedLine.slice(0, separator)).trim();
      if (!key) {
        continue;
      }
      const value = separator === -1 ? "" : trimmedLine.slice(separator + 1).trim();

      const normalizedKey = this.normalize(key);
      const existing = currentSection.keys.get(normalizedKey);
      if (existing) {
        existing.value = value;
        continue;
      }
      addSetting(currentSection, key, normalizedKey, value);
    }

    if (sawContentOutsideSection && !sawSectionHeader) {
      // Settings but not one header in the whole file: far more likely a truncated read
      // than an ini file. Leave the cached settings alone, because the next save() would
      // otherwise write that damage back to disk.
      this.emitEvent("error", new Error("Invalid ini file format"));
      return false;
    }

    this.loaded = true;
    // Set here rather than at the read, so it describes the content the cache actually
    // holds. Content handed in directly replaces every byte that came from the file, so
    // there is nothing left for the refusal to protect.
    this.lossyRead = source !== null && source.lossy;
    this.namelessHasHeader = namelessHasHeader;
    if (byteOrderMark !== undefined) {
      this.byteOrderMarkBytes = byteOrderMark;
    }
    if (firstLineBreak) {
      // Match the file's existing line endings. Content with no line break at all leaves
      // the current choice alone, so an empty file keeps the default.
      this.endOfLine = firstLineBreak[0];
    }
    this.settings = sections;
    this.sectionIndex = sectionIndex;
    return true;
  }

  /** Reads the file, refusing anything larger than maxFileSize. Throws on read errors. */
  private readFileContents(): IReadResult | null {
    // Measured and read through one descriptor. Stat-then-read by path lets a file that
    // grows in between be read in full, which is the size limit failing exactly when it is
    // needed: against a file that is being written to right now.
    const descriptor = fs.openSync(this.file, "r");
    let raw: Buffer;
    try {
      const stats = fs.fstatSync(descriptor);
      if (stats.size > this.maxFileSize) {
        this.emitEvent(
          "error",
          new Error(`${this.file} is ${stats.size} bytes, which exceeds the maximum of ${this.maxFileSize} bytes`)
        );
        return null;
      }
      raw = fs.readFileSync(descriptor);
      if (raw.length > this.maxFileSize) {
        // The file grew while it was being read. Reading to the end of the descriptor is
        // what keeps the content consistent, so the limit is enforced again on the result
        // rather than by truncating it into a half file that would parse as a whole one.
        this.emitEvent(
          "error",
          new Error(`${this.file} is ${raw.length} bytes, which exceeds the maximum of ${this.maxFileSize} bytes`)
        );
        return null;
      }
    } finally {
      fs.closeSync(descriptor);
    }

    // Strip the byte order mark before decoding rather than after. Under a single-byte
    // encoding it would otherwise decode to three stray characters glued to the first
    // line, which swallows a leading section header.
    const hasByteOrderMark = raw.subarray(0, 3).equals(BYTE_ORDER_MARK_BYTES);
    const buffer = hasByteOrderMark ? raw.subarray(3) : raw;
    const decoded = buffer.toString(this.encoding);

    // Decoding a legacy single-byte file as UTF-8 turns every high byte into U+FFFD.
    // Writing that back would replace bytes this library never touched, so detect it by
    // re-encoding and refuse to save rather than corrupt the file.
    const lossy = !Buffer.from(decoded, this.encoding).equals(buffer);
    if (lossy) {
      this.emitEvent(
        "error",
        new Error(
          `${this.file} is not valid ${this.encoding}; saving would corrupt it. ` +
            `Construct with { encoding: "latin1" } if it uses a legacy single-byte encoding.`
        )
      );
    }

    // The mark travels as bytes rather than as a character, so the exact one that was
    // found is the one written back.
    return { contents: decoded, byteOrderMark: hasByteOrderMark ? BYTE_ORDER_MARK_BYTES : null, lossy };
  }

  /** Single-attempt synchronous load, used during construction. */
  private loadSync(): void {
    try {
      const read = this.readFileContents();
      if (read !== null) {
        this.parse(read.contents, read);
      }
    } catch (error) {
      this.emitEvent("error", new Error(`Failed to read file: ${error}`));
    }
  }

  /**
   * Reads with retries, because a file being replaced is briefly unreadable. `guard` is
   * re-checked before every attempt and abandons the read silently when it returns false.
   * Resolves null when there is nothing to parse, having already emitted the reason.
   */
  private async readWithRetries(guard?: () => boolean): Promise<IReadResult | null> {
    for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt++) {
      if (guard && !guard()) {
        return null;
      }
      try {
        return this.readFileContents();
      } catch (error) {
        if (attempt === READ_MAX_ATTEMPTS - 1) {
          this.emitEvent("error", new Error(`Failed to read file after ${READ_MAX_ATTEMPTS} attempts: ${error}`));
          // The usual cause of an unreadable file is a deleted one, and the directory may
          // have gone with it. Other platforms simply stop delivering watch events in that
          // case, so this is where a dead watcher is noticed there.
          this.stopIfDirectoryMissing();
          return null;
        }
        await delay(READ_RETRY_DELAY);
      }
    }
    return null;
  }

  /** Resolves true when the file was read; false when it could not be and `error` was emitted. */
  async cacheFileSettings(): Promise<boolean> {
    const read = await this.readWithRetries();
    if (read === null) {
      return false;
    }
    return this.parse(read.contents, read);
  }

  getSetting(section: string, key: string, defaultValue: string | null = null): string | null {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return defaultValue;
    }
    const setting = this.findSetting(sectionObj, key);
    if (!setting) {
      return defaultValue;
    }
    return setting.value;
  }

  getBool(section: string, key: string, defaultValue: boolean = false): boolean {
    const value = this.getSetting(section, key);
    if (value === null || value === "") {
      return defaultValue;
    }

    // Already trimmed, both by the parser and by setSetting.
    if (TRUE_VALUES.test(value)) {
      return true;
    }
    if (FALSE_VALUES.test(value)) {
      return false;
    }

    return defaultValue;
  }

  getInt(section: string, key: string, defaultValue: number = 0): number {
    const value = this.getSetting(section, key);
    if (value === null || value === "") {
      return defaultValue;
    }

    if (!INTEGER_VALUE.test(value)) {
      return defaultValue;
    }

    const intValue = Number(value);
    if (!Number.isSafeInteger(intValue)) {
      return defaultValue;
    }

    return intValue;
  }

  setSetting(section: string, key: string, value: string): void {
    // "" addresses the nameless leading section, the one holding keys that appear before
    // any header; every other name goes through the usual validation.
    const sectionName =
      typeof section === "string" && !section.trim() ? "" : sanitizeName(section, "section", INVALID_SECTION);
    const settingKey = sanitizeKey(key);
    const settingValue = sanitizeValue(value);

    let sectionObj = this.findSection(sectionName);
    if (!sectionObj) {
      sectionObj = addSection(sectionName, this.normalize(sectionName), this.settings, this.sectionIndex);
    }

    const setting = this.findSetting(sectionObj, settingKey);
    if (setting) {
      setting.value = settingValue;
      return;
    }
    addSetting(sectionObj, settingKey, this.normalize(settingKey), settingValue);
  }

  getSections(): string[] {
    return this.settings.map((s) => s.name);
  }

  getKeys(section: string): string[] {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return [];
    }
    return sectionObj.settings.map((s) => s.key);
  }

  hasSection(section: string): boolean {
    return this.findSection(section) !== null;
  }

  hasKey(section: string, key: string): boolean {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return false;
    }
    return this.findSetting(sectionObj, key) !== null;
  }

  removeSection(section: string): void {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return;
    }
    this.settings.splice(this.settings.indexOf(sectionObj), 1);
    this.sectionIndex.delete(this.normalize(section));
  }

  removeKey(section: string, key: string): void {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return;
    }
    const setting = this.findSetting(sectionObj, key);
    if (!setting) {
      return;
    }
    sectionObj.settings.splice(sectionObj.settings.indexOf(setting), 1);
    sectionObj.keys.delete(this.normalize(key));
  }

  /** Resolves true when the file was re-read and parsed; false when it was not. */
  async reload(): Promise<boolean> {
    if (!(await this.cacheFileSettings())) {
      // The cache still holds what it held before, so there is nothing to announce; the
      // failure has already gone out as an error.
      return false;
    }
    this.emitEvent("reload", this.file);
    return true;
  }

  /**
   * Publishes `contents` to the file. The rename makes the replacement atomic, so a
   * concurrent reader never sees a partial file. Windows refuses to rename over a file
   * another process holds open, so after a few attempts this falls back to writing in
   * place, which that platform does allow. The fallback is not atomic, but a save that
   * silently fails is worse than one that is briefly observable mid-write.
   */
  private async writeContents(contents: string): Promise<void> {
    const body = Buffer.from(contents, this.encoding);
    // Exactly the bytes the file had, so a UTF-16 file keeps FF FE and a UTF-8 one keeps
    // EF BB BF instead of both being given whichever the code happened to hard-code.
    const buffer = this.byteOrderMarkBytes ? Buffer.concat([this.byteOrderMarkBytes, body]) : body;

    // Renaming over a symbolic link replaces the link itself. Write through it instead,
    // so the file the caller actually pointed at is the one that changes.
    let isSymbolicLink = false;
    try {
      isSymbolicLink = fs.lstatSync(this.file).isSymbolicLink();
    } catch {
      // The file may not exist yet; treat it as a regular file.
    }
    if (isSymbolicLink) {
      fs.writeFileSync(this.file, buffer, WRITE_OPTIONS);
      return;
    }

    const temp = tempPath(this.file);
    fs.writeFileSync(temp, buffer, WRITE_OPTIONS);

    for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(temp, this.file);
        return;
      } catch (error: any) {
        if (!RENAME_FALLBACK_CODES.includes(error?.code)) {
          throw error;
        }
        if (attempt < RENAME_MAX_ATTEMPTS - 1) {
          await delay(RENAME_RETRY_DELAY);
        }
      }
    }

    fs.writeFileSync(this.file, buffer, WRITE_OPTIONS);
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temporary file is harmless if it cannot be removed.
    }
  }

  /** Renders the cache as ini text. Kept separate so a save can do it while holding the lock. */
  private serialize(): string {
    const eol = this.endOfLine;
    let contents = "";
    this.settings.forEach((section, index) => {
      // The nameless section may only go without a header while it leads the file and
      // some other section follows it: anywhere else its keys would be read back as part
      // of the section above, and on its own the file would have no header at all and so
      // would not parse.
      const bare =
        section.name === "" && index === 0 && !this.namelessHasHeader && this.settings.length > 1;
      if (bare && !section.settings.length) {
        // Nothing to write, and a stray blank line here would break save/reload equality.
        return;
      }
      if (!bare) {
        contents += `[${section.name}]${eol}`;
      }
      for (const setting of section.settings) {
        contents += `${setting.key}=${setting.value}${eol}`;
      }
      contents += eol;
    });
    return contents;
  }

  async save(): Promise<boolean> {
    if (!this.loaded) {
      // The cache is empty because the file has never parsed, not because it has no
      // settings. Writing now would replace a file we never understood with nothing.
      this.emitEvent(
        "error",
        new Error(`Refusing to save ${this.file}: its contents have never been parsed successfully.`)
      );
      return false;
    }

    if (this.lossyRead) {
      this.emitEvent(
        "error",
        new Error(
          `Refusing to save ${this.file}: it could not be decoded as ${this.encoding} without loss, ` +
            `so writing it back would corrupt bytes this library did not touch.`
        )
      );
      return false;
    }

    const lock = await acquireLock(this.file);
    if (!lock.token) {
      const reason = lock.error ? `: ${lock.error}` : " (timed out waiting for another writer)";
      this.emitEvent("error", new Error(`Failed to acquire the lock for ${this.file}${reason}`));
      return false;
    }

    let failure: unknown = null;
    try {
      // Rendered only now that the lock is held. Acquiring it can wait seconds, and the
      // watcher may adopt an external change during that wait; rendering earlier would
      // write settings the cache no longer holds and leave the two permanently divergent,
      // because the resulting change event is then suppressed as our own write.
      await this.writeContents(this.serialize());
      // Remember what we wrote so the watcher can tell our own change from someone else's.
      this.lastWrite = this.readSignature();
    } catch (error) {
      failure = error;
      try {
        fs.unlinkSync(tempPath(this.file));
      } catch {
        // Nothing to clean up.
      }
    } finally {
      releaseLock(this.file, lock.token);
    }

    // Emitted outside the try so that a throwing listener cannot be mistaken for a
    // failed write.
    if (failure !== null) {
      this.emitEvent("error", toError(failure));
      return false;
    }
    this.emitEvent("save", this.file);
    return true;
  }

  private readSignature(): IFileSignature | null {
    try {
      const stats = fs.statSync(this.file);
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return null;
    }
  }

  /** True when the file on disk is still exactly what this instance last wrote. */
  private isOwnLastWrite(): boolean {
    if (!this.lastWrite) {
      return false;
    }
    const current = this.readSignature();
    return current !== null && current.size === this.lastWrite.size && current.mtimeMs === this.lastWrite.mtimeMs;
  }

  /** True while a watcher is active on the file. */
  isWatching(): boolean {
    return this.watching !== null;
  }

  watch(): void {
    if (this.watching) {
      return;
    }

    // Watch the containing directory rather than the file itself: an atomic save
    // (ours or an external editor's) replaces the file, which silently kills a
    // watcher bound to the old file.
    this.unmatchedEvents = 0;
    try {
      this.watching = fs.watch(this.directory, (_event: string, filename: string | Buffer | null) => {
        if (filename !== null && filename !== undefined && !this.matchesFile(filename)) {
          // Deleting the watched directory makes Windows deliver events naming the
          // directory itself, without end and without ever reporting an error or a close.
          // None of them match, so nothing reloads, but the callback would run tens of
          // thousands of times a second for the life of the process. Checking every so
          // often costs one stat per burst and nothing at all on a quiet directory.
          if (++this.unmatchedEvents >= UNMATCHED_EVENTS_BEFORE_CHECK) {
            this.unmatchedEvents = 0;
            this.stopIfDirectoryMissing();
          }
          return;
        }
        this.unmatchedEvents = 0;
        this.scheduleReload();
      });
    } catch (error) {
      this.watching = null;
      this.emitEvent("error", new Error(`Failed to watch file: ${error}`));
      return;
    }

    this.watching.on("error", (error: Error) => {
      this.emitEvent("error", error);
    });

    this.watching.once("close", () => {
      this.emitEvent("close");
    });
  }

  private matchesFile(filename: string | Buffer): boolean {
    const name = path.basename(typeof filename === "string" ? filename : filename.toString());
    if (CASE_INSENSITIVE_PLATFORMS.includes(process.platform)) {
      return name.toLowerCase() === this.baseName.toLowerCase();
    }
    return name === this.baseName;
  }

  /**
   * Closes a watcher whose directory has been removed, since it can never deliver another
   * usable event: the handle refers to an inode that is gone, and recreating the directory
   * does not re-attach it. Leaving it open makes isWatching() claim a watcher that cannot
   * work, and stops watch() from establishing a new one.
   */
  private stopIfDirectoryMissing(): void {
    if (!this.watching || fs.existsSync(this.directory)) {
      return;
    }
    this.unwatch();
    this.emitEvent("error", new Error(`Stopped watching ${this.file}: ${this.directory} no longer exists`));
  }

  /**
   * Coalesces the multiple events most platforms emit for a single write, but only up to
   * DEBOUNCE_MAX_WAIT_FACTOR times the delay: a file being rewritten faster than the delay
   * would otherwise restart the timer indefinitely and never be adopted at all.
   */
  private scheduleReload(): void {
    const now = Date.now();
    if (this.debounceStartedAt === null) {
      this.debounceStartedAt = now;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const remaining = this.debounceDelay * DEBOUNCE_MAX_WAIT_FACTOR - (now - this.debounceStartedAt);
    const wait = remaining <= 0 ? 0 : Math.min(this.debounceDelay, remaining);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.debounceStartedAt = null;
      void this.handleChange();
    }, wait);

    if (typeof (this.debounceTimer as any)?.unref === "function") {
      (this.debounceTimer as any).unref();
    }
  }

  private async handleChange(): Promise<void> {
    try {
      // The guard is re-checked before every attempt: unwatch() may have been called, or a
      // save may have made the file ours, while the read was waiting to be retried.
      const read = await this.readWithRetries(() => this.watching !== null && !this.isOwnLastWrite());
      if (read === null) {
        return;
      }

      // The file is the source of truth: adopting it discards unsaved in-memory edits,
      // which is the point of a cache that follows the file.
      const parsed = this.parse(read.contents, read);
      if (!this.watching || !parsed) {
        // A rejected parse leaves the cache as it was, so there is no change to report;
        // the failure has already gone out as an error.
        return;
      }
      this.emitEvent("change", this.baseName);
    } catch (error) {
      // Nothing may escape here: this runs detached from any caller, so an exception
      // would surface as an unhandled rejection and terminate the process.
      this.emitEvent("error", toError(error));
    }
  }

  unwatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceStartedAt = null;
    if (!this.watching) {
      return;
    }
    if (typeof this.watching.close === "function") {
      this.watching.close();
    }
    this.watching = null;
  }
}
