# Accessibility (Phase 5 spec)

mail-ai targets WCAG 2.2 AA at v1. The bar is enforced via
`@axe-core/react` smoke tests in CI plus manual review for
keyboard-only flows.

## Non-negotiables

- **Keyboard reachability**: every action invocable from the UI
  has a Tab-reachable control AND a documented shortcut. No
  pointer-only features.
- **Focus management**: opening a panel/dialog moves focus into
  it; closing returns focus to the trigger.
- **ARIA roles**: lists use `role="listbox"` with
  `aria-activedescendant`; the thread reading area uses
  `role="article"`; dialogs are `role="dialog"` with
  `aria-modal="true"` and a focus trap.
- **Color contrast**: ≥ 4.5:1 for body text, ≥ 3:1 for large text
  and UI icons. Tokens in `@mailai/design-tokens` are picked to
  meet this in both light and dark themes.
- **Reduced motion**: respect `prefers-reduced-motion`. The
  three-pane resize, toast slide-ins, and "thread loaded" pulse
  animation all collapse to instant transitions.
- **Screen reader announcements**: status changes ("Thread
  resolved", "Approved 3 mutations") are announced via an
  `aria-live="polite"` region.

## Testing

- `pnpm --filter @mailai/web test:a11y` runs `@axe-core/playwright`
  against the rendered shell at the four primary routes.
- Manual checklist per release: tab through inbox + thread + pending
  flows with VoiceOver and NVDA; verify all shortcuts work without
  modifier-key confusion.

## Why this matters for an embed

`@mailai/react-app` ships into hosts whose existing shells already
have a focus model and shortcut surface. By holding ourselves to
WCAG AA we keep our integration cheap: the host is unlikely to
need to override our roles or aria attributes.
