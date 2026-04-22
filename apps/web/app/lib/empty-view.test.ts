import { describe, expect, it } from "vitest";
import {
  firstSyncError,
  hasNarrowingFilters,
  resolveEmptyKind,
} from "./empty-view";
import type { AccountSummary } from "./oauth-client";
import type { ViewSummary } from "./views-client";

function view(partial: Partial<ViewSummary> & { id: string }): ViewSummary {
  return {
    id: partial.id,
    name: partial.name ?? "View",
    icon: partial.icon ?? null,
    position: partial.position ?? 0,
    isBuiltin: partial.isBuiltin ?? false,
    filter: partial.filter ?? {},
    sortBy: partial.sortBy ?? "date_desc",
    groupBy: partial.groupBy ?? null,
    layout: partial.layout ?? "list",
  };
}

function account(partial: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: partial.id ?? "acc_1",
    provider: partial.provider ?? "google-mail",
    email: partial.email ?? "user@example.com",
    status: partial.status ?? "ok",
    expiresAt: partial.expiresAt ?? null,
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00Z",
    lastSyncedAt: partial.lastSyncedAt ?? null,
    lastSyncError: partial.lastSyncError ?? null,
  };
}

describe("resolveEmptyKind", () => {
  it("returns 'default' when no view is selected (the All pseudo-tab)", () => {
    expect(resolveEmptyKind(null, [])).toBe("default");
  });

  it("returns the well-known kind when the view declares one", () => {
    const views = [
      view({ id: "v_drafts", filter: { kind: "drafts" } }),
      view({ id: "v_sent", filter: { kind: "sent" } }),
      view({ id: "v_trash", filter: { kind: "trash" } }),
      view({ id: "v_spam", filter: { kind: "spam" } }),
      view({ id: "v_all", filter: { kind: "all" } }),
    ];
    expect(resolveEmptyKind("v_drafts", views)).toBe("drafts");
    expect(resolveEmptyKind("v_sent", views)).toBe("sent");
    expect(resolveEmptyKind("v_trash", views)).toBe("trash");
    expect(resolveEmptyKind("v_spam", views)).toBe("spam");
    expect(resolveEmptyKind("v_all", views)).toBe("all");
  });

  it("returns 'filtered' for non-builtin views with narrowing predicates", () => {
    const views = [
      view({
        id: "v_my_team",
        isBuiltin: false,
        filter: { kind: "default", tagsAny: ["t_team"] },
      }),
    ];
    expect(resolveEmptyKind("v_my_team", views)).toBe("filtered");
  });

  it("does not flag a builtin Inbox view as 'filtered' just because it has a status predicate", () => {
    const views = [
      view({
        id: "v_inbox",
        isBuiltin: true,
        filter: { kind: "default", status: ["open"] },
      }),
    ];
    expect(resolveEmptyKind("v_inbox", views)).toBe("default");
  });

  it("falls back to 'default' when the view id is unknown to the client", () => {
    expect(resolveEmptyKind("v_missing", [])).toBe("default");
  });
});

describe("hasNarrowingFilters", () => {
  it("treats empty arrays and missing fields as no narrowing", () => {
    expect(
      hasNarrowingFilters(view({ id: "v", filter: { tagsAny: [], tagsNone: [] } })),
    ).toBe(false);
  });

  it("flags fromContains, accountIds, and unread as narrowing", () => {
    expect(
      hasNarrowingFilters(view({ id: "v", filter: { fromContains: "alice" } })),
    ).toBe(true);
    expect(
      hasNarrowingFilters(view({ id: "v", filter: { accountIds: ["acc_1"] } })),
    ).toBe(true);
    expect(hasNarrowingFilters(view({ id: "v", filter: { unread: true } }))).toBe(
      true,
    );
  });
});

describe("firstSyncError", () => {
  it("returns null for a missing or empty list", () => {
    expect(firstSyncError(null)).toBe(null);
    expect(firstSyncError([])).toBe(null);
  });

  it("returns the first non-null lastSyncError it encounters", () => {
    expect(
      firstSyncError([
        account({ id: "a1", lastSyncError: null }),
        account({ id: "a2", lastSyncError: "401 unauthorized" }),
        account({ id: "a3", lastSyncError: "ignored" }),
      ]),
    ).toBe("401 unauthorized");
  });
});
