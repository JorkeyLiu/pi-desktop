# Browser preview focus fixture

Standalone Electron fixture (`browser-preview-focus.ts`, run via
`scripts/e2e-browser-preview-focus.mjs`). It reproduces the production
preview lifecycle with a real `BrowserHost` + `BrowserPane`: shell window
with a focused editable field, chrome attach, guest surface attach,
file/http navigation, session-tab reuse, live reload, and a
takeover round-trip.

## What it proves

- First open, tab reuse, and live reload of a file or http preview keep
  keyboard focus (and the shell selection) in the shell editor.
- A CDP-driven agent click still lands in the guest page.
- The armed production watch plus the native focus transfer hand focus to a
  user press into the preview, and a navigation started while the guest owns
  focus never yanks focus back to the shell.
- A real keystroke after the round-trip still lands in the composer.

## Honest limits

- No synthetic OS pointer: `sendInputEvent` from a `WebContents` moves no
  native focus (measured: zero focus change, zero `before-input-event` on
  the guest for window-level dispatch). The takeover stage therefore drives
  the native half directly with `guest.focus()` — the same endpoint a Views
  hit-test resolves to — while the guard stays armed, and records
  `before-mouse-event` delivery for the synthetic press half.
- Direct OS-pointer click into the isolated native view remains unproven;
  the fixture proves the armed production handler plus the native transfer,
  not the full OS click path.
- Native focus theft is intermittent (activation flicker in headless runs):
  phases without an observed steal pass trivially. `stealAtMs` fields in
  `results.json` record which phases actually stole; a green run with all
  `stealAtMs` null proves the checks but not the restore. The restore itself
  is proven by runs where theft lands (guest `focus` events followed by
  owner recovery) and by `apps/desktop/test/browser-pane-focus.test.mjs`.
- Window-level synthetic clicks are diagnostic only: they route to the
  shell contents, never to the guest through Views hit-testing.
