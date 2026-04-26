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
   ↓ pnpm run hofos:check && pnpm run hofos:harness
   ↓ pnpm run export:hofos-ui             → runtime source export
   ↓ tar czf mailai-agent-X.Y.Z.tgz …
   ↓ gh release create vX.Y.Z mailai-agent-X.Y.Z.tgz
   ↓
notify-hof-os: open PR importing the hofOS runtime source export
   ↓
hof-os sandbox build  curls mailai-agent-X.Y.Z.tgz       (CLI for agents)
hof-os data-app/ui    ships native source from
                      packages/hof-components/modules/mailai
```

The browser UI publishing model is documented in
[`hofos-native-ui.md`](./hofos-native-ui.md). The retired
`@mailai/react-app` bundle should not be reintroduced for hofOS.
