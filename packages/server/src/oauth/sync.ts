// Initial / on-demand REST sync for OAuth-connected accounts.
//
// This is the bridge between an `oauth_accounts` row (which Nango
// hands us during onboarding) and the `oauth_messages` table the
// inbox UI reads from. It walks a configurable set of well-known
// folders via the MailProvider port, paginates each one, and
// upserts the normalized rows.
//
// Deliberately small surface:
//   - one entry point: `syncOauthAccount`
//   - reads/refreshes tokens via @mailai/oauth-tokens
//   - lists messages exclusively via @mailai/providers (no
//     gmail.ts / graph.ts imports here — the registry hides them)
//   - writes via OauthMessagesRepository + OauthAccountsRepository.markSync
//   - returns counts so the UI can show "Synced 27 messages"

import {
  type OauthAccountRow,
  type OauthAccountsRepository,
  type OauthMessageInsert,
  type OauthMessageProvider,
  type OauthMessagesRepository,
} from "@mailai/overlay-db";
import {
  getValidAccessToken,
  type ProviderCredentials,
} from "@mailai/oauth-tokens";
import type {
  DeltaWatermark,
  MailProvider,
  MailProviderRegistry,
  NormalizedMessage,
  WellKnownFolder,
} from "@mailai/providers";

// All three repos must be created inside the SAME `withTenant`
// transaction so RLS sees `mailai.tenant_id` set and the token-refresh
// writes + message upserts + sync bookkeeping land atomically.
export interface SyncDeps {
  readonly accounts: OauthAccountsRepository;
  readonly messages: OauthMessagesRepository;
  readonly credentials: ProviderCredentials;
  readonly providers: MailProviderRegistry;
  // Number of messages per folder per page (default 100, the
  // Gmail/Graph max).
  readonly pageSize?: number;
  // Hard cap on pages walked per folder per sync. Keeps a runaway
  // first sync (or a backfill) from spinning forever; the scheduler
  // can override per call.
  readonly maxPagesPerFolder?: number;
  // Which well-known folders to walk. Default mirrors what end users
  // actually look at: Inbox + Sent + Drafts. The scheduler can pass
  // {trash, spam, archive} for explicit backfills.
  readonly folders?: ReadonlyArray<WellKnownFolder>;
  // Force a full listMessages walk even when a delta watermark is
  // present. Used by the manual `Backfill` button so power users
  // can re-baseline a divergent mailbox without dropping the
  // watermark by hand.
  readonly forceFull?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface SyncResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  // Number of rows soft-deleted via the delta path. Always 0 for
  // listMessages-only syncs.
  readonly deleted: number;
  readonly durationMs: number;
  // Which path the sync took. "delta" means the adapter's pullDelta
  // returned a usable watermark; "full" means we walked listMessages.
  // The scheduler emits this in its sync event for diagnostics.
  readonly mode: "delta" | "full";
  // Per-folder breakdown so the UI can show "Inbox 27 / Sent 4".
  // Folders the provider doesn't expose (Gmail's "archive") report
  // 0 and are skipped silently. Empty for delta syncs because the
  // delta path doesn't iterate folders.
  readonly perFolder: ReadonlyArray<{
    readonly folder: WellKnownFolder;
    readonly fetched: number;
  }>;
}

const DEFAULT_FOLDERS: ReadonlyArray<WellKnownFolder> = [
  "inbox",
  "sent",
  "drafts",
];
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_FOLDER = 5;

export async function syncOauthAccount(
  account: OauthAccountRow,
  deps: SyncDeps,
): Promise<SyncResult> {
  const t0 = Date.now();

  try {
    const accessToken = await getValidAccessToken(account, {
      tenantId: account.tenantId,
      accounts: deps.accounts,
      credentials: deps.credentials,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    const provider = deps.providers.for(account.provider);

    // Decide the sync mode.
    //
    // 1. Force-full overrides everything (used by the Backfill button).
    // 2. Otherwise, if the provider advertises delta and we have a
    //    persisted watermark, run pullDelta. On a successful pull we
    //    persist the new watermark and return — fast path, ~one round
    //    trip per provider per tick.
    // 3. Otherwise, walk listMessages over the requested folder set.
    //    On the first walk we also baseline the watermark so the next
    //    tick can take the delta path.
    // The adapter knows which delta column (historyId for Gmail,
    // deltaLink for Graph) to read; the helper just consults
    // capabilities and forwards the row.
    const watermark = provider.readWatermark(account);
    const tryDelta =
      !deps.forceFull && provider.capabilities.delta && watermark !== null;

    if (tryDelta) {
      const delta = await runDeltaSync(account, provider, deps, watermark, accessToken);
      if (delta) {
        await deps.accounts.markSync(account.tenantId, account.id, {
          at: new Date(),
          error: null,
        });
        return { ...delta, durationMs: Date.now() - t0 };
      }
      // pullDelta returned null nextWatermark with a non-null `since`
      // → watermark expired. Clear it and fall through to the full
      // walk so the next tick re-baselines.
      await deps.accounts.setWatermark(account.tenantId, account.id, {
        historyId: null,
        deltaLink: null,
      });
    }

    const full = await runFullSync(account, provider, deps, accessToken);

    // Baseline the watermark on the way out so the next tick can take
    // the delta path. Best-effort: if pullDelta(null) fails for some
    // reason, we just stay on the full-walk path next time.
    if (provider.capabilities.delta) {
      try {
        const baseline = await provider.pullDelta({
          accessToken,
          since: null,
        });
        if (baseline.nextWatermark) {
          await deps.accounts.setWatermark(account.tenantId, account.id, {
            historyId:
              baseline.nextWatermark.kind === "gmail"
                ? baseline.nextWatermark.historyId
                : null,
            deltaLink:
              baseline.nextWatermark.kind === "graph"
                ? baseline.nextWatermark.deltaLink
                : null,
          });
        }
      } catch {
        // Non-fatal — full sync already succeeded.
      }
    }

    await deps.accounts.markSync(account.tenantId, account.id, {
      at: new Date(),
      error: null,
    });
    return { ...full, durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await deps.accounts
      .markSync(account.tenantId, account.id, { at: new Date(), error: msg })
      .catch(() => undefined); // never let bookkeeping mask the real error
    throw err;
  }
}

async function runDeltaSync(
  account: OauthAccountRow,
  provider: MailProvider,
  deps: SyncDeps,
  since: DeltaWatermark,
  accessToken: string,
): Promise<Omit<SyncResult, "durationMs"> | null> {
  const result = await provider.pullDelta({ accessToken, since });
  if (!result.nextWatermark) {
    // Either expired or the adapter declined; caller falls back.
    return null;
  }

  // Inserted + updated rows go through the same idempotent upsert.
  // We trust the adapter to put each row in the right wellKnownFolder.
  const rows: OauthMessageInsert[] = [];
  for (const m of result.inserted) {
    rows.push(toInsertRow(account, m, m.wellKnownFolder));
  }
  for (const m of result.updated) {
    rows.push(toInsertRow(account, m, m.wellKnownFolder));
  }
  const counts = rows.length > 0
    ? await deps.messages.upsertMany(rows)
    : { inserted: 0, updated: 0 };

  const deletedCount =
    result.deleted.length > 0
      ? await deps.messages.markDeleted(
          account.tenantId,
          account.id,
          result.deleted,
        )
      : 0;

  await deps.accounts.setWatermark(account.tenantId, account.id, {
    historyId:
      result.nextWatermark.kind === "gmail"
        ? result.nextWatermark.historyId
        : null,
    deltaLink:
      result.nextWatermark.kind === "graph"
        ? result.nextWatermark.deltaLink
        : null,
  });

  return {
    fetched: rows.length,
    inserted: counts.inserted,
    updated: counts.updated,
    deleted: deletedCount,
    mode: "delta",
    perFolder: [],
  };
}

async function runFullSync(
  account: OauthAccountRow,
  provider: MailProvider,
  deps: SyncDeps,
  accessToken: string,
): Promise<Omit<SyncResult, "durationMs">> {
  const folders = deps.folders ?? DEFAULT_FOLDERS;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = deps.maxPagesPerFolder ?? DEFAULT_MAX_PAGES_PER_FOLDER;

  // Ask the adapter which folders it actually supports for this
  // account before walking the requested set. Adapters return a
  // null providerFolderId for folders they can't list (e.g.
  // Gmail's "archive") so we skip them without an empty round-trip.
  const supported = await provider.listFolders({ accessToken });
  const supportedSet = new Set(
    supported
      .filter((f) => f.providerFolderId !== null)
      .map((f) => f.wellKnownFolder),
  );

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const perFolder: { folder: WellKnownFolder; fetched: number }[] = [];

  for (const folder of folders) {
    if (!supportedSet.has(folder)) {
      perFolder.push({ folder, fetched: 0 });
      continue;
    }
    let cursor: string | null = null;
    let pages = 0;
    let folderFetched = 0;
    while (pages < maxPages) {
      const page = await provider.listMessages({
        accessToken,
        folder,
        pageSize,
        cursor,
      });
      if (page.messages.length === 0) break;
      const rows = page.messages.map((m) => toInsertRow(account, m, folder));
      const counts = await deps.messages.upsertMany(rows);
      totalFetched += rows.length;
      totalInserted += counts.inserted;
      totalUpdated += counts.updated;
      folderFetched += rows.length;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      pages += 1;
    }
    perFolder.push({ folder, fetched: folderFetched });
  }

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    deleted: 0,
    mode: "full",
    perFolder,
  };
}

// Pure projection of a NormalizedMessage onto an OauthMessageInsert.
// Exported for the scheduler / delta sync (Phase 6) which writes
// rows from pullDelta() into the same table.
export function toInsertRow(
  account: OauthAccountRow,
  m: NormalizedMessage,
  folder: WellKnownFolder,
): OauthMessageInsert {
  return {
    id: `om_${crypto.randomUUID()}`,
    tenantId: account.tenantId,
    oauthAccountId: account.id,
    // Account.provider has the same union as OauthMessageProvider —
    // a runtime cast is safe and keeps the overlay-db package free
    // of @mailai/providers as a peer dep.
    provider: account.provider as OauthMessageProvider,
    providerMessageId: m.providerMessageId,
    providerThreadId: m.providerThreadId,
    subject: m.subject,
    fromName: m.from?.name ?? null,
    fromEmail: m.from?.email ?? null,
    toAddr:
      m.to.length > 0
        ? m.to.map((a) => a.email).join(", ")
        : null,
    snippet: m.snippet,
    internalDate: m.internalDate,
    labelsJson: [...m.userLabels],
    unread: m.flags.includes("unread"),
    wellKnownFolder: folder,
  };
}
