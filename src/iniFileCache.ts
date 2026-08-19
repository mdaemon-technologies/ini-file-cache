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

interface IFileSignature {
  size: number;
  mtimeMs: number;
}

/**
 * The subscription surface of the `listener` property. Declared here rather than taken
 * from the emitter package so the published types describe exactly what this library
 * supports, and do not depend on how that package ships its own declarations.
 */
export interface IIniFileCacheListener {
  on(event: "change" | "reload" | "save", handler: (filePath: string) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: string, handler: (...args: any[]) => void): void;
  once(event: string, handler: (...args: any[]) => void): void;
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

// U+FEFF, written as the three-byte UTF-8 sequence EF BB BF.
const BYTE_ORDER_MARK = "﻿";
const BYTE_ORDER_MARK_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

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
    try {
      descriptor = fs.openSync(lock, "wx");
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
        if (fs.existsSync(lock)) {
          // The lock was created but could not be stamped with our token, so it would
          // block every writer until it aged out. Take it back out.
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

function positiveNumberOption(value: unknown, label: string, fallback: number, minimum: number): number {
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
  private settings: ISection[];
  /**
   * Normalized section name to the same ISection objects held in `settings`. Without it
   * every lookup is a linear scan, so walking a file's own sections costs O(n²) — about a
   * second for 4,000 sections.
   */
  private sectionIndex: Map<string, ISection>;
  private watching: fs.FSWatcher | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null;
  private lastWrite: IFileSignature | null;
  private ready: boolean;
  // Preserved from the file that was read so a save does not silently rewrite the
  // encoding marker or the line endings of an existing file. The mark is kept as the
  // exact bytes that were found: re-encoding U+FEFF would emit the wrong ones for any
  // encoding other than the file's own.
  private byteOrderMarkBytes: Buffer | null;
  // Carries the mark from a file read into the parse that follows it. `undefined` means
  // the content did not come from a file, so the current mark stands.
  private pendingByteOrderMark: Buffer | null | undefined;
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

  constructor(
    private readonly cachePath: string,
    private readonly fileName: string,
    options: IIniFileCacheOptions = {}
  ) {
    if (typeof cachePath !== "string" || !cachePath.trim()) {
      throw new TypeError("cachePath must be a non-empty string");
    }
    if (typeof fileName !== "string" || !fileName.trim()) {
      throw new TypeError("fileName must be a non-empty string");
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }
    if (options.caseInsensitive !== undefined && typeof options.caseInsensitive !== "boolean") {
      throw new TypeError("caseInsensitive must be a boolean");
    }
    if (options.restrictToCachePath !== undefined && typeof options.restrictToCachePath !== "boolean") {
      throw new TypeError("restrictToCachePath must be a boolean");
    }
    if (options.encoding !== undefined && !Buffer.isEncoding(options.encoding)) {
      throw new TypeError(`encoding "${options.encoding}" is not a supported buffer encoding`);
    }

    this.settings = [];
    this.sectionIndex = new Map();
    this._listener = new Emitter();
    this.watching = null;
    this.debounceTimer = null;
    this.lastWrite = null;
    this.byteOrderMarkBytes = null;
    this.pendingByteOrderMark = undefined;
    this.endOfLine = "\n";
    this.namelessHasHeader = false;
    this.lossyRead = false;
    this.loaded = false;
    // Errors raised while the constructor runs are deferred, so a listener attached
    // immediately after construction still sees them.
    this.ready = false;
    this.maxFileSize = positiveNumberOption(options.maxFileSize, "maxFileSize", DEFAULT_MAX_FILE_SIZE, 1);
    this.caseInsensitive = options.caseInsensitive === true;
    this.debounceDelay = positiveNumberOption(options.debounceDelay, "debounceDelay", DEFAULT_DEBOUNCE_DELAY, 0);
    this.encoding = options.encoding ?? "utf8";

    // A fileName may reach outside cachePath with "..": both arguments come from the
    // caller, who can point anywhere via cachePath regardless, so there is no boundary
    // here to enforce by default. Callers that do pass an untrusted fileName can opt in.
    const root = path.resolve(this.cachePath);
    const resolved = path.resolve(root, this.fileName);
    if (options.restrictToCachePath === true) {
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      // Compare the way the filesystem does, so an absolute fileName that differs only in
      // case is not rejected as though it were outside.
      const insensitive = CASE_INSENSITIVE_PLATFORMS.includes(process.platform);
      const contained = insensitive
        ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
        : resolved.startsWith(prefix);
      if (!contained) {
        throw new Error(`fileName "${fileName}" resolves outside of the cache path`);
      }
    }

    this.file = resolved;
    this.baseName = path.basename(this.file);

    const directory = path.dirname(this.file);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    try {
      // "wx" rather than a bare write: between an existence check and a plain write,
      // another process could create and populate the file, and the write would truncate
      // everything it had just put there.
      fs.writeFileSync(this.file, "", { flag: "wx" });
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

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
  private emitEvent(event: string, payload?: unknown): void {
    if (!this.ready) {
      // Dispatched directly rather than re-entering this check: if the constructor threw
      // before setting `ready`, re-checking would reschedule itself forever.
      setImmediate(() => this.dispatchEvent(event, payload));
      return;
    }
    this.dispatchEvent(event, payload);
  }

  private dispatchEvent(event: string, payload?: unknown): void {
    try {
      this._listener.emit(event, payload);
    } catch (error) {
      if (event === "error") {
        // Reporting a failed error listener through the same listener would loop.
        return;
      }
      try {
        this._listener.emit("error", error);
      } catch {
        // The error listener threw as well; there is nowhere left to report this.
      }
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
    if (typeof contents !== "string") {
      this.emitEvent("error", new TypeError("contents must be a string"));
      return false;
    }

    // A file read hands its mark over as bytes; a string passed in directly may still
    // carry U+FEFF, which is encoded with this file's encoding so UTF-16 keeps FF FE
    // rather than being handed UTF-8's EF BB BF.
    let byteOrderMark = this.pendingByteOrderMark;
    this.pendingByteOrderMark = undefined;

    let body = contents;
    if (contents.charCodeAt(0) === 0xfeff) {
      body = contents.slice(1);
      byteOrderMark = Buffer.from(BYTE_ORDER_MARK, this.encoding);
    }

    const firstLineBreak = /\r\n|\n|\r/.exec(body);

    const lines = body.split(/\r\n|\n|\r/);
    const sections: ISection[] = [];
    // Indexed by normalized name so that parsing stays linear in the number of lines
    // rather than scanning every section and key already seen.
    const sectionIndex = new Map<string, ISection>();
    const settingIndex = new Map<string, Map<string, ISetting>>();
    let currentSection: ISection | null = null;
    let currentSettings: Map<string, ISetting> | null = null;
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
        let section = sectionIndex.get(normalized);
        if (!section) {
          if (name === "") {
            namelessHasHeader = true;
          }
          section = { name, settings: [], keys: new Map() };
          sectionIndex.set(normalized, section);
          sections.push(section);
        }
        // A repeated header continues the existing section rather than shadowing it.
        currentSection = section;
        continue;
      }

      if (!currentSection) {
        // Settings before any header belong to a nameless leading section, kept so that
        // a save does not erase the part of the file this parser did not ask for.
        sawContentOutsideSection = true;
        currentSection = { name: "", settings: [], keys: new Map() };
        sectionIndex.set("", currentSection);
        sections.unshift(currentSection);
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
      const setting = { key, value };
      currentSection.settings.push(setting);
      currentSection.keys.set(normalizedKey, setting);
    }

    if (sawContentOutsideSection && !sawSectionHeader) {
      // Settings but not one header in the whole file: far more likely a truncated read
      // than an ini file. Leave the cached settings alone, because the next save() would
      // otherwise write that damage back to disk.
      this.emitEvent("error", new Error("Invalid ini file format"));
      return false;
    }

    this.loaded = true;
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
  private readFileContents(): string | null {
    const stats = fs.statSync(this.file);
    if (stats.size > this.maxFileSize) {
      this.emitEvent(
        "error",
        new Error(`${this.file} is ${stats.size} bytes, which exceeds the maximum of ${this.maxFileSize} bytes`)
      );
      return null;
    }

    const raw = fs.readFileSync(this.file);

    // Strip the byte order mark before decoding rather than after. Under a single-byte
    // encoding it would otherwise decode to three stray characters glued to the first
    // line, which swallows a leading section header.
    const hasByteOrderMark = raw.subarray(0, 3).equals(BYTE_ORDER_MARK_BYTES);
    const buffer = hasByteOrderMark ? raw.subarray(3) : raw;
    const decoded = buffer.toString(this.encoding);

    // Decoding a legacy single-byte file as UTF-8 turns every high byte into U+FFFD.
    // Writing that back would replace bytes this library never touched, so detect it by
    // re-encoding and refuse to save rather than corrupt the file.
    this.lossyRead = !Buffer.from(decoded, this.encoding).equals(buffer);
    if (this.lossyRead) {
      this.emitEvent(
        "error",
        new Error(
          `${this.file} is not valid ${this.encoding}; saving would corrupt it. ` +
            `Construct with { encoding: "latin1" } if it uses a legacy single-byte encoding.`
        )
      );
    }

    // Handed to parseContents as bytes rather than as a character, so the exact mark is
    // the one written back. Set last: every successful read is parsed immediately, which
    // is what consumes this.
    this.pendingByteOrderMark = hasByteOrderMark ? BYTE_ORDER_MARK_BYTES : null;
    return decoded;
  }

  /** Single-attempt synchronous load, used during construction. */
  private loadSync(): void {
    try {
      const contents = this.readFileContents();
      if (contents !== null) {
        this.parseContents(contents);
      }
    } catch (error) {
      this.emitEvent("error", new Error(`Failed to read file: ${error}`));
    }
  }

  /** Resolves true when the file was read; false when it could not be and `error` was emitted. */
  async cacheFileSettings(): Promise<boolean> {
    for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt++) {
      try {
        const contents = this.readFileContents();
        if (contents === null) {
          return false;
        }
        return this.parseContents(contents);
      } catch (error) {
        if (attempt === READ_MAX_ATTEMPTS - 1) {
          this.emitEvent("error", new Error(`Failed to read file after ${READ_MAX_ATTEMPTS} attempts: ${error}`));
          return false;
        }
        await delay(READ_RETRY_DELAY);
      }
    }
    return false;
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

    const trimmed = value.trim();
    if (TRUE_VALUES.test(trimmed)) {
      return true;
    }
    if (FALSE_VALUES.test(trimmed)) {
      return false;
    }

    return defaultValue;
  }

  getInt(section: string, key: string, defaultValue: number = 0): number {
    const value = this.getSetting(section, key);
    if (value === null || value === "") {
      return defaultValue;
    }

    const trimmed = value.trim();
    if (!INTEGER_VALUE.test(trimmed)) {
      return defaultValue;
    }

    const intValue = Number(trimmed);
    if (!Number.isSafeInteger(intValue)) {
      return defaultValue;
    }

    return intValue;
  }

  setSetting(section: string, key: string, value: string) {
    // "" addresses the nameless leading section, the one holding keys that appear before
    // any header; every other name goes through the usual validation.
    const sectionName =
      typeof section === "string" && !section.trim() ? "" : sanitizeName(section, "section", INVALID_SECTION);
    const settingKey = sanitizeKey(key);
    const settingValue = sanitizeValue(value);

    const created = { key: settingKey, value: settingValue };
    let sectionObj = this.findSection(sectionName);
    if (!sectionObj) {
      sectionObj = { name: sectionName, settings: [], keys: new Map() };
      this.settings.push(sectionObj);
      this.sectionIndex.set(this.normalize(sectionName), sectionObj);
    }

    const setting = this.findSetting(sectionObj, settingKey);
    if (setting) {
      setting.value = settingValue;
      return;
    }
    sectionObj.settings.push(created);
    sectionObj.keys.set(this.normalize(settingKey), created);
  }

  getSections() {
    return this.settings.map((s) => s.name);
  }

  getKeys(section: string) {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return [];
    }
    return sectionObj.settings.map((s) => s.key);
  }

  hasSection(section: string) {
    return this.findSection(section) !== null;
  }

  hasKey(section: string, key: string) {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return false;
    }
    return this.findSetting(sectionObj, key) !== null;
  }

  removeSection(section: string) {
    const sectionObj = this.findSection(section);
    if (!sectionObj) {
      return;
    }
    this.settings.splice(this.settings.indexOf(sectionObj), 1);
    this.sectionIndex.delete(this.normalize(section));
  }

  removeKey(section: string, key: string) {
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
      fs.writeFileSync(this.file, buffer, { flush: true });
      return;
    }

    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, buffer, { flush: true });

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

    fs.writeFileSync(this.file, buffer, { flush: true });
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
        fs.unlinkSync(`${this.file}.tmp`);
      } catch {
        // Nothing to clean up.
      }
    } finally {
      releaseLock(this.file, lock.token);
    }

    // Emitted outside the try so that a throwing listener cannot be mistaken for a
    // failed write.
    if (failure !== null) {
      this.emitEvent("error", failure);
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

  watch() {
    if (this.watching) {
      return;
    }

    // Watch the containing directory rather than the file itself: an atomic save
    // (ours or an external editor's) replaces the file, which silently kills a
    // watcher bound to the old file.
    const directory = path.dirname(this.file);
    try {
      this.watching = fs.watch(directory, (_event: string, filename: string | Buffer | null) => {
        if (filename !== null && filename !== undefined && !this.matchesFile(filename)) {
          return;
        }
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

  /** Coalesces the multiple events most platforms emit for a single write. */
  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.handleChange();
    }, this.debounceDelay);

    if (typeof (this.debounceTimer as any)?.unref === "function") {
      (this.debounceTimer as any).unref();
    }
  }

  private async handleChange(): Promise<void> {
    try {
      for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt++) {
        // Re-checked every attempt: unwatch() may have been called, or a save may have
        // made the file ours, while this loop was waiting.
        if (!this.watching || this.isOwnLastWrite()) {
          return;
        }

        let contents: string | null;
        try {
          contents = this.readFileContents();
        } catch (error) {
          if (attempt === READ_MAX_ATTEMPTS - 1) {
            this.emitEvent("error", new Error(`Failed to read file after ${READ_MAX_ATTEMPTS} attempts: ${error}`));
            return;
          }
          await delay(READ_RETRY_DELAY);
          continue;
        }

        if (contents === null) {
          // Too large to read; already reported.
          return;
        }

        // The file is the source of truth: adopting it discards unsaved in-memory edits,
        // which is the point of a cache that follows the file.
        const parsed = this.parseContents(contents);
        if (!this.watching || !parsed) {
          // A rejected parse leaves the cache as it was, so there is no change to report;
          // the failure has already gone out as an error.
          return;
        }
        this.emitEvent("change", this.baseName);
        return;
      }
    } catch (error) {
      // Nothing may escape here: this runs detached from any caller, so an exception
      // would surface as an unhandled rejection and terminate the process.
      this.emitEvent("error", error);
    }
  }

  unwatch() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.watching) {
      return;
    }
    if (typeof this.watching.close === "function") {
      this.watching.close();
    }
    this.watching = null;
  }
}
