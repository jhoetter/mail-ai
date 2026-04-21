// MailAiApp: the single embeddable component. Hosts pass in
// `MailAiHostHooks` for auth, navigation, and theming; we render the
// Inbox shell into the host's React tree. Sub-components are NOT
// exported — the host owns the chrome, the embed owns the mail body.

import { useMemo } from "react";
import { Inbox } from "./components/inbox.js";
import type { MailaiHostHooks } from "./contract.js";

export interface MailAiAppProps {
  readonly hooks: MailaiHostHooks;
  readonly initialThreadId?: string;
}

export function MailAiApp(props: MailAiAppProps) {
  const ctx = useMemo(() => ({ hooks: props.hooks }), [props.hooks]);
  return (
    <MailAiHostContext.Provider value={ctx}>
      <Inbox />
    </MailAiHostContext.Provider>
  );
}

import { createContext, useContext } from "react";

interface HostContext {
  readonly hooks: MailaiHostHooks;
}

const MailAiHostContext = createContext<HostContext | null>(null);

export function useMailAiHost(): HostContext {
  const ctx = useContext(MailAiHostContext);
  if (!ctx) throw new Error("useMailAiHost must be used inside <MailAiApp>");
  return ctx;
}
