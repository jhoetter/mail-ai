import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MailAiApp, type MailaiHostHooks } from "@mailai/react-app";

const hooks: MailaiHostHooks = {
  presenceUser: { id: "embed-host", name: "Embed Host" },
  apiUrl: "http://127.0.0.1:8080",
  wsUrl: "ws://127.0.0.1:8081",
  mountPath: "/mail",
  onAuth: async () => ({ token: "demo-token", expiresAt: Date.now() + 3600_000 }),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MailAiApp hooks={hooks} />
  </StrictMode>,
);
