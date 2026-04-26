import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface HostChromeBreadcrumb {
  label: string;
  href?: string;
}

export interface HostChromeState {
  title: string;
  breadcrumbs?: HostChromeBreadcrumb[];
  actions?: ReactNode;
  actionsSyncKey?: string;
}

const HostChromeStateContext = createContext<HostChromeState | null>(null);
const HostChromeSetterContext = createContext<((next: HostChromeState | null) => void) | null>(
  null,
);

export function HostChromeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HostChromeState | null>(null);
  const value = useMemo(() => state, [state]);
  return (
    <HostChromeSetterContext.Provider value={setState}>
      <HostChromeStateContext.Provider value={value}>{children}</HostChromeStateContext.Provider>
    </HostChromeSetterContext.Provider>
  );
}

export function useHostChromeState(): HostChromeState | null {
  return useContext(HostChromeStateContext);
}

export function useMailHostChrome(next: HostChromeState): void {
  const setState = useContext(HostChromeSetterContext);
  useEffect(() => {
    if (!setState) return;
    setState(next);
    return () => setState(null);
  }, [next, setState]);
}
