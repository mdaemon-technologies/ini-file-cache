import type { IIniFileCacheOptions } from "../iniFileCache";

/** The constructor's options, validated and with every default applied. */
export interface IResolvedOptions {
  readonly maxFileSize: number;
  readonly caseInsensitive: boolean;
  readonly debounceDelay: number;
  readonly restrictToCachePath: boolean;
  readonly encoding: BufferEncoding;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_DEBOUNCE_DELAY = 50;

export function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
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

/** Validates the options, throwing TypeError on the first one that is wrong. */
export function resolveOptions(options: IIniFileCacheOptions): IResolvedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  if (options.encoding !== undefined && !Buffer.isEncoding(options.encoding)) {
    throw new TypeError(`encoding "${options.encoding}" is not a supported buffer encoding`);
  }
  return {
    maxFileSize: numberOption(options.maxFileSize, "maxFileSize", DEFAULT_MAX_FILE_SIZE, 1),
    caseInsensitive: booleanOption(options.caseInsensitive, "caseInsensitive"),
    debounceDelay: numberOption(options.debounceDelay, "debounceDelay", DEFAULT_DEBOUNCE_DELAY, 0),
    restrictToCachePath: booleanOption(options.restrictToCachePath, "restrictToCachePath"),
    encoding: options.encoding ?? "utf8",
  };
}
