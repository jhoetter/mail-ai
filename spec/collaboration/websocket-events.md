# WebSocket event contract

The realtime channel is a single WS endpoint (`/ws`) authenticated by the user's session cookie. Server messages share a discriminated-union envelope:

```ts
type ServerEvent =
  | { type: "hello"; sessionId: string; serverTime: number }
  | { type: "mutation"; mutation: PublicMutation }
  | { type: "thread.touched"; threadId: string; lastMessageAt: number }
  | { type: "presence"; threadId: string; users: { id: string; cursor?: string }[] }
  | { type: "comment.added"; threadId: string; commentId: string }
  | { type: "thread.assigned"; threadId: string; userId: string | null }
  | { type: "thread.status"; threadId: string; status: ThreadStatus }
  | { type: "sla.breached"; threadId: string; inboxId: string }
  | { type: "ping" };

type PublicMutation = {
  id: string;
  type: CommandTypeString;
  actorId: string;
  source: CommandSource;
  affectedKinds: EntityKind[];
  status: MutationStatus;
  ts: number;
};
```

Client → server messages:

```ts
type ClientMessage =
  | { type: "subscribe"; channels: ("inbox:" | "thread:")[] }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "presence.set"; threadId: string; cursor?: string }
  | { type: "pong" };
```

## Channels

- `inbox:<id>` — events affecting any thread in this inbox.
- `thread:<id>` — events affecting one thread (comments, presence, status).

A connection may subscribe to many channels. The server enforces RBAC at subscribe time — a member of inbox A trying to subscribe to inbox B gets a `not-allowed` error and the channel is removed from their subscription list silently for everything else.

## Delivery semantics

- **At-least-once** within a single TCP session.
- **No replay** across reconnects: clients refetch state on reconnect.
- **Backpressure**: server queues up to 1000 events per connection; overflow drops `ping` and `presence` events first, then closes with code 1011.

## Privacy

Events include only IDs and minimal metadata; full entity bodies are fetched via REST. This avoids leaking message content into a long-running WS log buffer.
