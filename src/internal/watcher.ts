import * as fs from "fs";
import * as path from "path";
import { filesystemCase } from "./fileIO";

/** What a DirectoryWatcher reports. It never emits events itself; its owner decides. */
export interface IWatcherHandlers {
  /** The file changed, once a burst of events has settled. */
  onChange(): void;
  /** The underlying watcher failed. */
  onError(error: Error): void;
  /** The underlying watcher closed, for whatever reason. */
  onClose(): void;
  /** Watching stopped because the directory no longer exists. */
  onDirectoryMissing(): void;
}

// Unmatched watch events tolerated before checking that the directory is still there.
// A deleted watch directory produces an unbounded stream of them on Windows.
const UNMATCHED_EVENTS_BEFORE_CHECK = 500;

// Multiple of the debounce delay after which a change is reported even though events are
// still arriving. Without a cap, a file written faster than the delay restarts the timer
// forever and is never adopted at all.
const DEBOUNCE_MAX_WAIT_FACTOR = 10;

/**
 * Watches one file by watching its directory, and reports changes to it coalesced.
 *
 * The directory rather than the file: an atomic save (ours or an external editor's)
 * replaces the file, which silently kills a watcher bound to the old one.
 */
export class DirectoryWatcher {
  private watcher: fs.FSWatcher | null = null;
  // Consecutive watch events that named something other than the watched file.
  private unmatchedEvents = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // When the current burst of change events began, for the maximum-wait cap.
  private debounceStartedAt: number | null = null;
  private readonly directory: string;
  private readonly baseName: string;

  constructor(
    file: string,
    private readonly debounceDelay: number,
    private readonly handlers: IWatcherHandlers
  ) {
    this.directory = path.dirname(file);
    this.baseName = path.basename(file);
  }

  /** True while a watcher is open. */
  get active(): boolean {
    return this.watcher !== null;
  }

  /** Starts watching, unless already watching. Throws when the watcher cannot be opened. */
  start(): void {
    if (this.watcher) {
      return;
    }
    this.unmatchedEvents = 0;
    const watcher = fs.watch(this.directory, (_event: string, filename: string | Buffer | null) => {
      if (filename !== null && filename !== undefined && !this.matchesFile(filename)) {
        // Deleting the watched directory makes Windows deliver events naming the directory
        // itself, without end and without ever reporting an error or a close. None of them
        // match, so nothing reloads, but the callback would run tens of thousands of times
        // a second for the life of the process. Checking every so often costs one stat per
        // burst and nothing at all on a quiet directory.
        if (++this.unmatchedEvents >= UNMATCHED_EVENTS_BEFORE_CHECK) {
          this.unmatchedEvents = 0;
          this.stopIfDirectoryMissing();
        }
        return;
      }
      this.unmatchedEvents = 0;
      this.schedule();
    });
    this.watcher = watcher;
    watcher.on("error", (error: Error) => this.handlers.onError(error));
    watcher.once("close", () => this.handlers.onClose());
  }

  /** Stops watching and drops any change still waiting out its debounce. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceStartedAt = null;
    if (!this.watcher) {
      return;
    }
    this.watcher.close();
    this.watcher = null;
  }

  /**
   * Stops a watcher whose directory has been removed, since it can never deliver another
   * usable event: the handle refers to an inode that is gone, and recreating the directory
   * does not re-attach it. Leaving it open would report a watcher that cannot work, and
   * stop start() from establishing a new one.
   */
  stopIfDirectoryMissing(): void {
    if (!this.watcher || fs.existsSync(this.directory)) {
      return;
    }
    this.stop();
    this.handlers.onDirectoryMissing();
  }

  private matchesFile(filename: string | Buffer): boolean {
    const name = path.basename(typeof filename === "string" ? filename : filename.toString());
    return filesystemCase(name) === filesystemCase(this.baseName);
  }

  /**
   * Coalesces the multiple events most platforms emit for a single write, but only up to
   * DEBOUNCE_MAX_WAIT_FACTOR times the delay: a file being rewritten faster than the delay
   * would otherwise restart the timer indefinitely and never be adopted at all.
   */
  private schedule(): void {
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
      this.handlers.onChange();
    }, wait);
    // A pending change must not keep the process alive on its own.
    this.debounceTimer.unref();
  }
}
