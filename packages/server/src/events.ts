// EventBroadcaster: tiny in-process pub/sub backing both the HTTP API
// fan-out and the WebSocket server in apps/realtime-server. For
// horizontal scaling this is replaced by a Redis pub/sub adapter; the
// public surface is the same.

import { WebSocketServer, type WebSocket } from "ws";
import type { Mutation } from "@mailai/core";

export type MailaiEvent =
  | { kind: "mutation"; mutation: Mutation }
  | { kind: "presence"; userId: string; status: "online" | "typing" | "offline"; threadId?: string };

export class EventBroadcaster {
  private readonly clients = new Set<WebSocket>();

  attach(server: WebSocketServer): void {
    server.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
    });
  }

  publish(event: MailaiEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}
