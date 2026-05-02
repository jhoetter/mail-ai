const HANDOFF_CODE_PARAM = "__hof_handoff";

export async function consumeHofHandoff(audience: "mailai"): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get(HANDOFF_CODE_PARAM);
  if (!code) return;

  const res = await fetch("/api/subapp-handoff/exchange", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audience, code }),
  });
  if (!res.ok) return;

  url.searchParams.delete(HANDOFF_CODE_PARAM);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
