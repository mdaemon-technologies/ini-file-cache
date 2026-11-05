import * as fs from "fs";
import * as path from "path";

// Imported as a namespace, as everywhere in this library, so a test that patches a function
// on the CommonJS `fs` object reaches this module after module.syncBuiltinESMExports().

export interface ILockResult {
  token: string | null;
  error?: unknown;
}

export interface IFileSignature {
  size: number;
  mtimeMs: number;
}

/**
 * What a read of the file established. Returned rather than stashed on the instance so
 * that the parse which consumes it takes it as an argument: a field would make every
 * caller's correctness depend on the two calls staying adjacent.
 */
export interface IReadResult {
  contents: string;
  /** The exact bytes found, so a save reproduces them under any encoding. */
  byteOrderMark: Buffer | null;
  /** The decode did not round-trip, so writing it back would change untouched bytes. */
  lossy: boolean;
}

/** A read refused because the file is larger than the limit; `size` is what was found. */
export interface ITooLarge {
  tooLarge: true;
  size: number;
}

const LOCK_MAX_ATTEMPTS = 20;
const LOCK_RETRY_DELAY = 100;
const LOCK_STALE_MS = 10000;

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
const FILESYSTEM_CASE_INSENSITIVE = CASE_INSENSITIVE_PLATFORMS.includes(process.platform);

// U+FEFF, written as the three-byte UTF-8 sequence EF BB BF.
const BYTE_ORDER_MARK_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

let lockCounter = 0;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(file: string): string {
  return `${file}.lck`;
}

function tempPath(file: string): string {
  return `${file}.tmp`;
}

/** Folds a path or file name the way the filesystem compares them. */
export function filesystemCase(name: string): string {
  return FILESYSTEM_CASE_INSENSITIVE ? name.toLowerCase() : name;
}

/** Best-effort removal, for cleanup whose failure leaves nothing further to try. */
function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or not ours to remove.
  }
}

/** Best-effort close, for cleanup whose failure leaves nothing further to try. */
function tryClose(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch {
    // Nothing useful to do if the descriptor is already gone.
  }
}

/**
 * Creates the lock file for `file` with an exclusive open, so two processes can never
 * believe they hold it at the same time. Locks older than LOCK_STALE_MS are treated as
 * abandoned and removed. Resolves with the token written into the lock, or a null token
 * and the underlying cause; callers must not write the file without a token.
 */
export async function acquireLock(file: string): Promise<ILockResult> {
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
        tryClose(descriptor);
        descriptor = null;
      }
      if (error?.code !== "EEXIST") {
        if (created) {
          // Ours: created, but not stamped with our token, so it would block every writer
          // until it aged out. Take it back out. A failure to open says nothing about who
          // owns an existing lock — a descriptor limit or a permission error while another
          // writer legitimately holds it must not remove theirs.
          tryUnlink(lock);
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
export function releaseLock(file: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath(file), "utf8") === token) {
      fs.unlinkSync(lockPath(file));
    }
  } catch {
    // Already gone, or unreadable; either way there is nothing of ours to remove.
  }
}

/**
 * Renames `from` over `to`, retrying while Windows refuses because another process holds
 * `to` open. Resolves false when it never could, so the caller can fall back to writing in
 * place; any other failure is thrown.
 */
async function renameWithRetries(from: string, to: string): Promise<boolean> {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error: any) {
      if (!RENAME_FALLBACK_CODES.includes(error?.code)) {
        throw error;
      }
      if (attempt < RENAME_MAX_ATTEMPTS - 1) {
        await delay(RENAME_RETRY_DELAY);
      }
    }
  }
  return false;
}

/**
 * Resolves fileName against cachePath. A fileName may reach outside cachePath with "..":
 * both arguments come from the caller, who can point anywhere via cachePath regardless, so
 * there is no boundary here to enforce by default. Callers passing an untrusted fileName
 * opt in with restrictToCachePath.
 */
export function resolveTarget(cachePath: string, fileName: string, restrict: boolean): string {
  const root = path.resolve(cachePath);
  const resolved = path.resolve(root, fileName);
  if (!restrict) {
    return resolved;
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  // Compare the way the filesystem does, so an absolute fileName that differs only in case
  // is not rejected as though it were outside.
  if (!filesystemCase(resolved).startsWith(filesystemCase(prefix))) {
    throw new Error(`fileName "${fileName}" resolves outside of the cache path`);
  }
  return resolved;
}

/** Creates the directory and an empty file, adopting either if it is already there. */
export function ensureFile(file: string, directory: string): void {
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

/**
 * Reads and decodes the file, refusing anything larger than `maxSize`. Throws on read
 * errors. A lossy decode is still returned, flagged, so the caller can decide what it means.
 */
export function readBounded(file: string, maxSize: number, encoding: BufferEncoding): IReadResult | ITooLarge {
  // Measured and read through one descriptor. Stat-then-read by path lets a file that grows
  // in between be read in full, which is the size limit failing exactly when it is needed:
  // against a file that is being written to right now.
  const descriptor = fs.openSync(file, "r");
  let raw: Buffer;
  try {
    const stats = fs.fstatSync(descriptor);
    if (stats.size > maxSize) {
      return { tooLarge: true, size: stats.size };
    }
    raw = fs.readFileSync(descriptor);
    if (raw.length > maxSize) {
      // The file grew while it was being read. Reading to the end of the descriptor is what
      // keeps the content consistent, so the limit is enforced again on the result rather
      // than by truncating it into a half file that would parse as a whole one.
      return { tooLarge: true, size: raw.length };
    }
  } finally {
    fs.closeSync(descriptor);
  }

  // Strip the byte order mark before decoding rather than after. Under a single-byte
  // encoding it would otherwise decode to three stray characters glued to the first line,
  // which swallows a leading section header.
  const hasByteOrderMark = raw.subarray(0, 3).equals(BYTE_ORDER_MARK_BYTES);
  const buffer = hasByteOrderMark ? raw.subarray(3) : raw;
  const contents = buffer.toString(encoding);

  // Decoding a legacy single-byte file as UTF-8 turns every high byte into U+FFFD. Writing
  // that back would replace bytes this library never touched, so detect it by re-encoding.
  const lossy = !Buffer.from(contents, encoding).equals(buffer);

  // The mark travels as bytes rather than as a character, so the exact one that was found
  // is the one written back.
  return { contents, byteOrderMark: hasByteOrderMark ? BYTE_ORDER_MARK_BYTES : null, lossy };
}

/**
 * Publishes `bytes` to the file. The rename makes the replacement atomic, so a concurrent
 * reader never sees a partial file. Windows refuses to rename over a file another process
 * holds open, so after a few attempts this falls back to writing in place, which that
 * platform does allow. The fallback is not atomic, but a save that silently fails is worse
 * than one that is briefly observable mid-write.
 */
export async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  // Renaming over a symbolic link replaces the link itself. Write through it instead, so the
  // file the caller actually pointed at is the one that changes.
  let isSymbolicLink = false;
  try {
    isSymbolicLink = fs.lstatSync(file).isSymbolicLink();
  } catch {
    // The file may not exist yet; treat it as a regular file.
  }
  if (isSymbolicLink) {
    fs.writeFileSync(file, bytes, WRITE_OPTIONS);
    return;
  }

  const temp = tempPath(file);
  let renamed = false;
  try {
    fs.writeFileSync(temp, bytes, WRITE_OPTIONS);
    renamed = await renameWithRetries(temp, file);
    if (!renamed) {
      fs.writeFileSync(file, bytes, WRITE_OPTIONS);
    }
  } finally {
    // A successful rename consumed the temporary file; any other outcome leaves it behind.
    if (!renamed) {
      tryUnlink(temp);
    }
  }
}

export function readSignature(file: string): IFileSignature | null {
  try {
    const stats = fs.statSync(file);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}
