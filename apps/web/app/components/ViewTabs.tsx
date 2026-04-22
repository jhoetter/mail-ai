// View selection lives in the URL search param `?view=<id>`. The
// MailViewsNav block in the sidebar (apps/web/app/components/AppNav.tsx)
// renders one nav link per view; the Inbox component reads the
// active id from here and re-fetches when it changes.
//
// We intentionally do NOT keep a localStorage mirror — the URL is
// the single source of truth so deep links and reloads land users
// on the same view they were looking at, and so palette navigation
// (which uses navigate("/inbox?view=…")) doesn't fight a stored
// value.

import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";

export function useActiveView(): {
  viewId: string | null;
  setViewId: (id: string | null) => void;
} {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get("view");
  const viewId = raw && raw !== "null" ? raw : null;
  const setViewId = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set("view", id);
      else next.delete("view");
      const qs = next.toString();
      navigate(qs ? `/inbox?${qs}` : "/inbox", { replace: false });
    },
    [navigate, params],
  );
  return { viewId, setViewId };
}
