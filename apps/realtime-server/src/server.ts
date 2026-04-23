// Dev-only realtime server: presence + collision indicator
// (Phase 3 Real-time Updates). Production routes WebSocket through
// `@mailai/server`; this exists so `make dev` has a sensible local
// presence layer without spinning up the full backend.

import { WebSocketServer } from "ws";

const port = Number(process.env["MAILAI_RT_PORT"] ?? 1235);
const wss = new WebSocketServer({ port });

interface PresenceMsg {
  kind: "presence";
  userId: string;
  status: "online" | "typing" | "offline";
  threadId?: string;
}

const peers = new Map<
  string,
  { lastSeen: number; status: PresenceMsg["status"]; threadId?: string }
>();

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg: PresenceMsg | { kind: "health" };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if ("kind" in msg && msg.kind === "presence") {
      const cur = peers.get(msg.userId) ?? { lastSeen: 0, status: "offline" };
      const next = {
        lastSeen: Date.now(),
        status: msg.status,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
      };
      peers.set(msg.userId, next);
      void cur;
      const broadcast = JSON.stringify(msg);
      for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(broadcast);
    }
  });
});

console.log(`mailai-realtime ws on :${port}`);
