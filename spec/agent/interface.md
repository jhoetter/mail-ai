# MailAgent — interface (Phase 4 spec)

The `MailAgent` is the single entry point for any non-UI mutation
into mail-ai: CLI invocations, MCP tool calls, scripted workflows,
LLM-driven agents. It is a **headless** SDK: no React, no HTTP
server in scope, no logging side effects beyond a passed-in
`audit` sink. The web UI uses the same SDK in-process.

## Goals

- One contract for human-vs-agent: the only difference is
  `Command.source = "agent"` and (sometimes) a stricter staging
  policy.
- Schema-first: every command payload is a zod schema in
  `packages/agent/src/schemas.ts`, and every CLI/MCP boundary calls
  `.parse()`. Invalid input never reaches the bus.
- No ambient state: the SDK takes a `CommandBus` and an
  `MailAgentIdentity` at construction time. It never reads global
  config.
- Useable from a 50-line script: `new MailAgent({...}).applyCommand(...)`
  must be enough to do real work, with idempotency.

## Type surface

The authoritative types live in
[`packages/agent/src/agent.ts`](../../packages/agent/src/agent.ts);
this section is descriptive.

```ts
interface MailAgentIdentity {
  userId: string;
  tenantId: string;
  inboxIds?: string[];
  displayName?: string;
}

class MailAgent {
  constructor(opts: {
    bus: CommandBus;
    identity: MailAgentIdentity;
    source?: "human" | "agent";
    sessionId?: string;
    now?: () => number;
  });

  whoAmI(): MailAgentIdentity;

  applyCommand<T extends CommandTypeString>(input: {
    type: T;
    payload: CommandPayloadFor<T>;
    idempotencyKey?: string;
    inboxId?: string;
  }): Promise<Mutation>;

  applyCommands(inputs: ApplyInput[]): Promise<BatchResult>;

  getPendingMutations(filter?: { actorId?: string; type?: CommandTypeString }): Promise<Mutation[]>;
  approveMutation(id: string): Promise<Mutation>;
  rejectMutation(id: string, reason?: string): Promise<Mutation>;

  subscribe(filter: SubscribeFilter, handler: (e: MailaiEvent) => void): UnsubscribeFn;
}
```

## Identity & source

- `source = "human"` for the web UI in-process call path.
- `source = "agent"` for the CLI, MCP tools, and any non-UI script.
- The `identity.userId` is stamped into `Command.actorId`; the bus
  uses it for RBAC and audit attribution. There is **no anonymous
  agent** — every agent has a service-user record in `users`.

## Idempotency

`idempotencyKey` is a UTF-8 string ≤ 200 bytes scoped to
`(tenantId, actorId, type)`. The agent SDK passes it as-is to the
bus, which de-duplicates by storing the key in `pending_mutations`
(or its applied counterpart) and returning the previously-stored
mutation on repeat. Without a key, every call is a new mutation.

## Why an SDK and not "just" HTTP

Two reasons, both forced by the Phase-3 spec:

1. The web UI calls the bus in-process; the CLI calls it over
   HTTP. Both must produce **identical** mutations and audit rows.
   That only works if the CLI/MCP/UI all flow through one typed
   surface.
2. MCP (Anthropic Model Context Protocol) tools want a
   schema-first contract; we're already maintaining one for HTTP
   validation, so the SDK simply re-uses it.
