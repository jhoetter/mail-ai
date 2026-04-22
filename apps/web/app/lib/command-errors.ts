// Tiny browser-side event channel for "a command we just dispatched
// came back failed". Used by the global <CommandErrorToast/> mounted
// in the root layout so any place in the UI that dispatches a command
// (star, snooze, mark-done, …) gets a visible toast on failure
// without each call site having to thread an error setter through.
//
// Intentionally minimal — no external deps, no toast library. We have
// at most one toast on screen at a time, which is the right shape for
// a transient "couldn't save" surface.

export interface CommandError {
  readonly commandType: string;
  readonly code: string;
  readonly message: string;
}

type Listener = (err: CommandError) => void;

const listeners = new Set<Listener>();

export function publishCommandError(err: CommandError): void {
  for (const l of listeners) {
    try {
      l(err);
    } catch {
      // A subscriber that throws shouldn't take the others down with
      // it — surfaces are best-effort.
    }
  }
}

export function subscribeCommandErrors(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
