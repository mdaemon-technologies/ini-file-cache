import * as path from "path";
import { IniDocument } from "./internal/document";
import { EventChannel, toError } from "./internal/events";
import {
  BYTE_ORDER_MARK,
  IIniLayout,
  parseIni,
  sanitizeKey,
  sanitizeSection,
  sanitizeValue,
  serializeIni,
} from "./internal/format";
import {
  acquireLock,
  delay,
  ensureFile,
  IFileSignature,
  IReadResult,
  readBounded,
  readSignature,
  releaseLock,
  resolveTarget,
  writeAtomic,
} from "./internal/fileIO";
import { IResolvedOptions, requireString, resolveOptions } from "./internal/options";
import { DirectoryWatcher } from "./internal/watcher";

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

const READ_MAX_ATTEMPTS = 20;
const READ_RETRY_DELAY = 100;

const TRUE_VALUES = /^(?:t|true|y|yes|on|1)$/i;
const FALSE_VALUES = /^(?:f|false|n|no|off|0)$/i;
const INTEGER_VALUE = /^[+-]?\d+$/;

export default class IniFileCache {
  private readonly file: string;
  private readonly baseName: string;
  private readonly options: IResolvedOptions;
  private readonly events: EventChannel;
  private readonly watcher: DirectoryWatcher;
  private document: IniDocument;
  private layout: IIniLayout;
  // The signature of this instance's last write, so the watcher can tell it from someone else's.
  private lastWrite: IFileSignature | null;
  // True when the last read could not be decoded losslessly, so writing it back would
  // change bytes the library never touched.
  private lossyRead: boolean;
  // False until the file has been parsed successfully at least once. Saving before that
  // would write an empty cache over a file whose contents were never understood.
  private loaded: boolean;

  constructor(cachePath: string, fileName: string, options: IIniFileCacheOptions = {}) {
    requireString(cachePath, "cachePath");
    requireString(fileName, "fileName");
    this.options = resolveOptions(options);

    // Events raised while the constructor runs are deferred until open(), so a listener
    // attached immediately after construction still sees them.
    this.events = new EventChannel();
    this.document = new IniDocument(this.options.caseInsensitive);
    this.layout = { byteOrderMark: null, endOfLine: "\n", namelessHasHeader: false };
    this.lastWrite = null;
    this.lossyRead = false;
    this.loaded = false;

    this.file = resolveTarget(cachePath, fileName, this.options.restrictToCachePath);
    this.baseName = path.basename(this.file);
    const directory = path.dirname(this.file);
    ensureFile(this.file, directory);

    this.watcher = new DirectoryWatcher(this.file, this.options.debounceDelay, {
      onChange: () => void this.handleChange(),
      onError: (error) => this.fail(error),
      onClose: () => this.events.emit("close"),
      onDirectoryMissing: () =>
        this.fail(new Error(`Stopped watching ${this.file}: ${directory} no longer exists`)),
    });

    this.loadSync();
    this.watch();
    this.events.open();
  }

  get listener(): IIniFileCacheListener {
    return this.events.emitter;
  }

  /**
   * Reports a refusal or failure as an `error` event. Every error goes out through here.
   * Returns false so that a method resolving false can `return this.fail(...)`.
   */
  private fail(error: unknown): false {
    this.events.emit("error", toError(error));
    return false;
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
      return this.fail(new TypeError("contents must be a string"));
    }

    const parsed = parseIni(contents, this.options.caseInsensitive);
    if (parsed === null) {
      // Leave the cached settings alone, because the next save() would otherwise write
      // that damage back to disk.
      return this.fail(new Error("Invalid ini file format"));
    }

    // A file read hands its mark over as bytes, and content handed in directly keeps
    // whatever mark the cache already had. A U+FEFF that survived into the text is encoded
    // with this file's encoding, so UTF-16 keeps FF FE rather than being handed UTF-8's
    // EF BB BF.
    let byteOrderMark = source ? source.byteOrderMark : this.layout.byteOrderMark;
    if (parsed.byteOrderMark) {
      byteOrderMark = Buffer.from(BYTE_ORDER_MARK, this.options.encoding);
    }

    this.loaded = true;
    // Set here rather than at the read, so it describes the content the cache actually
    // holds. Content handed in directly replaces every byte that came from the file, so
    // there is nothing left for the refusal to protect.
    this.lossyRead = source !== null && source.lossy;
    this.layout = {
      byteOrderMark,
      // Match the file's existing line endings. Content with no line break at all leaves
      // the current choice alone, so an empty file keeps the default.
      endOfLine: parsed.endOfLine ?? this.layout.endOfLine,
      namelessHasHeader: parsed.namelessHasHeader,
    };
    this.document = parsed.document;
    return true;
  }

  /**
   * Reads the file, refusing anything larger than maxFileSize. Throws on read errors.
   * Resolves null when the read was refused, having emitted why.
   */
  private readFileContents(): IReadResult | null {
    const read = readBounded(this.file, this.options.maxFileSize, this.options.encoding);
    if ("tooLarge" in read) {
      const limit = this.options.maxFileSize;
      this.fail(new Error(`${this.file} is ${read.size} bytes, which exceeds the maximum of ${limit} bytes`));
      return null;
    }
    if (read.lossy) {
      // Still returned: the content is readable, and the refusal comes at save().
      this.fail(
        new Error(
          `${this.file} is not valid ${this.options.encoding}; saving would corrupt it. ` +
            `Construct with { encoding: "latin1" } if it uses a legacy single-byte encoding.`
        )
      );
    }
    return read;
  }

  /** Single-attempt synchronous load, used during construction. */
  private loadSync(): void {
    try {
      const read = this.readFileContents();
      if (read !== null) {
        this.parse(read.contents, read);
      }
    } catch (error) {
      this.fail(new Error(`Failed to read file: ${error}`));
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
          this.fail(new Error(`Failed to read file after ${READ_MAX_ATTEMPTS} attempts: ${error}`));
          // The usual cause of an unreadable file is a deleted one, and the directory may
          // have gone with it. Other platforms simply stop delivering watch events in that
          // case, so this is where a dead watcher is noticed there.
          this.watcher.stopIfDirectoryMissing();
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
    return this.document.get(section, key) ?? defaultValue;
  }

  getBool(section: string, key: string, defaultValue: boolean = false): boolean {
    const value = this.getSetting(section, key);
    if (value === null) {
      return defaultValue;
    }

    // Already trimmed, both by the parser and by setSetting. An empty value matches
    // neither pattern and so falls through to the default.
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
    // An empty value fails the pattern, like any other non-integer.
    if (value === null || !INTEGER_VALUE.test(value)) {
      return defaultValue;
    }

    const intValue = Number(value);
    if (!Number.isSafeInteger(intValue)) {
      return defaultValue;
    }

    return intValue;
  }

  setSetting(section: string, key: string, value: string): void {
    // Validated in argument order, so the first bad argument is the one reported.
    const sectionName = sanitizeSection(section);
    const settingKey = sanitizeKey(key);
    this.document.set(sectionName, settingKey, sanitizeValue(value));
  }

  getSections(): string[] {
    return this.document.sectionNames();
  }

  getKeys(section: string): string[] {
    return this.document.keys(section);
  }

  hasSection(section: string): boolean {
    return this.document.hasSection(section);
  }

  hasKey(section: string, key: string): boolean {
    return this.document.hasKey(section, key);
  }

  removeSection(section: string): void {
    this.document.removeSection(section);
  }

  removeKey(section: string, key: string): void {
    this.document.removeKey(section, key);
  }

  /** Resolves true when the file was re-read and parsed; false when it was not. */
  async reload(): Promise<boolean> {
    if (!(await this.cacheFileSettings())) {
      // The cache still holds what it held before, so there is nothing to announce; the
      // failure has already gone out as an error.
      return false;
    }
    this.events.emit("reload", this.file);
    return true;
  }

  /** The bytes a save writes: the cache as ini text, in the file's encoding and layout. */
  private render(): Buffer {
    const body = Buffer.from(serializeIni(this.document, this.layout), this.options.encoding);
    // Exactly the bytes the file had, so a UTF-16 file keeps FF FE and a UTF-8 one keeps
    // EF BB BF instead of both being given whichever the code happened to hard-code.
    const mark = this.layout.byteOrderMark;
    return mark ? Buffer.concat([mark, body]) : body;
  }

  async save(): Promise<boolean> {
    if (!this.loaded) {
      // The cache is empty because the file has never parsed, not because it has no
      // settings. Writing now would replace a file we never understood with nothing.
      return this.fail(new Error(`Refusing to save ${this.file}: its contents have never been parsed successfully.`));
    }

    if (this.lossyRead) {
      return this.fail(
        new Error(
          `Refusing to save ${this.file}: it could not be decoded as ${this.options.encoding} without loss, ` +
            `so writing it back would corrupt bytes this library did not touch.`
        )
      );
    }

    const lock = await acquireLock(this.file);
    if (!lock.token) {
      const reason = lock.error ? `: ${lock.error}` : " (timed out waiting for another writer)";
      return this.fail(new Error(`Failed to acquire the lock for ${this.file}${reason}`));
    }

    let failure: unknown = null;
    try {
      // Rendered only now that the lock is held. Acquiring it can wait seconds, and the
      // watcher may adopt an external change during that wait; rendering earlier would
      // write settings the cache no longer holds and leave the two permanently divergent,
      // because the resulting change event is then suppressed as our own write.
      await writeAtomic(this.file, this.render());
      // Remember what we wrote so the watcher can tell our own change from someone else's.
      this.lastWrite = readSignature(this.file);
    } catch (error) {
      failure = error;
    } finally {
      releaseLock(this.file, lock.token);
    }

    // Emitted outside the try so that a throwing listener cannot be mistaken for a
    // failed write.
    if (failure !== null) {
      return this.fail(failure);
    }
    this.events.emit("save", this.file);
    return true;
  }

  /** True when the file on disk is still exactly what this instance last wrote. */
  private isOwnLastWrite(): boolean {
    if (!this.lastWrite) {
      return false;
    }
    const current = readSignature(this.file);
    return current !== null && current.size === this.lastWrite.size && current.mtimeMs === this.lastWrite.mtimeMs;
  }

  /** True while a watcher is active on the file. */
  isWatching(): boolean {
    return this.watcher.active;
  }

  watch(): void {
    try {
      this.watcher.start();
    } catch (error) {
      this.fail(new Error(`Failed to watch file: ${error}`));
    }
  }

  private async handleChange(): Promise<void> {
    try {
      // The guard is re-checked before every attempt: unwatch() may have been called, or a
      // save may have made the file ours, while the read was waiting to be retried.
      const read = await this.readWithRetries(() => this.watcher.active && !this.isOwnLastWrite());
      if (read === null) {
        return;
      }

      // The file is the source of truth: adopting it discards unsaved in-memory edits,
      // which is the point of a cache that follows the file.
      const parsed = this.parse(read.contents, read);
      if (!this.watcher.active || !parsed) {
        // A rejected parse leaves the cache as it was, so there is no change to report;
        // the failure has already gone out as an error.
        return;
      }
      this.events.emit("change", this.baseName);
    } catch (error) {
      // Nothing may escape here: this runs detached from any caller, so an exception
      // would surface as an unhandled rejection and terminate the process.
      this.fail(error);
    }
  }

  unwatch(): void {
    this.watcher.stop();
  }
}
