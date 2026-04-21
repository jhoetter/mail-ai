# Release pipeline

Mirrors the office-ai pipeline (see [`office-ai/docs/release-pipeline.md`](../../office-ai/docs/release-pipeline.md)) so the hof-os integration is symmetric.

```
push to main
   ↓
verify (pnpm verify, includes bundle:dry-run)
   ↓
release: bump every publishable package via scripts/bump-version.mjs
   ↓ commit "chore: bump to X.Y.Z [skip ci]"
   ↓ tag vX.Y.Z, push
   ↓ pnpm install (refresh lockfile after bump)
   ↓ pnpm build
   ↓ pnpm --filter @mailai/agent          --prod deploy → self-contained dir
   ↓ pnpm --filter @mailai/react-app      --prod deploy → self-contained dir
   ↓ tar czf mailai-agent-X.Y.Z.tgz …
   ↓ tar czf mailai-react-app-X.Y.Z.tgz …
   ↓ gh release create vX.Y.Z {agent,react-app}-X.Y.Z.tgz
   ↓
notify-hof-os: rewrite infra/mailai.lock.json → push to hof-os/main
   ↓
hof-os sandbox build  curls mailai-agent-X.Y.Z.tgz       (CLI for agents)
hof-os data-app/ui    postinstall pulls
                      mailai-react-app-X.Y.Z.tgz         (browser embed)
```

**Status:** scaffolded. Bump script and dry-run script exist. The `notify-hof-os` step is intentionally not wired in this milestone; mail-ai will go through several internal releases before opening that PR against hof-os.
