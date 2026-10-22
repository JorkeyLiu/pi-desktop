# ADR 0331: Browser-anchored upward history

## Status

Accepted.

## Context

Reading upward through a long conversation means two things arrive above the
reading position: the trailing window mounts more of the history that is already
loaded, and the pane fetches an older page of 100 raw messages. Both add height
above the row the reader is looking at, so both move the content under them.

The transcript used to compensate by hand: it captured `scrollHeight` when a page
was requested or the window grew, then added the resulting delta to `scrollTop`
in one layout effect keyed on `messages.length` and `windowSize`. Three things
made that unreliable in practice.

1. The capture belonged to an event, but the commit did not. Entries reach the
   DOM through a deferred projection plus a trailing mount window, so the commit
   that changed a dependency could mount nothing and consume the capture. The
   correction then ran against a later, much larger commit or not at all.
2. Rows were measured on demand. `content-visibility: auto` with
   `contain-intrinsic-size` stood each unmeasured row in with an estimate, so the
   scroller's height was wrong until the row was actually measured. Scrolling up
   re-measured rows and moved the content by the estimate error - measured at
   17-489 px per wheel step with an unchanged row count - and no `scrollTop`
   correction could absorb a height that changed after it ran.
3. A page boundary is a physical offset, not a turn boundary. Prepending a page
   that continues an assistant turn merges the older fragments into the row that
   is already mounted, so the row's own box grows at its top.

## Decision

The transcript's own scrolling box owns the reading position through native
scroll anchoring. Native anchoring cannot cover two states, and one bounded hold
covers exactly those.

Native ownership:

* `.thread-scroll` sets `overflow-anchor: auto`.
* `.message-row` and `.tool-activity-group` keep explicit containment
  (`contain: layout style paint`) and no `content-visibility`; the mounted
  history window, not skipped layout, bounds the cost of a long transcript.
* The scroller's furniture - the history status row, the later boundary, the
  first-commit spacer, the runtime status lane, and the retry row - sets
  `overflow-anchor: none`, so the browser never anchors to a box that is itself
  being inserted or resized above the reader.
* Furniture that sits above the reader also keeps a constant height: the history
  status label stays mounted and is hidden with `visibility`, because mounting
  and unmounting it moved every row below it by its own line box on each page.

The one hold (`apps/desktop/src/lib/transcript-prepend-anchor.ts`):

* Native anchoring performs no adjustment at `scrollTop === 0`, and inside a turn
  a page boundary cuts it anchors on a box other than the fragment in view. In
  both states the reader's row moved by the added height: 9 330 px on this
  fixture, and 5 032.95 px of the 18 712 px a merged turn added.
* So `useTranscriptScroll` records the *visible fragment* - `data-message-id`,
  the innermost row unit, because an outer turn box legitimately grows at its own
  top - together with its viewport offset, before the commit that asks for the
  height. Both escalation steps take that hold once, in `reachTop`.
* The hold is resolved in the layout phase of the commit that actually changed
  the mounted history, keyed on the rendered history rather than on a message
  count or a request. It is measured against the layout the browser has already
  produced, so native anchoring and the hold never compensate twice, and it is
  one write with no `requestAnimationFrame` or `ResizeObserver` loop.
* While a page is in flight the hold is re-read on the reader's own scroll
  events, so a landing is answered with where the reader is now, not with where
  they were when the page was requested.
* The hold is dropped when the pane hides, when a turn re-bottoms the
  transcript, and on search navigation: those own the position instead.

Continuation is unchanged in intent: the top boundary still grows the window and
pages older history, through one gate. Two triggers feed it - a reader gesture or
scroll at the boundary, and the pane's own content commits - and both go through
a gate that re-reads live geometry.

* A content commit continues only while the pane owes what it is showing: it
  holds loaded rows it has not mounted, or its content does not fill the
  viewport. A landed page is therefore not a fresh reach, which is what stops an
  anchored transcript from paging itself in while the reader rests at the top.
* A pane that has presented no row yet is not a reading position at all, so it
  asks for one *initial fill* behind the settle veil (D287) - the cold-open page
  that fills the viewport - and nothing else. It is asked once per pane.
* Hold and selection survive a page that cuts inside a turn: a mounted history
  row is keyed by the turn's *last* fragment, which a prepend cannot change,
  instead of its first fragment. `entry.id` keeps its existing meaning.

## Consequences

* Every upward commit holds the reading row within 1 px - measured at 0.5 px for
  a 9 330 px prepend, 0.47 px for a page that lands mid-scroll, 0.5 px at
  `scrollTop === 0`, and 0.5 px through an 18 712 px merge that grows the row
  being read (`scripts/e2e-upward-anchor.mjs`, asserted per frame with the
  reader's own wheel subtracted).
* Wheel steps no longer change `scrollHeight` while the row count is unchanged,
  because nothing resolves from an estimate.
* A push at the exact top now asks for exactly one thing and leaves the reader an
  offset they can keep reading from, instead of stranding them at 0 while page
  after page lands under them.
* Real heights cost nothing measurable on the fixture: presenting the session
  takes 318-329 ms and mounts 61 rows against 317 ms and 61 rows with estimated
  heights, and a forced layout read stays under 0.1 ms in both.
* Sticky UI inside the transcript relies on the browser's anchor selection, which
  is why the furniture above is excluded explicitly.
* The cold-open initial fill is the one page a pane with nothing presented may
  ask for; it is not a continuation, and it leaves the reader's own reaches as the
  only source of every later page.
