# mail-ai specs

This directory contains the durable design — the kind of writing the team will reference six months from now to remember _why_. Each Phase produces a fresh batch of specs alongside its build.

## Layout

```
spec/
├── shared/                  ← cross-cutting, owned by no one package
│   ├── architecture.md      ← layers, dependency rules
│   ├── data-model.md        ← entity dictionary
│   ├── command-bus.md       ← THE seam
│   ├── plugin-system.md     ← how layers register handlers
│   ├── security-model.md    ← threats + mitigations
│   └── agent-api.md         ← MailAgent contract for human + AI
├── imap-sync/               ← Phase 1
│   ├── analysis.md
│   ├── architecture.md
│   ├── algorithms.md
│   ├── edge-cases.md
│   └── test-strategy.md
├── overlay/                 ← Phase 2 (added in that phase)
├── collaboration/           ← Phase 3
├── agent/                   ← Phase 4
└── frontend/                ← Phase 5
```

## How to read

Start with `shared/architecture.md` for the big picture, then walk into the
phase-specific folder for the area you're working on. Specs link out to the
implementation files in `packages/` so you can jump from "why" to "how" in
one click.

## How to contribute

Specs are PR'd alongside code. A spec change without a code change is
allowed (clarification); a code change that contradicts an existing spec
must update the spec in the same PR. The reviewer's job is to enforce
that contract.
