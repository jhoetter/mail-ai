# Embed contract — `@mailai/react-app` (Phase 5 spec)

`@mailai/react-app` is the embeddable React surface. It ships as a
versioned tarball + UMD/ESM bundle so a host (hof-os, an internal
portal, anyone) can drop the entire mail-ai UI into an existing
React tree without spinning up a Next process.

## Shape

```ts
import { MailAiApp, type MailAiHostHooks } from "@mailai/react-app";

<MailAiApp
  baseUrl="https://mail.example.com"
  hooks={{
    getAuthToken: async () => myHostAuth.token(),
    onUnauthorized: () => myHostAuth.signIn(),
    navigate: (path) => myHostRouter.push(path),
    requestThemeOverride: () => ({ accent: "#5b6cff" }),
  }}
/>;
```

`MailAiApp` is the **only** public component. Sub-components are
intentionally not exported: the host owns the chrome (top bar,
nav), the embed owns the mail body. Letting hosts pick-and-choose
sub-components would couple us to their layout assumptions.

## Host hooks

| Hook                   | Required | Purpose                                                                                  |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `getAuthToken`         | yes      | Returns a Bearer token for `HttpAgentClient`. Async to allow refresh.                    |
| `onUnauthorized`       | yes      | Called when the API returns 401; the host decides what to do (re-auth, sign out, etc.).  |
| `navigate`             | yes      | URL changes are delegated to the host's router so deep links integrate cleanly.          |
| `requestThemeOverride` | no       | Lets the host tint the UI to match its design system.                                    |
| `onMutation`           | no       | Notifies the host of every applied mutation, so it can update its own counters / badges. |

Hooks are intentionally narrow: anything not on this list, the host
cannot influence. That keeps the embed contract auditable.

## Versioning

- The package is published to GitHub Releases as a tarball
  (`mail-ai-react-app-<version>.tgz`) and as a single-file
  `mail-ai-react-app-<version>.umd.js` for non-bundling hosts.
- Semver: breaking changes to `MailAiHostHooks` or to `MailAiApp`
  props are major. Adding optional hooks is minor.
- A `mailai.lock.json` in the host repo pins the embed version +
  shasum (see `infra/mailai.lock.json` for the schema).

## What lives in the bundle vs. peer

- **Bundled**: React-tree code, `@mailai/agent`'s `HttpAgentClient`,
  `@mailai/ui`, design tokens.
- **Peer-deps**: `react`, `react-dom`. The host owns the React
  runtime; we never ship a second copy.
- **Excluded**: `next/*`, `@mailai/server`, `@mailai/imap-sync`,
  any DB driver. The embed talks HTTP only.

## Why this contract

The embed is the seam that lets mail-ai land inside hof-os without
either project owning the other. A small, typed hook surface plus
a single component is the smallest contract that satisfies "drop
this into a React tree and it just works"; expanding it later is
much cheaper than retracting it.
