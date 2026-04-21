import { jsx as _jsx } from "react/jsx-runtime";

export function LoadingBlank() {
  return _jsx("div", { className: "p-8 text-muted text-sm", children: "Loading mail-ai…" });
}

export function EmptyInboxBlank() {
  return _jsx("div", { className: "p-8 text-muted text-sm", children: "No threads in this view." });
}
