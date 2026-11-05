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
export default class IniFileCache {
    private readonly file;
    private readonly baseName;
    private readonly options;
    private readonly events;
    private readonly watcher;
    private document;
    private layout;
    private lastWrite;
    private lossyRead;
    private loaded;
    constructor(cachePath: string, fileName: string, options?: IIniFileCacheOptions);
    get listener(): IIniFileCacheListener;
    /**
     * Reports a refusal or failure as an `error` event. Every error goes out through here.
     * Returns false so that a method resolving false can `return this.fail(...)`.
     */
    private fail;
    /** Resolves to true when the content parsed; false when it was rejected and `error` was emitted. */
    parseContents(contents: string): boolean;
    /**
     * Replaces the cache with `contents`. `source` is the read it came from, or null when a
     * caller supplied it directly — which is what decides whether a lossy decode still
     * describes what the cache holds.
     */
    private parse;
    /**
     * Reads the file, refusing anything larger than maxFileSize. Throws on read errors.
     * Resolves null when the read was refused, having emitted why.
     */
    private readFileContents;
    /** Single-attempt synchronous load, used during construction. */
    private loadSync;
    /**
     * Reads with retries, because a file being replaced is briefly unreadable. `guard` is
     * re-checked before every attempt and abandons the read silently when it returns false.
     * Resolves null when there is nothing to parse, having already emitted the reason.
     */
    private readWithRetries;
    /** Resolves true when the file was read; false when it could not be and `error` was emitted. */
    cacheFileSettings(): Promise<boolean>;
    getSetting(section: string, key: string, defaultValue?: string | null): string | null;
    getBool(section: string, key: string, defaultValue?: boolean): boolean;
    getInt(section: string, key: string, defaultValue?: number): number;
    setSetting(section: string, key: string, value: string): void;
    getSections(): string[];
    getKeys(section: string): string[];
    hasSection(section: string): boolean;
    hasKey(section: string, key: string): boolean;
    removeSection(section: string): void;
    removeKey(section: string, key: string): void;
    /** Resolves true when the file was re-read and parsed; false when it was not. */
    reload(): Promise<boolean>;
    /** The bytes a save writes: the cache as ini text, in the file's encoding and layout. */
    private render;
    save(): Promise<boolean>;
    /** True when the file on disk is still exactly what this instance last wrote. */
    private isOwnLastWrite;
    /** True while a watcher is active on the file. */
    isWatching(): boolean;
    watch(): void;
    private handleChange;
    unwatch(): void;
}
