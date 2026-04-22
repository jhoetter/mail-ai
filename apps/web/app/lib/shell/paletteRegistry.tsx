// Registry context owned by AppShell. Children hook into it via
// useRegisterPaletteCommands(commands) to contribute scoped commands;
// commands automatically unmount with the component, which means the
// palette's "Reply" entry only exists while a ThreadView is mounted.
//
// Static (always-on) commands are passed in as `staticCommands` to
// AppShell. Page-scoped commands stack on top via the same registry.
//
// Implementation notes:
// - The internal registry object is identity-stable for the lifetime
//   of the provider. Mutations live in refs; subscribers are notified
//   via a tiny pub-sub. This is the contract `useRegisterPaletteCommands`
//   relies on — its effect must NOT re-fire when scoped commands change
//   or when the palette opens/closes (that would loop forever).
// - The public `usePaletteRegistry()` hook returns a snapshot that
//   bundles `isOpen` so consumers re-render when the palette toggles.
//   Don't pass that snapshot into a hook dep array — pull individual
//   methods (e.g. `reg.register`) instead.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PaletteCommand, PaletteRegistry } from "./types";

interface InternalRegistry {
  register(commands: readonly PaletteCommand[]): () => void;
  list(): readonly PaletteCommand[];
  open(): void;
  close(): void;
  toggle(): void;
  subscribe(cb: () => void): () => void;
  getIsOpen(): boolean;
}

const InternalRegistryContext = createContext<InternalRegistry | null>(null);

export interface PaletteRegistryProviderProps {
  readonly children: ReactNode;
  readonly staticCommands: readonly PaletteCommand[];
}

export function PaletteRegistryProvider({
  children,
  staticCommands,
}: PaletteRegistryProviderProps) {
  // All reactive state lives in refs so the InternalRegistry object
  // we expose via context never changes identity.
  const scopedRef = useRef<Map<number, readonly PaletteCommand[]>>(new Map());
  const tokenRef = useRef(0);
  const isOpenRef = useRef(false);
  const staticRef = useRef(staticCommands);
  const subscribersRef = useRef<Set<() => void>>(new Set());

  // Keep the latest staticCommands in the ref so list() returns fresh
  // data on the next render. Notify subscribers so the open palette
  // refreshes when locale / theme rebuilds the static set.
  staticRef.current = staticCommands;
  useEffect(() => {
    for (const cb of subscribersRef.current) cb();
  }, [staticCommands]);

  // Only created once. Methods close over the refs above, so they
  // always see fresh state without ever changing identity.
  const internal = useMemo<InternalRegistry>(() => {
    const notify = () => {
      for (const cb of subscribersRef.current) cb();
    };
    return {
      register(commands) {
        const token = ++tokenRef.current;
        scopedRef.current.set(token, commands);
        notify();
        return () => {
          scopedRef.current.delete(token);
          notify();
        };
      },
      list() {
        const out: PaletteCommand[] = [...staticRef.current];
        for (const arr of scopedRef.current.values()) out.push(...arr);
        // Last writer wins for duplicate ids — gives pages a clean
        // way to override a static command's hint or run.
        const seen = new Map<string, PaletteCommand>();
        for (const c of out) seen.set(c.id, c);
        return [...seen.values()];
      },
      open() {
        if (isOpenRef.current) return;
        isOpenRef.current = true;
        notify();
      },
      close() {
        if (!isOpenRef.current) return;
        isOpenRef.current = false;
        notify();
      },
      toggle() {
        isOpenRef.current = !isOpenRef.current;
        notify();
      },
      subscribe(cb) {
        subscribersRef.current.add(cb);
        return () => {
          subscribersRef.current.delete(cb);
        };
      },
      getIsOpen() {
        return isOpenRef.current;
      },
    };
  }, []);

  return (
    <InternalRegistryContext.Provider value={internal}>
      {children}
    </InternalRegistryContext.Provider>
  );
}

function useInternalRegistry(): InternalRegistry {
  const r = useContext(InternalRegistryContext);
  if (!r) {
    throw new Error("usePaletteRegistry: AppShell missing in tree");
  }
  return r;
}

// Public hook. Subscribes to registry changes so isOpen + scoped
// command updates trigger a re-render. The returned object is a fresh
// snapshot per render — DO NOT include it whole in another hook's
// dependency array (that would re-fire on every notify). Pull out the
// methods you need instead, or use useRegisterPaletteCommands().
export function usePaletteRegistry(): PaletteRegistry {
  const r = useInternalRegistry();
  const [, force] = useState(0);
  useEffect(() => r.subscribe(() => force((n) => n + 1)), [r]);
  return useMemo<PaletteRegistry>(
    () => ({
      list: r.list,
      register: r.register,
      open: r.open,
      close: r.close,
      toggle: r.toggle,
      isOpen: r.getIsOpen(),
    }),
    // Recompute on every tick (force update) so isOpen reads fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, r.getIsOpen()],
  );
}

// Mount a list of scoped palette commands. Re-runs only when the
// `commands` reference changes — callers should memoize their array
// to avoid thrashing the registry on every render.
//
// We pull `register` straight off the stable internal context so
// this effect is NOT sensitive to isOpen toggles or other notifies.
export function useRegisterPaletteCommands(commands: readonly PaletteCommand[]): void {
  const r = useContext(InternalRegistryContext);
  useEffect(() => {
    if (!r) return;
    return r.register(commands);
  }, [r, commands]);
}
