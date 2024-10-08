export default class IniFileCache {
    private readonly cachePath;
    private readonly fileName;
    private file;
    private settings;
    private watching;
    private _listener;
    constructor(cachePath: string, fileName: string);
    get listener(): any;
    parseContents(contents: string): void;
    cacheFileSettings(): void;
    getSetting(section: string, key: string, defaultValue?: string): string | null;
    setSetting(section: string, key: string, value: string): void;
    getSections(): string[];
    getKeys(section: string): string[];
    hasSection(section: string): boolean;
    hasKey(section: string, key: string): boolean;
    removeSection(section: string): void;
    removeKey(section: string, key: string): void;
    reload(): void;
    save(): void;
    watch(): void;
    unwatch(): void;
}
