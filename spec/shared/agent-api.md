# Agent API (shared)

The `MailAgent` interface is the contract that the web UI, the CLI, and external agents all consume. Any difference between human use and agent use shows up here as a property of the call (`source: "agent"`), never as a different code path.

## TypeScript surface (excerpt)

See [`packages/agent/src/agent.ts`](../../packages/agent/src/agent.ts).

```ts
class MailAgent {
  constructor(opts: { bus: CommandBus; identity: MailAgentIdentity; source?: CommandSource });

  whoAmI(): MailAgentIdentity;

  applyCommand(input: {
    type: CommandTypeString;
    payload: unknown;
    idempotencyKey?: string;
  }): Promise<Mutation>;
  applyCommands(inputs: Array<{ type; payload }>): Promise<Mutation[]>;

  getPendingMutations(filter?: { actorId?: string; type?: CommandTypeString }): Promise<Mutation[]>;
  approveMutation(id: string): Promise<Mutation>;
  rejectMutation(id: string, reason?: string): Promise<Mutation>;
}
```

## Transports

- **In-process** (UI): the Next server passes its already-constructed `CommandBus` into a per-request `MailAgent`.
- **HTTP** (CLI, external agents): the CLI marshals `applyCommand` to `POST /api/commands` on `packages/server`. Same bus runs server-side.
- **MCP stdio** (LLM-style agents): `mail-agent mcp` exposes a fixed tool set whose schemas are the same zod schemas; the tool body wraps `applyCommand`.

## Subscriptions

Long-running agents use `agent.subscribe(filter, handler)` which sets up a WebSocket subscription against `packages/server`. Server fan-out is the same `EventBroadcaster` that powers human realtime updates — humans and agents see the same events.

## Batch atomicity

`applyCommands([...])` runs each command sequentially. There is **no transaction** spanning IMAP side-effects (IMAP has no transactions). Semantics:

- Each command's overlay write is wrapped in its own DB transaction.
- If a command's IMAP side-effect fails after overlay commit, the outboxer flips the mutation to `rolled-back` and re-applies the inverse overlay change. The audit log records both rows.
- Batch results carry `appliedCount` + `failedAt` so the agent can decide whether to continue or stop.

## Headless tests

Phase 4 Validate runs the full CLI command set without launching a browser:

```bash
pnpm --filter @mailai/agent test:cli
```

Each subcommand exits with the documented exit code and emits JSON validated against `schemas.ts`.

## OAuth device flow

`mail-agent auth login` uses RFC 8628 device-code flow against the user's primary identity provider. The CLI prints a verification URL + code; the user authorises in a browser; the CLI polls for the resulting token and stashes it in the OS keyring (macOS Keychain, Linux secret-service, Windows credential vault).
