// Hook that orchestrates a single OAuth connect attempt:
//   click → fetch session token → open Nango Connect UI →
//   wait for `connect` event → finalize on our backend → done.
//
// Exposes a state machine the dialog can render (`idle` | `starting`
// | `awaiting-user` | `finalizing` | `success` | `error`).

"use client";

import { useCallback, useRef, useState } from "react";
import Nango from "@nangohq/frontend";
import {
  OauthHttpError,
  createConnectSession,
  finalizeConnection,
} from "./oauth-client";
import type { AccountSummary, ConnectProvider } from "./oauth-client";

export type ConnectStage =
  | { kind: "idle" }
  | { kind: "starting"; provider: ConnectProvider }
  | { kind: "awaiting-user"; provider: ConnectProvider }
  | { kind: "finalizing"; provider: ConnectProvider }
  | { kind: "success"; provider: ConnectProvider; account: AccountSummary }
  | {
      kind: "error";
      provider: ConnectProvider | null;
      message: string;
      code?: string;
      docs?: string;
    };

export interface UseNangoConnectResult {
  stage: ConnectStage;
  connect: (provider: ConnectProvider) => Promise<void>;
  reset: () => void;
}

export function useNangoConnect(opts?: {
  onConnected?: (acc: AccountSummary) => void;
}): UseNangoConnectResult {
  const [stage, setStage] = useState<ConnectStage>({ kind: "idle" });
  // Singleton Nango client per hook instance; openConnectUI returns
  // a ConnectUI handle we hold on to so we can `.close()` on errors.
  const nangoRef = useRef<Nango | null>(null);
  const nango = (): Nango => {
    if (!nangoRef.current) nangoRef.current = new Nango();
    return nangoRef.current;
  };

  const reset = useCallback(() => setStage({ kind: "idle" }), []);

  const connect = useCallback(
    async (provider: ConnectProvider) => {
      setStage({ kind: "starting", provider });
      let session: Awaited<ReturnType<typeof createConnectSession>>;
      try {
        session = await createConnectSession(provider);
      } catch (err) {
        if (err instanceof OauthHttpError && err.body.error === "nango_not_configured") {
          setStage({
            kind: "error",
            provider,
            code: "nango_not_configured",
            message:
              err.body.message ??
              "Nango is not configured. Set NANGO_SECRET_KEY in the API env.",
            ...(err.body.docs ? { docs: err.body.docs } : {}),
          });
          return;
        }
        setStage({
          kind: "error",
          provider,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      setStage({ kind: "awaiting-user", provider });
      const ui = nango().openConnectUI({
        sessionToken: session.token,
        detectClosedAuthWindow: true,
        onEvent: async (ev) => {
          if (ev.type === "close") {
            setStage((s) => (s.kind === "awaiting-user" ? { kind: "idle" } : s));
            return;
          }
          if (ev.type === "error") {
            setStage({
              kind: "error",
              provider,
              code: ev.payload.errorType,
              message: ev.payload.errorMessage,
            });
            return;
          }
          if (ev.type !== "connect") return;
          setStage({ kind: "finalizing", provider });
          try {
            const account = await finalizeConnection({
              provider,
              connectionId: ev.payload.connectionId,
            });
            setStage({ kind: "success", provider, account });
            opts?.onConnected?.(account);
          } catch (err) {
            setStage({
              kind: "error",
              provider,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            ui.close();
          }
        },
      });
    },
    [opts],
  );

  return { stage, connect, reset };
}
