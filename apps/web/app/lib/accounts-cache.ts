import { listAccounts, type AccountSummary } from "./oauth-client";

let cachedAccounts: AccountSummary[] | null = null;

export function getCachedAccounts(): AccountSummary[] | null {
  return cachedAccounts;
}

export async function loadAccountsCached(
  options: { force?: boolean } = {},
): Promise<AccountSummary[]> {
  if (cachedAccounts && !options.force) return cachedAccounts;
  cachedAccounts = await listAccounts();
  return cachedAccounts;
}
