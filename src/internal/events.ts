import Emitter from "@mdaemon/emitter";

/** Every event this library emits. Named so that a typo cannot compile into silence. */
export type IniEvent = "change" | "reload" | "save" | "error" | "close";

/**
 * The `error` event is declared as carrying an Error, so anything thrown that is not one
 * is wrapped rather than passed through and quietly breaking that contract.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Sends the library's events. Events sent before open() are deferred, so a listener
 * attached immediately after construction still sees errors raised while it ran, and a
 * listener's exception never escapes into library control flow.
 */
export class EventChannel {
  readonly emitter: Emitter;
  private ready = false;

  constructor() {
    // The emitter catches a handler's exception and reports it here rather than letting it
    // propagate out of emit(), so this hook — not a try/catch around emit — is what keeps a
    // throwing listener from escaping into library control flow. Supplying it also replaces
    // the emitter's default hook, which writes the exception to the console.
    this.emitter = new Emitter({
      onError: (error: unknown, event: string) => this.reportListenerError(error, event),
    });
  }

  /** Construction has finished: from now on events are dispatched immediately. */
  open(): void {
    this.ready = true;
  }

  emit(event: IniEvent, payload?: unknown): void {
    if (!this.ready) {
      // Dispatched directly rather than re-entering this check: if the constructor threw
      // before calling open(), re-checking would reschedule itself forever.
      setImmediate(() => this.dispatch(event, payload));
      return;
    }
    this.dispatch(event, payload);
  }

  private dispatch(event: IniEvent, payload?: unknown): void {
    try {
      this.emitter.emit(event, payload);
    } catch (error) {
      // The emitter hands a handler's exception to the onError hook installed in the
      // constructor rather than letting it escape, so this catches only a failure of emit
      // itself.
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
      this.emitter.emit("error", toError(error));
    } catch {
      // The error listener threw as well; there is nowhere left to report this.
    }
  }
}
