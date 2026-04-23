# Keyboard shortcuts (Phase 5 spec)

The web UI is keyboard-first. Shortcuts mirror gmail/superhuman
conventions where they exist; mail-ai-specific actions are
namespaced under `g` (go-to) and `c` (collaboration).

## Global

| Key          | Action                     |
| ------------ | -------------------------- |
| `?`          | Show this cheat sheet      |
| `g i`        | Go to inbox                |
| `g s`        | Go to search               |
| `g p`        | Go to pending approvals    |
| `g a`        | Go to settings → audit     |
| `Cmd/Ctrl+K` | Quick-jump command palette |
| `Esc`        | Close modal / blur input   |

## Thread list

| Key       | Action                                      |
| --------- | ------------------------------------------- |
| `j` / `k` | Next / previous thread                      |
| `Enter`   | Open selected thread                        |
| `x`       | Toggle selection                            |
| `e`       | Archive (move to overlay status `archived`) |
| `s`       | Snooze prompt                               |
| `r`       | Mark resolved                               |
| `a`       | Assign to… (opens picker)                   |
| `u`       | Mark unread                                 |
| `Shift+u` | Mark read                                   |
| `t`       | Add tag…                                    |

## Thread view

| Key         | Action                              |
| ----------- | ----------------------------------- |
| `r`         | Reply                               |
| `Shift+R`   | Reply all                           |
| `f`         | Forward                             |
| `c`         | Add comment (focuses comment box)   |
| `@`         | Inside comment: open mention picker |
| `]` / `[`   | Next / previous message             |
| `Cmd+Enter` | Send compose / submit comment       |

## Pending approvals

| Key       | Action                      |
| --------- | --------------------------- |
| `j` / `k` | Next / previous pending     |
| `y`       | Approve highlighted         |
| `n`       | Reject (prompts for reason) |

## Accessibility notes

- Shortcuts are registered via a single `useShortcut` hook so they
  auto-disable inside text inputs and are exposed to screen
  readers via `aria-keyshortcuts` on the activating control.
- Every shortcut's action MUST also be reachable via a focusable
  control (no keyboard-only features).
