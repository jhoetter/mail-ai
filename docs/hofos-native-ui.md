# hofOS native UI workflow

MailAI no longer publishes a standalone browser bundle for hofOS. The
browser surface is developed here, checked in a hofOS-mode harness, and
exported as runtime source for `hof-os`.

## Contract

`hofos-ui.config.json` points to `../hof-os/infra/sister-ui-contract.json`.
That contract defines the host routes, `/api/mail` proxy prefix,
dependency compatibility rules, source export folders, and files hofOS
must preserve during import.

Run the gate before exporting:

```sh
pnpm run hofos:check
```

The gate fails on unapproved major-version dependency skew and checks
that the hofOS-mode harness covers these routes:

- `/mail`
- `/mail/inbox`
- `/mail/inbox/thread/example-thread`
- `/mail/settings/account`
- `/calendar`

## Harness

The required hofOS-mode harness command is:

```sh
pnpm run hofos:harness
```

The harness must use the same content constraints as hofOS: natural
`/mail/...` URLs, the `/api/mail` proxy base, runtime config from the
host environment, and the shared Office-AI attachment/editor contract.

## Live hofOS Development

For integrated UI work, run hofOS with the MailAI product runtime aliases
pointed at this checkout:

```sh
cd ../hof-os
HOF_SISTER_UI_OVERLAY=1 MAILAI_UI_SOURCE_PATH=$HOME/repos/mail-ai make dev
```

hofOS still owns the bridge files, auth, proxy, URL state, Assets/S3, and
Office-AI capabilities. This repo owns the product runtime source that is
exported into `modules/mailai/ui/original` and `ui/vendor`.

## Export

Create a deterministic source export:

```sh
pnpm run export:hofos-ui
```

The export lands under `release-out/hofos-ui/mailai-ui-source/` with:

- `files/` containing only runtime source for `ui/original` and `ui/vendor`
- `hofos-ui-export-manifest.json` with source SHA, route contract, exported paths, and contract hash

Import it in `hof-os`:

```sh
cd ../hof-os
pnpm --dir packages/hof-components import:sister-ui ../mail-ai/release-out/hofos-ui/mailai-ui-source
python packages/hof-components/setup.py --app data-app --starter hofos
npm --prefix packages/hof-components/data-app/ui run build
```

The import script replaces only exported runtime folders and preserves
hofOS bridge files such as `ui/pages`, `ui/lib`, `module.json`, and the
module README.
