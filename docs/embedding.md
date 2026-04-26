# Embedding mail-ai

> Deprecated for hofOS browser UI: hofOS now consumes MailAI as native
> runtime source under `packages/hof-components/modules/mailai`, not as a
> standalone embedded React app. Use
> [`hofos-native-ui.md`](./hofos-native-ui.md) for the current workflow.

mail-ai is built and shipped as a **standalone product** (Next.js shell + Node backend + Postgres + Redis + IMAP/SMTP). The same source tree also produces a **publishable React embed package** (`@mailai/react-app`) and a **headless agent CLI** (`mail-agent`) so that downstream products — most importantly **hof-os** — can wrap mail-ai without forking it.

This document describes the embedding contract. It is the analogue of [office-ai/docs/embedding.md](https://github.com/jhoetter/office-ai) and is designed so the future hof-os integration is a configuration change, not a refactor.

## Two artifacts (mirroring office-ai)

```
mailai-agent-X.Y.Z.tgz          # Node CLI, runs in any Docker sandbox.
                                # Same MailAgent SDK as the in-process API.
                                # Bin: `mail-agent` (commander), `mail-agent mcp` (MCP stdio).

mailai-react-app-X.Y.Z.tgz      # React 19 components, esbuild-bundled.
                                # Subpath exports:
                                #   /components/inbox       Inbox shell
                                #   /components/thread      Thread detail
                                #   /components/compose     Composer
                                #   /styles.css             Global tokens
                                #   /contract               Host-hook types
                                #   /blanks                 Empty/loading states
```

Both are produced by `pnpm bump-version <X.Y.Z> && pnpm build && pnpm pack` (CI workflow lives in `.github/workflows/release.yml` once authored).

## Host hooks (the only seams)

Every embedded mail-ai surface accepts a contract object. Hosts implement it; mail-ai never reaches into host state.

```ts
import type { EmbeddedMailaiProps } from "@mailai/react-app/contract";

interface EmbeddedMailaiProps {
  // Identity (passed through to presence + audit log).
  presenceUser: { id: string; name: string; color?: string };

  // API location. mail-ai does NOT call window.fetch on the host's behalf;
  // it always uses these endpoints.
  apiUrl: string;
  wsUrl: string;

  // Auth: host returns a token (Bearer) for every call. Refresh is the
  // host's job; mail-ai never persists credentials in the browser.
  onAuth(): Promise<{ token: string; expiresAt: number }>;

  // Outbound mail policy. Host can intercept every mail:send before it
  // actually leaves; lets hof-os enforce DLP / signature insertion / etc.
  onBeforeSend?(draft: {
    to: string[];
    subject: string;
    bodyHash: string;
  }): Promise<"allow" | "deny">;

  // Mount point — used so the embedded app routes inside the host's
  // shell rather than hijacking window.history.
  mountPath: string;
}
```

## hof-os integration recipe (future, not built in this plan)

When mail-ai standalone is mature:

1. Cut a release tag in mail-ai. CI publishes both tarballs to a GitHub Release.
2. CI then opens a PR against hof-os updating [`infra/mailai.lock.json`](../infra/mailai.lock.json) with `{ tag, sha256, url }` for each artifact.
3. In hof-os:
   - **CLI tarball**: extracted into a `hof-skill-base-mailai` Docker image (analogue of [`infra/docker/Dockerfile.officeai-sandbox`](../../hof-os/infra/docker/Dockerfile.officeai-sandbox)). Used by sandbox jobs and hof-engine functions to drive mail-ai programmatically.
   - **React tarball**: a `postinstall` script in `packages/hof-components/data-app/ui` extracts it into `node_modules/@mailai/react-app/` (analogue of [`ensure-officeai-react-editors.cjs`](../../hof-os/packages/hof-components/data-app/ui/scripts/ensure-officeai-react-editors.cjs)). The hof-os SPA then imports `@mailai/react-app/components/inbox` from a route page.
   - Add the new route to `STANDALONE_PATHS` in [`ShellRouter.tsx`](../../hof-os/packages/hof-components/modules/app-shell/ui/ShellRouter.tsx) so the hof-os chrome steps aside.
4. **mail-ai backend deploys as its own service** alongside hof-os. hof-os passes its session JWT into the embed via `onAuth`; the mail-ai backend validates against the same shared JWKS as hof-os auth. **No FastAPI router changes** in hof-os in this milestone.

This plan does not touch hof-os. Step 4 is sketched here so the contract types and release pipeline are designed for it from day one.

## What we explicitly do NOT do

- **No iframe**: same SPA, same bundle.
- **No module federation**: tarballs only, like office-ai.
- **No copying mail-ai backend code into hof-os**: backend is a separate service; the only crossover is the embed bundle and the agent CLI tarball.
- **No host-side overlay metadata storage**: assignments, comments, status, tags all live in the mail-ai Postgres. hof-os auth identifies the actor; that is the entire integration on the data side.
