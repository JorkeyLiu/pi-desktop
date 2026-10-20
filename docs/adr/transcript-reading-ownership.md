# ADR transcript-reading-ownership: Share renderer history and search views

- Status: Accepted
- Date: 2026-09-13
- Amends: [ADR session-content-search](/adr/session-content-search)

## Context

Search navigation added a pane-local controller alongside ordinary history
paging, a global target handoff, and live/model caches. These independent paths
needed separate cancellation and rewrite handling. Nested assistant answers
were searchable but had no top-level transcript row, while Markdown could hide
the source characters that matched a query.

## Decision

The renderer store owns one transient `TranscriptView` per retained session.
Ordinary paging and search use the same read actions and physical cursors;
MainChat and the subagent dock use the same projection. The pending view's
identity owns an asynchronous read. Replacement, eviction, return to latest,
canonical edits, and a new turn invalidate stale target or page completions.
Ordinary history always uses the current canonical value for overlapping rows,
including streaming-to-complete transitions. Explicit search retains its
selected historical snapshot until the user leaves it or starts a turn.

Reading forward is a boundary, not a control. Both the near-top and the
near-bottom bands page the window, so a reader never has to press anything to
see what comes next, and reaching the newest message ends the historical range
so live output resumes in place. A forward page needs the exclusive physical
end of the current window: a view without one — a remote older-only cursor, or
a restored range whose metadata is incomplete — re-reads the newest bounded
page instead of deriving an offset that would address the transcript's head. A
forward page that adds nothing, or that fails, disarms automatic paging; a
failure additionally waits for one explicit retry. A range restored while a
turn is already streaming keeps its rows and resumes live output when that turn
ends, because the turn began before the "new turn" boundary could apply to it.
An uncapped read replaces the transcript with the whole conversation and
therefore publishes the matching full window; the previous page cursors do not
survive it. A reading window never pins the reader: the latest control stays
available the whole time.

Reading views never populate runtime/model caches. A message action hydrates
canonical input when history is partial or display-limited, then rechecks the
session, run, navigation, and message-snapshot ownership before publishing it.

The additive `SessionDetail.navigationParent` field carries a nested target's
latest owning Task as capped display context. It does not widen the physical
page or change its cursors. Existing uncapped and ordinary reads omit it. The
renderer reveals the Task and locates the answer in the existing details dock;
missing parent context is an explicit navigation failure.

Parser-owned source offsets map hidden Markdown syntax and destinations to
visible elements. User text and file chips preserve equivalent source offsets.
Literal rendered matches use CSS ranges; source-only matches highlight their
owning element. The shared browser focus effect releases bottom following and
bounds layout correction by a deadline or the first reading gesture.

## Consequences

This removes the global target transfer, pane-local navigation controller, and
separate ordinary-history load lock. Live/model cache ownership, transcript
storage, IPC allowlisting, and protocol version remain unchanged. The optional
parent projection is backward compatible for existing session readers.

Navigation does not load an entire transcript into the renderer. Stable-ID and
parent lookup still scan canonical physical identities; this decision does not
introduce a new search or message-offset index. Complete selected message text
can still be large, by design. Source-only matches identify the visible owner
rather than reproducing hidden Markdown as extra UI copy.

## Validation

Renderer state tests cover competing reads, streaming during ordinary paging,
new turns, pane eviction, same-ID rewrites, canonical action preparation,
forward paging without a physical end or with a page that cannot advance,
forward-page failure and retry, a range restored during a running turn, and
the window an uncapped abort publishes.
Server rendering tests exercise nested answers, collapsed Task disclosure,
Markdown destinations and delimiters, file chips, long messages, and CRLF source
offsets. Browser-effect unit tests cover geometry, gesture interruption, and
StrictMode-style cleanup/replay. Host tests cover bounded physical pages and
latest parent context outside the page. The interaction contract is
`E2E-SESSION-content-search-and-message-navigation`; the isolated
React/Electron fixture `node scripts/e2e-transcript-reading-position.mjs` also
drives the production pane through automatic forward paging to the newest
message. These checks are not a native-app E2E run.
