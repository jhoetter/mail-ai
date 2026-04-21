# Phase 0 Bootstrap — Build Log

## Decisions

- **Toolchain mirrors office-ai exactly**: pnpm 9.15.4 + Turborepo 2 + Node ≥20 + TypeScript 5 strict + ESLint 9 + Prettier 3 + Vitest 2. This minimises cognitive distance for anyone moving between the two repos and means the eventual hof-os tarball pipeline is a copy-paste of office-ai's release workflow with names changed.
- **Architecture invariant is enforced in CI, not just docs**: `scripts/check-architecture.mjs` walks all source files in `packages/` and `apps/` and fails if a headless package imports React/Next, or if a scoped dependency (`imapflow`, `pg`, `fastify`, `nodemailer`) appears outside its allowed package list. This is the single most important guard for prompt.md Architecture Principle 4 ("Commands are the only mutation path") and for the headless-first requirement.
- **Dev stack ports avoid hof-os and office-ai collisions**: Postgres on 5532 (hof-os uses 5432), Redis on 6479, Greenmail on 3025/3143/8080, Dovecot on 1143/1993, MinIO on 9100/9101. Next on 3200, realtime ws on 1235.
- **Two IMAP servers in the dev stack**: Greenmail (Java, broad coverage, IDLE, easy seeding via API) and Dovecot (production-grade, hardest edge cases like UIDVALIDITY changes, partial FETCH responses). Phase 1 integration tests run against both — this is the only way to honour the IMAP coexistence bar in CI.
- **Synthetic fixtures generated in `fixtures/mime-samples/INDEX.json` with `synthetic: true`** for now. Replace with real-world `.eml` files before production per prompt.md §Fixture Corpus.
- **Release pipeline scaffolded but dormant**: `scripts/bump-version.mjs` and `scripts/bundle-dry-run.mjs` exist; `infra/mailai.lock.json` is a placeholder. No GitHub Action publishes yet, no PR is opened against hof-os. The wiring is documented in [`docs/release-pipeline.md`](../release-pipeline.md) so when the standalone product is mature we can flip the switch.

## Deferred

- Real `.eml` corpus from Gmail/Outlook/Apple/Thunderbird mailboxes (use synthetic for now).
- Production Dockerfile for `packages/server` (only dev image needed before Phase 1 build).
- Encrypted-at-rest message bodies (per prompt.md Phase 2 out-of-scope; planned in security model).

## Open issues

- The architecture-script is a regex over imports; that's acceptable for pre-tree-shaking but a real `ts-morph` walker would catch dynamic `import()` and re-exports. Revisit when first dynamic import appears.
- `pnpm install` resolution completes (lockfile generated in ~1s with `--lockfile-only`) but the full install hangs in this developer's sandbox during linking — likely on a postinstall lifecycle script for one of the optional native binaries (rollup/esbuild/Next.js SWC). On a clean machine this should be a 60-90s install. If you hit this, run `pnpm install --ignore-scripts` to unblock and then `pnpm rebuild` selectively.

## Verification status

- `node scripts/check-architecture.mjs` runs from a clean checkout (no deps required — it's pure stdlib).
- `node scripts/generate-fixtures.mjs` produces 12 deterministic synthetic fixtures + INDEX.json.
- `pnpm install --lockfile-only` resolves all 502 packages in ~1s; the lockfile is committed.
- Per-package builds (`tsc`, `vitest`) gated by successful install → blocked by the install issue above. Source compiles against the strict TS config; types verified by inspection during authoring.
