# Build an AI-Native Email Collaboration Platform (IMAP Overlay)

## Mission

You are a senior software architect and engineer. You will autonomously build a browser-accessible, AI-native email collaboration platform in one continuous session. The platform is a **server-side overlay** over existing IMAP/SMTP mailboxes — it does NOT run its own mail server, and it does NOT replace the user's existing Outlook, Apple Mail, or Gmail client.

Think of it as the Front/Missive model: users keep their mailboxes at Google, Microsoft, or any IMAP provider. Our system connects via IMAP/OAuth2, synchronizes mail into an overlay database, and layers collaboration features (assignment, internal comments, status, tags, agent actions) on top. The original client (Outlook desktop, Gmail web, mobile Mail.app) keeps working in parallel — state changes we make through IMAP (read/unread, flags, sent mail) show up there too.

Work in this exact sequence, without skipping ahead:

1. Spec IMAP Sync Engine → Build → Validate
2. Spec Overlay Data Model → Build → Validate
3. Spec Collaboration Layer → Build → Validate
4. Spec Agent API + CLI → Build → Validate
5. Spec Web UI → Build → Validate

Do not start a step until the previous one is fully validated. Do not start building until the spec for that step is complete.

---

## Non-Negotiable Quality Bar

**IMAP Coexistence Integrity.** Every change the system makes to a mailbox must be visible and coherent to the user's existing email client (Outlook, Apple Mail, Gmail web) because it goes through standard IMAP/SMTP. Specifically:

- Marking a mail as read in our UI → shows as read in Outlook within seconds
- Replying via our UI → the sent mail lands in the normal "Sent" IMAP folder, visible in Outlook
- Moving a mail to a folder → the move is reflected in Outlook
- Nothing we do must corrupt the user's mailbox, duplicate messages, or lose flags
- If our connection is down for hours, catching up must produce the same final state as if we had been online the whole time (eventual consistency, no drift)

**Overlay Isolation.** Our overlay features (assignments, internal comments, status, tags) live **only in our database**. They must never leak into IMAP — no fake headers, no hidden folders in the user's account, no smuggled metadata. If the user disconnects our system tomorrow, their mailbox must look exactly as if we had never been there.

These two bars together are the acceptance criterion that cannot be traded away. Everything else is scope.

---

## Legal Constraint (Clean-Room Approach)

You will analyze reference repositories to extract concepts, patterns, and architectural decisions. You will then build a fresh implementation from a specification you derive — not a fork, not a dependency, not a copy.

**Allowed:** Study public code, extract architecture concepts, describe behavior and algorithms at the conceptual level, implement independently from first principles + IMAP/MIME RFCs. You are also allowed to use open source libraries for building, e.g. MIT- or Apache-licensed libraries that are unproblematic to build on.

**Not allowed:** Copy code verbatim, lightly rename identifiers, use any AGPL-licensed component as a runtime dependency, import reference repos as packages.

**Runtime dependencies permitted** (MIT / Apache 2.0 / BSD only):

- `imapflow` (MIT) — modern IMAP client for Node.js
- `mailparser` (MIT) — MIME parsing
- `nodemailer` (MIT) — SMTP sending and MIME composition
- `mime` (MIT) — MIME type utilities
- `libmime` (MIT) — MIME encoding/decoding primitives
- PostgreSQL driver (`pg`, MIT) — database access
- `kysely` or `drizzle-orm` (MIT) — typed SQL query builder
- `zod` (MIT) — runtime schema validation
- `fastify` or `hono` (MIT) — HTTP server framework
- `ws` (MIT) — WebSocket server for real-time push
- `bullmq` (MIT) — job queue for sync workers (Redis-backed)
- `@azure/msal-node` (MIT) — Microsoft OAuth2
- `google-auth-library` (Apache 2.0) — Google OAuth2
- Any other MIT/Apache/BSD library if justified in the spec

**Explicitly forbidden as dependencies:**

- FreeScout (AGPL) — study only
- Anything from PPTist, SOGo, or other AGPL email/groupware code — study only

---

## Reference Repositories

Study these before speccing each phase. Read architecture docs, main source files, and tests. Do not copy. Understand.

### IMAP Sync + Overlay Architecture

- https://github.com/Mail-0/Zero (MIT) — primary reference: modern TypeScript email client, OAuth2 Gmail/Outlook, overlay DB pattern, Next.js
- https://github.com/uninbox/UnInbox (if MIT/Apache) — shared inbox, workflow statuses, team features; study the DB schema and sync logic
- https://github.com/elie222/inbox-zero (MIT) — OAuth emulator setup, Gmail/Microsoft integration, agent-style rules engine
- https://github.com/nylas/nylas-mail (historical, MIT era) — mature sync engine architecture, conflict resolution, UID handling

### IMAP Protocol Implementation (reference, not copy)

- https://github.com/postalsys/imapflow (MIT) — the library we'll use; study its IDLE handling and UID sync patterns
- https://github.com/mscdex/node-imap (MIT) — older but well-tested IMAP client; good for understanding edge cases

### Shared Inbox / Collaboration Patterns (study only, many are AGPL)

- https://github.com/freescout-help-desk/freescout (AGPL — study architecture only, zero code copying) — mature shared inbox: assignment, conversations, threading, status workflow
- https://github.com/chatwoot/chatwoot (MIT core) — conversation model, agent assignment, team/inbox hierarchy
- https://github.com/erxes/erxes (AGPL — architecture only)

### Protocol Standards (canonical truth, always prefer over implementations)

- IMAP4rev2: RFC 9051 — https://www.rfc-editor.org/rfc/rfc9051
- IMAP4rev1: RFC 3501 — https://www.rfc-editor.org/rfc/rfc3501 (most servers still speak this)
- IMAP IDLE: RFC 2177
- IMAP CONDSTORE / QRESYNC: RFC 7162 (efficient resync)
- IMAP UIDPLUS: RFC 4315
- MIME: RFC 2045, 2046, 2047, 2049
- Internet Message Format: RFC 5322
- SMTP: RFC 5321 / Submission: RFC 6409
- OAuth2 SASL XOAUTH2: https://developers.google.com/gmail/imap/xoauth2-protocol
- JMAP (future-proofing reference): RFC 8620, 8621

---

## Project Structure

Create this monorepo from the start:

```
/
  packages/
    core/              # shared types, command bus, diff engine, plugin system
    imap-sync/         # IMAP connection pool, sync engine, IDLE listener, delta sync
    mime/              # MIME parse/compose helpers, threading, sanitization
    smtp-send/         # SMTP submission via provider credentials
    overlay-db/        # database schema, migrations, repository pattern
    collaboration/     # assignments, comments, status, tags, audit log, WebSockets
    agent/             # agent API (headless) + CLI tool (mail-agent)
    web/               # browser UI (Next.js or similar)
    server/            # HTTP/WebSocket API server
  spec/                # living specification
    shared/
    imap-sync/
    overlay/
    collaboration/
    agent/
    web/
  fixtures/            # real-world test data
    mime-samples/      # .eml files from various providers
    mailboxes/         # Dovecot/Greenmail test mailbox dumps
  tests/
    integration/       # IMAP coexistence tests (against Dovecot/Greenmail)
    agent/             # agent API tests
    overlay/           # overlay isolation tests
  infra/
    docker/            # dev stack: Postgres, Redis, Dovecot, Greenmail
  docs/
    build-log/         # decisions, discoveries, deviations from spec
```

---

## Phase Structure (Repeat for Each Phase)

### Step A: Analyze

Before writing a single line of spec or code, deeply study the reference repos and RFCs for this phase. Specifically answer:

1. What is the canonical model? (For sync: how do references handle UIDs, UIDVALIDITY, CONDSTORE? For overlay: how do they model threads vs. messages vs. conversations?)
2. What's the connection/session model? How are credentials and tokens managed?
3. How is state reconciled between local overlay and remote IMAP? What's the source of truth for each field?
4. What's the mutation pattern? How does a "mark as read" flow from UI → overlay DB → IMAP server → back to other clients?
5. How are hard parts handled? (Threading across folders, large attachments, server-side changes during IDLE, OAuth token refresh, Gmail's labels-as-folders weirdness)
6. What does the reference get wrong or sacrifice that we should improve?
7. What's missing from the 80% scope we need?

Write analysis notes in `/spec/{phase}/analysis.md`. These notes inform the spec but are not the spec.

---

### Step B: Spec

Produce the specification for this phase. The spec is the contract for the build. It must be complete enough that someone could implement it independently.

**Required spec documents:**

#### `/spec/shared/` (produce once, before IMAP Sync)

- `architecture.md` — the overall system: processes, services, how they communicate; deployment model (self-hosted, multi-tenant, single-tenant)
- `data-model.md` — shared abstractions: account, mailbox, message, thread, conversation, envelope, body-structure, flag; how these map to IMAP concepts and how they map to our overlay
- `command-bus.md` — every state change (human UI click, agent call, IMAP server notification) flows through a command bus; commands are serializable JSON; they produce mutations; mutations are diffable and reviewable
- `plugin-system.md` — how features are registered; how a plugin declares what commands it handles; how UI and logic stay separate
- `security-model.md` — OAuth token storage (encrypted at rest), per-user key scoping, CSRF, session management, rate limiting; what an attacker who compromises one component can and cannot do
- `agent-api.md` — the unified agent API contract: what operations every agent has; separation between read, propose (staged), and commit (approved)

#### `/spec/{phase}/` (per phase)

- `feature-scope.md` — exactly what is IN the 80% and what is explicitly OUT; no ambiguity
- `design.md` — the design specific to this phase; data types, state machines, algorithms
- `protocol-mapping.md` (sync phases only) — for every in-scope feature: which IMAP commands are used, what responses are parsed, how errors are handled
- `database-schema.md` (overlay/collaboration phases) — exact tables, columns, indexes, foreign keys, constraints, migrations
- `algorithms.md` — pseudocode for non-trivial logic (delta sync, thread reconstruction, conflict resolution)
- `api.md` — HTTP endpoints, WebSocket events, CLI commands exposed by this phase
- `edge-cases.md` — known hard cases and how we handle them; what we degrade gracefully; what surfaces as an error to the user
- `acceptance-criteria.md` — measurable done criteria: which integration tests must pass, which manual flows must work

**Spec quality bar:** A spec document is done when:

- It is self-contained (doesn't assume knowledge from the reference repos)
- It is precise (data types have explicit shapes, algorithms have pseudocode or step-by-step prose)
- It is honest (scope exclusions are explicit, uncertainties are flagged)
- It is actionable (someone could implement from it without asking clarifying questions)

Do NOT begin building until the spec passes this bar.

---

### Step C: Build

Implement the phase based on the spec. Follow this sub-order within each phase:

1. **Protocol/data layer first** — IMAP client wiring, or DB schema, before any higher-level logic; validate against fixtures and integration tests immediately
2. **Pure domain logic** — state machines, sync algorithms, threading logic; pure TypeScript, no HTTP, no DOM, no React
3. **Command bus integration** — every mutation flows through the bus; headless-testable
4. **HTTP/WebSocket API** — expose functionality to clients; test with integration tests
5. **Agent API + CLI** — expose commands programmatically; test this before building any UI
6. **UI layer** — only after the headless stack is green

**Build discipline:**

- Write integration tests before implementing each sync/API feature; use Dockerized Dovecot or Greenmail as a real IMAP server in CI
- Every command must be testable headlessly (no browser required)
- Every PR-equivalent commit must not reduce IMAP coexistence test pass rate
- Keep `/docs/build-log/{phase}.md` updated with non-trivial decisions

---

### Step D: Validate

Before declaring a phase complete and moving to the next:

Run the full validation suite:

- [ ] Integration tests pass against Dockerized IMAP server (Dovecot + Greenmail)
- [ ] IMAP coexistence tests pass: a second "control" client (mail client stub using imapflow directly) sees our changes within expected SLAs
- [ ] Overlay isolation tests pass: snapshot the IMAP mailbox before and after our usage; only message flags, folder positions, and sent messages changed — no hidden metadata
- [ ] Agent API / CLI tests pass: all commands work headlessly, exit codes are correct, JSON output validates against schema
- [ ] Performance: 10k-message mailbox syncs in reasonable time; IDLE reconnect after disconnect completes cleanly
- [ ] Security: OAuth tokens encrypted at rest; no token logs; credential rotation works
- [ ] Spec and build log are up to date

Only after all boxes are checked: move to the next phase.

---

## The 80% Scope per Phase

### Phase 1: IMAP Sync Engine — In Scope

- Connect to any IMAP4rev1/rev2 server over TLS (port 993)
- Authentication: plain LOGIN (password), SASL PLAIN, and XOAUTH2 (Google, Microsoft)
- OAuth2 flow end-to-end for Gmail and Microsoft 365 (access + refresh token, automatic refresh)
- Mailbox discovery (LIST, LSUB, special-use flags: \Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive)
- Per-mailbox sync: initial fetch (ENVELOPE, BODYSTRUCTURE, FLAGS), incremental delta sync using UIDVALIDITY + HIGHESTMODSEQ (CONDSTORE)
- IDLE connection per mailbox (with NOOP fallback for servers without IDLE)
- Automatic reconnection with exponential backoff; UIDVALIDITY change handling (full resync for that mailbox)
- Gmail-specific: handle labels-as-folders (same message appears in multiple folders under Gmail IMAP)
- Outgoing actions via IMAP: set/unset flags (\Seen, \Flagged, \Answered, \Deleted), MOVE (or COPY+EXPUNGE fallback), APPEND to Sent after SMTP send
- Rate limiting and connection pooling per provider (Gmail: 15 concurrent IMAP connections per user; Microsoft: 20)
- Structured error surfacing: distinguish authentication errors, network errors, quota errors, server-side bugs

### Phase 1: IMAP Sync Engine — Explicitly Out of Scope

- POP3 support (we may never need it; if we do, it's a separate phase)
- Server-side search via IMAP SEARCH (we search our overlay DB instead)
- Sieve scripts / server-side filtering (preserve; do not manage)
- Shared mailbox delegation (Exchange-specific features via IMAP — defer)
- NNTP, Exchange EWS, MAPI, Microsoft Graph as alternative transports (IMAP only for v1)

---

### Phase 2: Overlay Data Model — In Scope

- PostgreSQL schema: accounts, mailboxes, messages, threads, message_flags, attachments_meta (blobs in object storage), sync_state
- Message storage: full MIME source stored compressed in object storage (S3-compatible); parsed structure in Postgres
- Threading: JWZ algorithm based on Message-ID / In-Reply-To / References; threads span folders/labels; reconstruction is idempotent
- Full-text search: Postgres `tsvector` on subject + body-text; attachments optional (v1: filename only)
- Multi-account per user: a user can connect N mailboxes; each mailbox has independent sync state
- Multi-tenancy: per-organization isolation; row-level security or schema-per-tenant (decide in spec)
- Attachment handling: stream attachments to object storage on sync; never hold full MIME in memory for large messages
- Deduplication: same RFC822 message (by Message-ID + Date) stored once per account even if it appears in multiple folders/labels

### Phase 2: Overlay Data Model — Explicitly Out of Scope

- Encrypted-at-rest message bodies (defer; plan for it in security model but v1 relies on DB/storage-level encryption)
- Search over attachment contents (tika-style extraction) — defer
- Full revision history of MIME (we store latest + flag history; not every server round-trip)

---

### Phase 3: Collaboration Layer — In Scope

- **Shared Inboxes:** a mailbox can be marked as shared and assigned to a team; all team members see it
- **Assignment:** one assignee per thread; assignment history tracked; reassignment is a tracked event
- **Status workflow:** `open → snoozed → resolved → archived`, per thread; status is overlay-only (never written to IMAP)
- **Internal comments:** Slack-style comments on threads, visible only to team members, never sent to the email sender
- **Collision detection:** WebSocket "someone is replying" indicator (soft lock, not hard)
- **Tags / Labels:** overlay tags (distinct from IMAP/Gmail labels we sync); color-coded; taggable on threads
- **Mentions:** `@user` in comments triggers in-app notification + optional email/Slack push
- **Audit log:** every state change (status, assignment, comment, send, tag) appended to an immutable log; exportable for compliance
- **SLA timers:** per-inbox response-time targets; surface overdue threads in the UI
- **Permissions/roles:** admin, member, read-only; per-inbox access control

### Phase 3: Collaboration Layer — Explicitly Out of Scope

- Custom workflow builder (v1 has one fixed workflow)
- Canned replies / macros (defer)
- SLA reporting dashboards beyond "what's overdue right now" (defer)
- Public-facing portal / customer self-service (this is not a helpdesk clone; it's an email-first collab tool)

---

### Phase 4: Agent API + CLI — In Scope

- Headless Agent API (`@platform/agent`) with zero HTTP/WebSocket dependency — connect directly to Postgres + IMAP
- Every collaboration and mail operation is exposed as a typed command
- CLI tool (`mail-agent`) wrapping the headless API; pipeable, scriptable, JSON output by default
- OAuth2 device flow for CLI authentication (so a server-side script can be authorized by a human once)
- Full read access: list accounts, list mailboxes, list threads, read messages, read comments, read audit log
- Full write access: send mail, reply, forward, assign, comment, tag, set status, snooze
- Agent-staged changes: an agent can _propose_ a reply that sits as a draft + pending assignment until a human approves; approval is a separate command
- Batch operations: apply N commands atomically (transactional at the overlay level; best-effort at the IMAP level with rollback-on-IMAP-failure semantics specified)

### Phase 4: Agent API + CLI — Explicitly Out of Scope

- Native SDKs in languages other than TypeScript/Node (document the HTTP API so others can build them; official SDK is TS-only for v1)
- MCP server wrapping the agent API (plan for v2; the agent API should be MCP-ready in shape)

---

### Phase 5: Web UI — In Scope

- Thread list (per mailbox, per "assigned to me", per tag, per status)
- Thread detail with message rendering (HTML sanitized; plaintext fallback)
- Compose/reply/forward with MIME attachments
- Internal comment sidebar on every thread
- Assignment dropdown, status buttons, tag picker on every thread
- Real-time updates via WebSocket (new mail, new comment, status change, collision indicator)
- Keyboard shortcuts for power users (j/k navigation, e to archive, r to reply, a to assign — Gmail-style)
- Search box (Postgres full-text)
- Account connection flow (OAuth2 for Google/Microsoft, app-password for others)
- Minimal settings: profile, signature, notification preferences

### Phase 5: Web UI — Explicitly Out of Scope

- Mobile app (responsive web is enough for v1; native apps later)
- Offline mode / service worker caching
- Custom themes
- Plugin marketplace

---

## The AI-Native Design (Most Important Section)

This is the core differentiator. The platform must be designed from the ground up so that AI agents are first-class users — not an afterthought bolted on top.

### Core Principle: Everything Is a Command

No direct database or IMAP mutation is ever allowed from UI or agent code. Every change — whether made by a human clicking a button, or by an AI agent calling an API — flows through the **command bus**. This is not optional architecture; it is the invariant that makes everything else (diffs, review, audit log, rollback, multi-agent coordination) possible.

A command is:

```typescript
interface Command<T extends string, P> {
  type: T; // e.g. "mail:send", "mail:assign-thread", "mail:set-status"
  payload: P; // fully typed, serializable to JSON
  source: "human" | "agent" | "system"; // system = IMAP push from server
  actorId: string; // userId for human, agentId for agent, "imap:<account>" for system
  timestamp: number;
  sessionId: string;
  idempotencyKey?: string; // for retry-safe batch ops
}
```

A mutation is the result of applying a command:

```typescript
interface Mutation {
  command: Command;
  before: EntitySnapshot; // affected thread/message/comment snapshot pre-change
  after: EntitySnapshot;
  diff: EntityDiff;
  imapSideEffects: ImapSideEffect[]; // flags set, messages appended, etc.
  status: "pending" | "applied" | "failed" | "rolled-back";
}
```

### The Agent API

The headless agent interface:

```typescript
interface MailAgent {
  // Identity
  whoAmI(): Promise<Identity>;
  listAccounts(): Promise<Account[]>;

  // Read
  listMailboxes(accountId: string): Promise<Mailbox[]>;
  listThreads(query: ThreadQuery): Promise<Thread[]>;
  getThread(threadId: string): Promise<ThreadDetail>;
  getMessage(messageId: string): Promise<MessageDetail>;
  search(query: SearchSpec): Promise<SearchResult[]>;
  getAuditLog(query: AuditQuery): Promise<AuditEntry[]>;

  // Write — everything goes through command bus
  applyCommand(command: Command): Promise<Mutation>;
  applyCommands(commands: Command[]): Promise<Mutation[]>; // atomic at overlay level

  // Staged changes (agent-proposed, awaiting human approval)
  getPendingMutations(filter?: PendingFilter): Promise<Mutation[]>;
  approveMutation(mutationId: string): Promise<Mutation>;
  rejectMutation(mutationId: string, reason?: string): Promise<void>;
  rollback(mutationId: string): Promise<Mutation>; // only valid for certain command types

  // Send
  sendMail(draft: DraftSpec): Promise<Mutation>; // composes MIME, SMTP submit, APPEND to Sent, emit mutation
  proposeDraft(draft: DraftSpec, approvalRequired: true): Promise<Mutation>; // stays as pending

  // Subscriptions (for long-running agents)
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
}
```

This interface must work **headlessly** — with zero DOM, zero browser, zero HTTP server required. An AI agent running in Node.js on a server must be able to:

- Authenticate (device flow or service account)
- Read threads and messages
- Apply commands
- Subscribe to new-mail events
- Send replies or propose drafts

The web UI is a user of the same agent API — not a special path.

### Command Catalog (minimum set; expand fully in spec)

```
mail:mark-read            { threadId, messageIds? }
mail:mark-unread          { threadId, messageIds? }
mail:archive              { threadId }
mail:move-to-folder       { threadId, folderId }
mail:delete               { threadId | messageId }
mail:flag                 { threadId, flagged: boolean }
mail:send                 { to, cc?, bcc?, subject, body, inReplyTo?, attachments? }
mail:reply                { threadId, body, replyAll?: boolean, attachments? }
mail:forward              { messageId, to, body?, attachments? }

thread:assign             { threadId, assigneeId }
thread:unassign           { threadId }
thread:set-status         { threadId, status: 'open' | 'snoozed' | 'resolved' | 'archived' }
thread:snooze             { threadId, until: ISO8601 }
thread:add-tag            { threadId, tagId }
thread:remove-tag         { threadId, tagId }

comment:add               { threadId, text, mentions?: userId[] }
comment:edit              { commentId, text }
comment:delete            { commentId }

account:connect           { provider, credentials | oauthToken }
account:disconnect        { accountId }
account:resync            { accountId, mailboxId? }
```

### The Human Review Flow (Agent Staging)

When `source === 'agent'` AND the command type is flagged as "requires approval" (configurable per inbox / per agent), mutations are staged — not immediately applied to the "live" overlay state. They go into a pending queue:

```
Thread State:
  ├── authoritative: ThreadSnapshot    (what has been approved / happened)
  ├── pending:       Mutation[]        (agent proposals, not yet approved)
  └── projected:     ThreadSnapshot    (authoritative + pending = what the UI shows with highlights)
```

The UI renders `projected` with pending mutations visually marked (like tracked changes in Word, or Git diff highlights). The human can:

- **Approve all** → pending mutations move to authoritative; IMAP side-effects execute
- **Approve one** → that mutation moves; others stay pending
- **Reject one** → removed from pending; UI reverts that change
- **Edit then approve** → human edits the proposed draft text, then approves (the edit itself is a command)

Commands that **never** require approval (always auto-applied even from agents): `mail:mark-read`, `thread:add-tag`, `comment:add`. Commands that **always** require approval from agents: `mail:send`, `mail:reply`, `mail:forward`, `mail:delete`, `account:disconnect`. Everything else is configurable.

This model must be built into the core command bus — not per-component, not as an afterthought.

### The CLI Interface

Produce a CLI tool (`mail-agent`) that wraps the headless agent API. Designed to be pipeable, scriptable, and composable with standard UNIX tools.

```bash
# Authentication
mail-agent auth login                    # device flow; opens browser
mail-agent auth whoami
mail-agent auth logout

# Accounts
mail-agent account list
mail-agent account connect --provider gmail
mail-agent account connect --provider imap --host imap.example.com --user me@example.com
mail-agent account resync --account-id acct_123

# Reading
mail-agent thread list --status open --assigned-to me --format json
mail-agent thread list --mailbox INBOX --limit 20 --format table
mail-agent thread show thread_abc --format markdown
mail-agent message show msg_xyz --with-headers
mail-agent search "from:boss@acme.com unread" --format json

# Writing
mail-agent thread assign thread_abc --to user_def
mail-agent thread status thread_abc --set resolved
mail-agent thread tag thread_abc --add urgent
mail-agent comment add thread_abc --text "Can you take this one?" --mention user_def

# Sending
mail-agent send --to boss@acme.com --subject "Q3 numbers" --body-file ./draft.md
mail-agent reply thread_abc --body-file ./reply.md
mail-agent reply thread_abc --body-file ./reply.md --propose   # stages as pending for human review

# Agent staging workflow
mail-agent pending list --format json
mail-agent pending approve mut_123
mail-agent pending reject mut_456 --reason "wrong tone"

# Subscriptions (long-running)
mail-agent watch --inbox support --event new-message --exec './triage.sh {{thread_id}}'

# Bulk / scripting
cat thread_ids.txt | xargs -I{} mail-agent thread status {} --set archived
mail-agent thread list --status open --format json | jq '.[] | select(.age_hours > 48)'
```

The CLI is the primary interface for AI agents in server-side pipelines. JSON output is the default for machine consumption; add `--format table` / `--format markdown` for human use. Exit codes follow UNIX conventions (0 success; 1 user error; 2 auth error; 3 network error; 4 conflict). Errors go to stderr as structured JSON when `--format json` is set.

---

## Integration Requirements

This is critical. The system must:

### Connect (Inbound)

- Support OAuth2 for Google Workspace / Gmail (via XOAUTH2 SASL over IMAP)
- Support OAuth2 for Microsoft 365 / Outlook.com (via XOAUTH2 SASL over IMAP; Microsoft disabled Basic Auth for M365 in 2022)
- Support plain IMAP+password for any standards-compliant server (Fastmail, iCloud app-passwords, self-hosted Dovecot/Stalwart, ProtonMail Bridge, etc.)
- On connection failure: surface a clear, actionable error (wrong password, MFA required, app-password needed, OAuth consent withdrawn, network, server down). Never fail silently.
- Connection credentials encrypted at rest using a per-tenant key; never logged

### Coexist (Parallel with Existing Clients)

- Outlook desktop, Outlook mobile, Apple Mail, Gmail web, Thunderbird all keep working against the same mailbox at the same time
- A flag we set is visible to other clients within seconds
- A message another client deletes is gone from our UI within seconds (via IDLE)
- We respect server-side UIDVALIDITY changes (Gmail label rename, Exchange folder recreation) by triggering a full resync of that mailbox
- Concurrent write conflicts (we try to set \Seen, another client sets \Deleted at the same moment) resolved by last-write-wins on each flag, with the audit log capturing the race

### Send (Outbound)

- SMTP submission via the user's provider (smtp.gmail.com:587 + XOAUTH2, smtp.office365.com:587 + XOAUTH2, custom host)
- After successful SMTP submit: IMAP APPEND to the user's Sent folder so the message appears in Outlook/Gmail the same way a native send would
- Set In-Reply-To and References headers correctly for replies (threading intact in other clients)
- MIME compose: multipart/alternative (HTML + plaintext), multipart/mixed for attachments, proper Content-Transfer-Encoding, UTF-8 everywhere

### API Shapes

```typescript
// Browser / HTTP API
POST /api/commands              // body: Command | Command[]
GET  /api/threads?status=open
GET  /api/threads/:id
GET  /api/messages/:id
WS   /api/events                // subscribe to mutations

// Headless agent (Node.js, same process or remote)
import { MailAgent } from '@platform/agent'
const agent = await MailAgent.connect({ apiUrl, token })
const threads = await agent.listThreads({ status: 'open', assignedTo: 'me' })
await agent.applyCommand({
  type: 'mail:reply',
  payload: { threadId: threads[0].id, body: 'Acknowledged.' },
  source: 'agent',
  actorId: 'agent:triage-bot',
  timestamp: Date.now(),
  sessionId: 'sess_123',
})
```

---

## Fixture Corpus

Before building each phase, collect real-world test data. This is not optional.

### MIME Fixtures (collect before Phase 1)

- 20 `.eml` files exported from Gmail — HTML bodies, inline images, multiple attachments, long References chains
- 20 `.eml` files from Outlook / Exchange — RTF-originated HTML, winmail.dat edge cases, meeting invites (.ics)
- 10 `.eml` files from Apple Mail — `apple-mail-signature` divs, HEIC attachments
- 10 `.eml` files from Thunderbird — plaintext-only, format=flowed
- 10 multilingual samples — UTF-8, UTF-16, ISO-8859-1, Shift_JIS, quoted-printable, Base64; non-ASCII subjects (RFC 2047 encoded-word)
- 5 PGP/MIME-signed messages — must parse envelope correctly even if we don't verify the signature
- 5 S/MIME messages — same: parse envelope, don't block
- 5 malformed samples — unterminated boundaries, missing headers, lying Content-Type — our parser must not crash

### IMAP Server Fixtures (collect before Phase 1)

- Dockerized Dovecot with test users and seeded mailboxes for CI
- Dockerized Greenmail for IMAP-with-IDLE integration tests
- Recorded IMAP transcripts for edge cases (UIDVALIDITY change, EXPUNGE during IDLE, partial FETCH responses) — replay via test double

### Mailbox Fixtures (collect before Phase 2)

- 3 seeded Gmail-style mailboxes with ~5k messages and labels-as-folders behavior
- 3 seeded Exchange-style mailboxes with subfolders and shared mailbox delegation
- 2 mailboxes with deep thread chains (40+ messages, In-Reply-To chains with gaps)

### Collaboration Fixtures (collect before Phase 3)

- Synthetic multi-user scenario scripts: 3 users, 2 shared inboxes, simulate a day of triage/reply/assign activity; used as end-to-end scenarios

If you cannot access real files, generate realistic synthetic fixtures — but flag them as synthetic and plan to replace with real-world files before production.

---

## Architecture Principles (Non-Negotiable)

1. **Overlay, not replacement.** We do not run a mail server. The user's mailbox continues to live at Google/Microsoft/wherever. If our service disappears tomorrow, the user's mail is unaffected.

2. **IMAP is the source of truth for mail; our DB is the source of truth for overlay metadata.** The two stay in sync via the command bus and IDLE notifications. Our DB is never authoritative for things that already exist in IMAP (message content, flags, folder membership).

3. **Headless-first.** The core of every module (sync engine, overlay DB, command bus, agent API) runs in Node.js with zero DOM. The web UI is just a rendering surface on top of the HTTP/WebSocket API. This is what makes the agent API real.

4. **Commands are the only mutation path.** Direct DB or IMAP mutation is never allowed outside of the parser/sync layers. Everything else goes through the command bus. This is the invariant that enables diffs, review, rollback, audit, and multi-agent coordination.

5. **Opaque preservation.** Any MIME part, IMAP flag, or mailbox header we don't understand is preserved. We never silently drop or rewrite unknown IMAP metadata.

6. **Separation of concerns.** Sync Engine ↔ Overlay DB ↔ Command Bus ↔ Collaboration ↔ Agent API ↔ Web UI. Each layer has one job. No shortcuts that fuse layers together.

7. **Headless coexistence.** Every outbound action (flag change, move, send) must be designed so that a second client (Outlook) watching the same mailbox sees a coherent end state. Race conditions are specified, not hand-waved.

8. **Progressive sync.** Large mailboxes must not block initial usage. Sync recent mail first (last 30 days), older mail lazily. The user can compose, reply, and collaborate before full historical sync is done.

9. **Fail loudly.** Sync failures, token expiries, IMAP protocol errors, and DB constraint violations surface as structured errors with useful messages — never as silent drift or data corruption.

10. **No smuggling.** Never store our overlay metadata in hidden IMAP folders, fake headers, or flag names. If the user disconnects us, their mailbox must look untouched by us.

---

## Output at the End of Each Phase

When you complete a phase (Spec → Build → Validate), produce:

1. **`/spec/{phase}/`** — all spec documents, complete and up-to-date
2. **`/packages/{phase}/`** — the implementation
3. **`/tests/integration/{phase}/`** — passing integration test suite against Dockerized IMAP
4. **`/docs/build-log/{phase}.md`** — decisions, deviations from spec, known issues
5. **A summary comment** in the session describing: what was built, what passes, what's deferred, what was harder than expected

---

## Start Instructions

1. Read this entire prompt twice.
2. Set up the monorepo structure.
3. Set up the local dev stack (Docker Compose: Postgres, Redis, Dovecot, Greenmail).
4. Collect or generate the MIME fixture corpus.
5. Begin the IMAP Sync Engine analysis phase — study the reference repos and RFCs.
6. Produce the shared spec (`/spec/shared/`) and the Phase 1 spec.
7. Build the IMAP Sync Engine.
8. Validate against Dockerized IMAP servers and fixture mailboxes.
9. Move to Phase 2 (Overlay Data Model). Repeat.
10. Continue through Phases 3, 4, 5 in order.

Before starting, confirm:

- You understand the clean-room constraint and will not copy code from FreeScout, PPTist, or any AGPL source
- You understand the IMAP coexistence bar and will not move forward without passing it
- You understand the overlay isolation bar: no smuggling overlay metadata into IMAP
- You understand the headless-first / agent-first design requirement
- You understand the phase sequence: each phase complete before the next starts
- You understand that we do NOT run our own mail server; existing mailboxes (Gmail, Outlook, etc.) are the source of truth

Ask no clarifying questions. Begin.
